/**
 * Report view: renders report.json — the exact artifact `quickstudy report`
 * wrote (embedded verbatim by the export). Summary counts, per-pair pass
 * rates with named checks, comparison-group sections (raw counts or the
 * withheld diff), offered-versus-used surface telemetry, and egress denials.
 * No attribution, no recommendations, no intervals — raw counts are the
 * honest statement at these trial counts.
 */

import type { ReactNode } from "react";
import type { DataMeta } from "../../../src/export-types.ts";
import type { ReportGroup, ReportJson, ReportPair } from "../../../src/report/report.ts";
import { ErrorPanel } from "../components/ErrorPanel.tsx";
import { StatBadge } from "../components/StatBadge.tsx";
import { ExperimentUsageSummary } from "../components/SurfaceUsage.tsx";
import { loadReport } from "../data.ts";
import { useAsync } from "../hooks.ts";
import { links, navigate } from "../router.ts";

interface ReportProps {
  meta: DataMeta;
  runId: string;
}

function pct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function ChecksCell({ pair }: { pair: ReportPair }): ReactNode {
  if (pair.checks.length === 0) return <span className="attribution-reason">no named checks recorded</span>;
  return (
    <div className="attribution-effects">
      {pair.checks.map((check) => (
        <span key={check.name} className={check.passed === check.total ? "crit pass" : "crit fail"} title={check.name}>
          {check.passed === check.total ? "✓" : "✗"} {check.name} ({check.passed}/{check.total})
        </span>
      ))}
    </div>
  );
}

function GroupSection({ group }: { group: ReportGroup }): ReactNode {
  if (group.comparison === "withheld") {
    return (
      <div className="card" data-testid={`report-group-${group.group}`}>
        <div className="head">
          <h3>{group.group}</h3>
          <StatBadge tone="amber">comparison withheld</StatBadge>
        </div>
        <div className="body">
          <p className="viewer-note">
            Members differ beyond their declared treatment — the differing components:
          </p>
          <ul>
            {group.details.map((detail) => (
              <li key={detail}>
                <code>{detail}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  const evalIds = [...new Set(group.arms.flatMap((arm) => arm.evals.map((entry) => entry.eval_id)))].sort();
  return (
    <div className="card" data-testid={`report-group-${group.group}`}>
      <div className="head">
        <h3>{group.group}</h3>
        <StatBadge tone="green">compared — raw counts</StatBadge>
      </div>
      <div className="body">
        <table className="data">
          <thead>
            <tr>
              <th>eval</th>
              {group.arms.map((arm) => (
                <th key={arm.experiment_id}>
                  <code>{arm.experiment_id}</code>
                  {arm.treatment !== null && <div className="attribution-reason">{arm.treatment}</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {evalIds.map((evalId) => (
              <tr key={evalId}>
                <td>
                  <code>{evalId}</code>
                </td>
                {group.arms.map((arm) => {
                  const entry = arm.evals.find((candidate) => candidate.eval_id === evalId);
                  return <td key={arm.experiment_id}>{entry === undefined ? "—" : entry.display}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Report({ meta, runId }: ReportProps): ReactNode {
  const report = useAsync(() => loadReport(runId), [runId]);

  if (report.status === "error") return <ErrorPanel error={report.error} />;
  if (report.status === "loading") return <div className="loading">Loading report…</div>;
  const value: ReportJson = report.value;
  const scored = value.totals.passed + value.totals.failed;

  return (
    <div data-testid="report-view">
      <div className="page-head">
        <div>
          <h1>Run report</h1>
          <p className="sub">
            {value.run.eval_ids.length} evals × {value.run.experiment_ids.length} experiments · {value.run.trials}{" "}
            trials/pair · started {value.run.started_at.slice(0, 10)}
          </p>
        </div>
        <div className="control">
          <label htmlFor="report-run">Run</label>
          <select
            id="report-run"
            data-testid="report-run-select"
            value={runId}
            onChange={(event) => navigate(links.report(event.currentTarget.value))}
          >
            {meta.runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.id.slice(0, 10)}… · {run.started_at.slice(0, 10)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {value.incomplete && (
        <div className="notice" data-testid="incomplete-banner">
          ⚠️ INCOMPLETE RUN — this run never finished. Numbers below are partial and NOT comparable to a full sweep.
        </div>
      )}

      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Attempts</div>
          <div className="kpi-val">{value.totals.attempts}</div>
          <div className="kpi-meta">
            <StatBadge tone="green">{value.totals.passed} passed</StatBadge>{" "}
            <StatBadge tone="red">{value.totals.failed} failed</StatBadge>{" "}
            <StatBadge tone="gray">{value.totals.incomplete} incomplete</StatBadge>{" "}
            <StatBadge tone="amber">{value.totals.errors} errored</StatBadge>
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Overall pass rate</div>
          <div className="kpi-val">{scored === 0 ? "—" : `${Math.round((value.totals.passed / scored) * 100)}%`}</div>
          <div className="kpi-meta">{scored} scored attempt(s)</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Cost</div>
          <div className="kpi-val">{value.telemetry.cost_usd === null ? "—" : `$${value.telemetry.cost_usd.toFixed(2)}`}</div>
          <div className="kpi-meta">
            {value.telemetry.cost_usd === null ? "unavailable" : `across ${value.telemetry.cost_attempts} attempt(s)`}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Tokens</div>
          <div className="kpi-val" style={{ fontSize: 15 }}>
            {value.telemetry.tokens_in === null && value.telemetry.tokens_out === null
              ? "unavailable"
              : `${value.telemetry.tokens_in ?? 0} in / ${value.telemetry.tokens_out ?? 0} out`}
          </div>
          <div className="kpi-meta">from {value.telemetry.token_attempts} attempt(s)</div>
        </div>
      </div>

      <div className="card">
        <div className="head">
          <h3>Pass rates per eval × experiment</h3>
          <span className="kpi-meta">scored = passed + failed; incomplete and errored attempts never enter the denominator</span>
        </div>
        <div className="body">
          <table className="data" data-testid="pairs-table">
            <thead>
              <tr>
                <th>eval</th>
                <th>experiment</th>
                <th>pass rate</th>
                <th>raw</th>
                <th>notes</th>
                <th>checks</th>
              </tr>
            </thead>
            <tbody>
              {value.pairs.map((pair) => (
                <tr key={`${pair.eval_id}|${pair.experiment_id}`}>
                  <td>
                    <code>{pair.eval_id}</code>
                    {pair.suite !== "benchmark" && <div className="attribution-reason">{pair.suite}</div>}
                  </td>
                  <td>
                    <code>{pair.experiment_id}</code>
                  </td>
                  <td>
                    <strong>{pct(pair.pass_rate)}</strong>
                  </td>
                  <td>
                    {pair.passed}/{pair.scored}
                  </td>
                  <td>
                    {[
                      pair.incomplete > 0 ? `${pair.incomplete} incomplete` : "",
                      pair.errors > 0 ? `${pair.errors} errored` : "",
                      pair.flaky ? "trials disagreed" : "",
                    ]
                      .filter(Boolean)
                      .join("; ") || "—"}
                  </td>
                  <td>
                    <ChecksCell pair={pair} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {value.groups.length > 0 && (
        <section data-testid="report-groups">
          <h2>Comparison groups</h2>
          {value.groups.map((group) => (
            <GroupSection key={group.group} group={group} />
          ))}
        </section>
      )}

      {value.usage.length > 0 && (
        <div className="card">
          <div className="head">
            <h3>Surface usage (offered vs observed)</h3>
            <span className="kpi-meta">null telemetry counts as unavailable, never as zero use</span>
          </div>
          <div className="body" data-testid="usage-summary">
            {value.usage.map((usage) => (
              <div key={usage.experiment_id} className="attribution-arm">
                <div className="attribution-arm-head">
                  <strong>
                    <code>{usage.experiment_id}</code>
                  </strong>
                  {usage.treatment !== null && <StatBadge tone="blue">offered: {usage.treatment}</StatBadge>}
                </div>
                <ExperimentUsageSummary usage={usage} />
              </div>
            ))}
          </div>
        </div>
      )}

      {value.egress_denials.length > 0 && (
        <div className="card">
          <div className="head">
            <h3>Egress denials (proxied run)</h3>
          </div>
          <div className="body">
            <table className="data">
              <thead>
                <tr>
                  <th>attempt</th>
                  <th>eval</th>
                  <th>experiment</th>
                  <th>denials</th>
                  <th>top hosts</th>
                </tr>
              </thead>
              <tbody>
                {value.egress_denials.map((entry) => (
                  <tr key={entry.attempt_id}>
                    <td>
                      <code>{entry.attempt_id.slice(0, 8)}…</code>
                    </td>
                    <td>{entry.eval_id}</td>
                    <td>{entry.experiment_id}</td>
                    <td>{entry.count}</td>
                    <td>{entry.top_hosts.map(({ host, count }) => `${host} (${count})`).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="methodology" data-testid="methodology">
        <strong>Methodology</strong>: {value.methodology}
      </div>
    </div>
  );
}
