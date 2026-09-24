/**
 * Diagnosis view: renders diagnosis.json — model-drafted hypotheses for one
 * run's failing pairs, embedded verbatim by the export when the artifact
 * exists. This view is the inverse of the Report view's "no attribution"
 * posture: it is exactly attributions, and says so — the artifact's own
 * disclaimer and provenance (model, prompt version, generated_at, run id)
 * render prominently above the findings.
 *
 * Findings cluster by (eval, failing graded checks) — the check names come
 * from the run's report.json, joined on (eval_id, experiment_id) — largest
 * cluster first, then group by the generic target taxonomy inside each
 * cluster (eval-defect leads when it is a quarter or more of all findings).
 * Without a readable report, clusters fall back to one per eval. Every
 * evidence link is a
 * harness-selected excerpt window deep-linking into the line-anchored
 * transcript/diff viewer. No diagnosis is a legitimate state (the artifact
 * is key-gated and never built at export time), so the empty state names the
 * command that produces one.
 */

import { useState, type ReactNode } from "react";
import { DIAGNOSIS_SCHEMA_VERSION, type DiagnosisEvidence, type DiagnosisFinding, type DiagnosisJson } from "../../../src/diagnose/types.ts";
import type { DataMeta } from "../../../src/export-types.ts";
import type { ReportPair } from "../../../src/report/report.ts";
import { CopyButton } from "../components/CopyButton.tsx";
import { ErrorPanel } from "../components/ErrorPanel.tsx";
import { StatBadge, type BadgeTone } from "../components/StatBadge.tsx";
import { loadDiagnosis, loadReport } from "../data.ts";
import { clusterFindings, targetOrder, type FindingCluster } from "../diagnosis-clusters.ts";
import { diagnosisMarkdown, findingMarkdown } from "../diagnosis-markdown.ts";
import { useAsync } from "../hooks.ts";
import { links, navigate } from "../router.ts";

interface DiagnosisProps {
  meta: DataMeta;
  runId: string;
}

/** Rule-derived ordinal tiers — badges, never percentages or probabilities. */
function confidenceTone(confidence: DiagnosisFinding["confidence"]): BadgeTone {
  if (confidence === "high") return "green";
  if (confidence === "medium") return "amber";
  return "gray";
}

function evidenceHref(runId: string, evidence: DiagnosisEvidence): string {
  return links.attempt(runId, evidence.attempt_id, evidence.artifact, evidence.lines);
}

/** Absolute evidence URL for copied Markdown, so a pasted link opens the hosted bundle. */
function evidenceUrl(runId: string): (evidence: DiagnosisEvidence) => string {
  return (evidence) => new URL(evidenceHref(runId, evidence), window.location.href).href;
}

function EvidenceLink({ runId, evidence }: { runId: string; evidence: DiagnosisEvidence }): ReactNode {
  return (
    <a className="evidence-chip" data-testid="evidence-link" href={evidenceHref(runId, evidence)}>
      {evidence.artifact} L{evidence.lines[0]}–{evidence.lines[1]}
    </a>
  );
}

function FindingCard({ runId, finding }: { runId: string; finding: DiagnosisFinding }): ReactNode {
  return (
    <div className="card" data-testid="diagnosis-finding">
      <div className="head">
        <h3>{finding.claim}</h3>
        <span className="head-actions">
          <StatBadge tone={confidenceTone(finding.confidence)}>{finding.confidence} confidence</StatBadge>
          <CopyButton testId="copy-finding" text={() => findingMarkdown(finding, evidenceUrl(runId))} />
        </span>
      </div>
      <div className="body">
        <div className="attribution-reason">
          <code>{finding.eval_id}</code> × <code>{finding.experiment_id}</code>
        </div>
        <p>{finding.suggested_change}</p>
        <div className="evidence-row">
          {finding.evidence.map((evidence, index) => (
            <EvidenceLink
              key={`${evidence.attempt_id}-${evidence.artifact}-${index}`}
              runId={runId}
              evidence={evidence}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

function clusterHeading(cluster: FindingCluster): string {
  const findings = plural(cluster.findings.length, "finding");
  if (cluster.failingChecks.length === 0) return `${cluster.evalId} · ${findings}`;
  return `${cluster.evalId} · ${cluster.failingChecks.join(", ")} failed under ${plural(cluster.experiments.length, "arm")} · ${findings}`;
}

function DiagnosisBody({
  runId,
  diagnosis,
  pairs,
}: {
  runId: string;
  diagnosis: DiagnosisJson;
  pairs: ReportPair[] | null;
}): ReactNode {
  // null = every target. A 179-finding page is unreadable as one wall; the per-target
  // counts are the summary and the filter at once.
  const [target, setTarget] = useState<string | null>(null);
  if (diagnosis.schema_version !== DIAGNOSIS_SCHEMA_VERSION) {
    // Artifact-level version check, view-local by design: DataError's
    // "schema" kind belongs to the data directory (meta.json); this banner
    // mirrors its posture without rendering unknown-shaped findings.
    return (
      <div className="error-banner" data-testid="diagnosis-schema-banner" role="alert">
        <strong>Diagnosis schema mismatch.</strong> This diagnosis.json is schema_version{" "}
        {String(diagnosis.schema_version)} but this UI build expects {DIAGNOSIS_SCHEMA_VERSION} — regenerate it with the
        matching quickstudy version (<code>quickstudy diagnose {runId}</code>).
      </div>
    );
  }

  // Per-target counts drive the filter; clusters render target sub-sections.
  const byTarget = new Map<string, DiagnosisFinding[]>();
  for (const finding of diagnosis.findings) {
    const bucket = byTarget.get(finding.target);
    if (bucket) bucket.push(finding);
    else byTarget.set(finding.target, [finding]);
  }
  const order = targetOrder(diagnosis.findings);
  const clusters = clusterFindings(diagnosis.findings, pairs);

  return (
    <>
      <div className="notice" data-testid="diagnosis-disclaimer">
        {diagnosis.disclaimer}
      </div>

      <div className="kpi-row" data-testid="diagnosis-provenance">
        <div className="kpi">
          <div className="kpi-label">Model</div>
          <div className="kpi-val" style={{ fontSize: 15 }}>
            {diagnosis.model.requested}
          </div>
          <div className="kpi-meta">resolved: {diagnosis.model.resolved ?? "unavailable"}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Pairs diagnosed</div>
          <div className="kpi-val">{diagnosis.pairs_diagnosed}</div>
          <div className="kpi-meta">{diagnosis.pairs_skipped} skipped</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Findings</div>
          <div className="kpi-val">{diagnosis.findings.length}</div>
          <div className="kpi-meta">
            {diagnosis.errors.length > 0 ? `${diagnosis.errors.length} pair(s) not analyzed` : "all selected pairs analyzed"}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Provenance</div>
          <div className="kpi-val" style={{ fontSize: 15 }}>
            {diagnosis.generated_at.slice(0, 10)}
          </div>
          <div className="kpi-meta">
            run <code>{diagnosis.run_id.slice(0, 10)}…</code> · prompt v{diagnosis.prompt_version}
          </div>
        </div>
      </div>

      {diagnosis.findings.length === 0 && (
        <div className="empty-state" data-testid="diagnosis-no-findings">
          <h2>Diagnosis ran; no findings.</h2>
          <p>The analyst drafted no hypotheses for this run's diagnosable pairs.</p>
        </div>
      )}

      {diagnosis.findings.length > 0 && (
        <div className="toolbar" style={{ justifyContent: "flex-start" }}>
          <div className="seg" role="group" aria-label="Finding target" data-testid="diagnosis-target-filter">
            <button type="button" className={target === null ? "active" : ""} aria-pressed={target === null} onClick={() => setTarget(null)}>
              all ({diagnosis.findings.length})
            </button>
            {order.filter((candidate) => byTarget.has(candidate)).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={target === candidate ? "active" : ""}
                aria-pressed={target === candidate}
                onClick={() => setTarget(candidate)}
              >
                {candidate} ({byTarget.get(candidate)?.length})
              </button>
            ))}
          </div>
        </div>
      )}

      {clusters.map((cluster) => {
        // The target filter narrows within clusters; a cluster with nothing left hides.
        const targets = order.filter(
          (candidate) =>
            (target === null || target === candidate) && cluster.findings.some((finding) => finding.target === candidate),
        );
        if (targets.length === 0) return null;
        return (
          <section
            key={`${cluster.evalId}|${cluster.failingChecks.join(",")}`}
            className="cluster"
            data-testid="diagnosis-cluster"
          >
            <h2>{clusterHeading(cluster)}</h2>
            {targets.map((candidate) => (
              <section key={candidate} data-testid={`diagnosis-target-${candidate}`}>
                <h3>
                  <code>{candidate}</code> findings
                </h3>
                {cluster.findings
                  .filter((finding) => finding.target === candidate)
                  .map((finding, index) => (
                    <FindingCard
                      key={`${finding.eval_id}|${finding.experiment_id}|${index}`}
                      runId={runId}
                      finding={finding}
                    />
                  ))}
              </section>
            ))}
          </section>
        );
      })}

      {diagnosis.errors.length > 0 && (
        <div className="card" data-testid="diagnosis-errors">
          <div className="head">
            <h3>Pairs that could not be analyzed</h3>
            <span className="kpi-meta">model failures are recorded, never silently dropped</span>
          </div>
          <div className="body">
            <table className="data">
              <thead>
                <tr>
                  <th>eval</th>
                  <th>experiment</th>
                  <th>error</th>
                </tr>
              </thead>
              <tbody>
                {diagnosis.errors.map((entry) => (
                  <tr key={`${entry.eval_id}|${entry.experiment_id}`}>
                    <td>
                      <code>{entry.eval_id}</code>
                    </td>
                    <td>
                      <code>{entry.experiment_id}</code>
                    </td>
                    <td>{entry.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

export function Diagnosis({ meta, runId }: DiagnosisProps): ReactNode {
  const state = useAsync(() => loadDiagnosis(runId), [runId]);
  // The report only supplies check names for clustering: any load failure
  // (missing, invalid, offline) degrades to per-eval clusters, never an error.
  const report = useAsync(
    () =>
      loadReport(runId).then(
        (value): ReportPair[] | null => value.pairs ?? null,
        () => null,
      ),
    [runId],
  );

  if (state.status === "error") return <ErrorPanel error={state.error} />;
  if (state.status === "loading" || report.status === "loading") return <div className="loading">Loading diagnosis…</div>;
  const pairs = report.status === "ready" ? report.value : null;
  const diagnosis = state.value;

  return (
    <div data-testid="diagnosis-view">
      <div className="page-head">
        <div>
          <h1>Run diagnosis</h1>
          <p className="sub">Model-drafted hypotheses with harness-selected evidence — verify cited lines before acting.</p>
        </div>
        <div className="control">
          <label htmlFor="diagnosis-run">Run</label>
          <select
            id="diagnosis-run"
            data-testid="diagnosis-run-select"
            value={runId}
            onChange={(event) => navigate(links.diagnosis(event.currentTarget.value))}
          >
            {meta.runs.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id.slice(0, 10)}… · {entry.started_at.slice(0, 10)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {diagnosis !== null && diagnosis.schema_version === DIAGNOSIS_SCHEMA_VERSION && (
        <div className="toolbar" data-testid="diagnosis-toolbar">
          <CopyButton
            testId="copy-diagnosis"
            label="Copy all findings as Markdown"
            text={() => diagnosisMarkdown(diagnosis, evidenceUrl(runId))}
          />
        </div>
      )}

      {diagnosis === null ? (
        <div className="empty-state" data-testid="diagnosis-empty">
          <h2>No diagnosis for this run</h2>
          <p>Generate one (requires a model API key — never done at export time), then re-export:</p>
          <pre>
            <code>quickstudy diagnose {runId}</code>
          </pre>
        </div>
      ) : (
        <DiagnosisBody runId={runId} diagnosis={diagnosis} pairs={pairs} />
      )}
    </div>
  );
}
