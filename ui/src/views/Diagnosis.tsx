/**
 * Diagnosis view: renders diagnosis.json — model-drafted hypotheses for one
 * run's failing pairs, embedded verbatim by the export when the artifact
 * exists. This view is the inverse of the Report view's "no attribution"
 * posture: it is exactly attributions, and says so — the artifact's own
 * disclaimer and provenance (model, prompt version, generated_at, run id)
 * render prominently above the findings.
 *
 * Findings group by the generic target taxonomy; every evidence link is a
 * harness-selected excerpt window deep-linking into the line-anchored
 * transcript/diff viewer. No diagnosis is a legitimate state (the artifact
 * is key-gated and never built at export time), so the empty state names the
 * command that produces one.
 */

import type { ReactNode } from "react";
import { DIAGNOSIS_TARGETS, DIAGNOSIS_SCHEMA_VERSION, type DiagnosisEvidence, type DiagnosisFinding, type DiagnosisJson } from "../../../src/diagnose/types.ts";
import type { DataMeta } from "../../../src/export-types.ts";
import { ErrorPanel } from "../components/ErrorPanel.tsx";
import { StatBadge, type BadgeTone } from "../components/StatBadge.tsx";
import { loadDiagnosis } from "../data.ts";
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

function EvidenceLink({ runId, evidence }: { runId: string; evidence: DiagnosisEvidence }): ReactNode {
  return (
    <a
      className="evidence-chip"
      data-testid="evidence-link"
      href={links.attempt(runId, evidence.attempt_id, evidence.artifact, evidence.lines)}
    >
      {evidence.artifact} L{evidence.lines[0]}–{evidence.lines[1]}
    </a>
  );
}

function FindingCard({ runId, finding }: { runId: string; finding: DiagnosisFinding }): ReactNode {
  return (
    <div className="card" data-testid="diagnosis-finding">
      <div className="head">
        <h3>{finding.claim}</h3>
        <StatBadge tone={confidenceTone(finding.confidence)}>{finding.confidence} confidence</StatBadge>
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

function DiagnosisBody({ runId, diagnosis }: { runId: string; diagnosis: DiagnosisJson }): ReactNode {
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

  // One section per target present, document order within a target.
  const byTarget = new Map<string, DiagnosisFinding[]>();
  for (const finding of diagnosis.findings) {
    const bucket = byTarget.get(finding.target);
    if (bucket) bucket.push(finding);
    else byTarget.set(finding.target, [finding]);
  }

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

      {DIAGNOSIS_TARGETS.filter((target) => byTarget.has(target)).map((target) => (
        <section key={target} data-testid={`diagnosis-target-${target}`}>
          <h2>
            <code>{target}</code> findings
          </h2>
          {(byTarget.get(target) ?? []).map((finding, index) => (
            <FindingCard
              key={`${finding.eval_id}|${finding.experiment_id}|${index}`}
              runId={runId}
              finding={finding}
            />
          ))}
        </section>
      ))}

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

  if (state.status === "error") return <ErrorPanel error={state.error} />;
  if (state.status === "loading") return <div className="loading">Loading diagnosis…</div>;
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

      {diagnosis === null ? (
        <div className="empty-state" data-testid="diagnosis-empty">
          <h2>No diagnosis for this run</h2>
          <p>Generate one (requires a model API key — never done at export time), then re-export:</p>
          <pre>
            <code>quickstudy diagnose {runId}</code>
          </pre>
        </div>
      ) : (
        <DiagnosisBody runId={runId} diagnosis={diagnosis} />
      )}
    </div>
  );
}
