/**
 * Per-experiment leaderboard: one row per experiment from the report's
 * `experiments[].aggregate` (headline suites: benchmark + regression), controls after the agent
 * experiments, arms that clear the pass gate first, then ordered by
 * time-to-pass and cost-to-pass. Reports written before the aggregate existed
 * get a one-line "regenerate" note instead of a partial table.
 */

import type { ReactNode } from "react";
import { compareLeaderboard } from "../../../src/report/aggregate.ts";
import type { ReportExperiment, ReportJson } from "../../../src/report/report.ts";
import { modelLabel } from "../agent-label.ts";
import { fmtMs, fmtTokens, fmtUsd } from "../format.ts";

interface LeaderboardProps {
  report: ReportJson;
  runId: string;
}

function PassCell({ experiment }: { experiment: ReportExperiment }): ReactNode {
  const agg = experiment.aggregate;
  if (agg === undefined || agg.pass_rate_all === null) return "—";
  const all = `${agg.passed}/${agg.passed + agg.failed}`;
  if (agg.discriminating_evals === 0) {
    return (
      <>
        {all} · <span className="muted" title="No discriminating evals scored for this experiment">—</span>
      </>
    );
  }
  return `${all} · ${agg.discriminating_passed}/${agg.discriminating_scored}`;
}

function GateCell({ experiment, gate }: { experiment: ReportExperiment; gate: number }): ReactNode {
  const agg = experiment.aggregate;
  if (agg === undefined || agg.clears_gate === null || agg.clears_gate === undefined) return "—";
  const label = `pass rate ${agg.clears_gate ? "at or above" : "below"} ${Math.round(gate * 100)}%`;
  return (
    <span className={agg.clears_gate ? "tag" : "tag muted"} data-testid="leaderboard-gate" title={label}>
      {agg.clears_gate ? "clears" : "below"}
    </span>
  );
}

function CostCell({ experiment }: { experiment: ReportExperiment }): ReactNode {
  const agg = experiment.aggregate;
  if (agg === undefined || agg.attempts === 0) return "—";
  const reported = agg.cost_attempts > 0 && agg.cost_usd !== null
    ? `${fmtUsd(agg.cost_usd / agg.cost_attempts)} · ${agg.cost_attempts}/${agg.attempts} reported`
    : `not reported (0/${agg.attempts})`;
  const estimated = typeof agg.estimated_cost_usd === "number" && agg.estimated_attempts
    ? ` · ${fmtUsd(agg.estimated_cost_usd / agg.estimated_attempts)} est.`
    : "";
  return `${reported}${estimated}`;
}

export function Leaderboard({ report, runId }: LeaderboardProps): ReactNode {
  const experiments = Array.isArray(report.experiments) ? report.experiments : [];
  if (experiments.length === 0 || experiments.some((experiment) => experiment.aggregate === undefined)) {
    return (
      <div className="notice" data-testid="leaderboard-stale">
        This report predates the leaderboard. Regenerate it with <code>quickstudy report {runId}</code>.
      </div>
    );
  }
  const rows = [...experiments].sort(compareLeaderboard);
  const gate = typeof report.pass_gate === "number" ? report.pass_gate : 0.8;
  return (
    <div className="card" data-testid="leaderboard">
      <div className="head">
        <h3>Which experiment is best?</h3>
        <span className="muted">
          headline suites (benchmark + regression) · pass rate is a gate (≥ {Math.round(gate * 100)}%), not a rank ·
          ordered by time-to-pass, then cost-to-pass; controls last
        </span>
      </div>
      <div className="body">
        <table className="data">
          <thead>
            <tr>
              <th>Experiment</th>
              <th>Gate</th>
              <th>Cost/pass</th>
              <th>Time/pass</th>
              <th>Pass rate (all · discriminating)</th>
              <th>Agent time (median)</th>
              <th>Tokens/run (in)</th>
              <th>Cost/run</th>
              <th>SDK recall</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((experiment) => {
              const agg = experiment.aggregate;
              const recall = experiment.sdk_recall;
              return (
                <tr key={experiment.experiment_id} data-testid={`leaderboard-row-${experiment.experiment_id}`}>
                  <td>
                    {modelLabel(experiment.agent)}
                    <span className="group-sub">
                      <code>{experiment.experiment_id}</code>
                      {experiment.treatment !== null ? ` · ${experiment.treatment}` : ""}
                    </span>
                    {(experiment.role ?? "agent") !== "agent" && (
                      <span
                        className="tag"
                        data-testid="leaderboard-control"
                        title="A control checks the instrument; it is not an arm and never decides a band."
                      >
                        {experiment.role === "positive-control" ? "positive control" : "negative control"}
                      </span>
                    )}
                  </td>
                  <td>
                    <GateCell experiment={experiment} gate={gate} />
                  </td>
                  <td data-testid="leaderboard-cost-per-pass" title="reported cost over the attempts that reported it, divided by their passes">
                    {agg?.cost_per_pass_usd === null || agg?.cost_per_pass_usd === undefined ? "—" : fmtUsd(agg.cost_per_pass_usd)}
                  </td>
                  <td data-testid="leaderboard-time-per-pass" title="agent time over the scored attempts that recorded it, divided by their passes">
                    {fmtMs(agg?.agent_ms_per_pass ?? null)}
                  </td>
                  <td data-testid="leaderboard-pass">
                    <PassCell experiment={experiment} />
                  </td>
                  <td title={agg ? `median over ${agg.agent_time_attempts} of ${agg.completed} scored attempt(s)` : undefined}>
                    {fmtMs(agg?.median_agent_ms ?? null)}
                  </td>
                  <td title={agg ? `mean over ${agg.token_attempts} attempt(s) that reported tokens` : undefined}>
                    {fmtTokens(agg?.mean_tokens_in ?? null)}
                  </td>
                  <td data-testid="leaderboard-cost">
                    <CostCell experiment={experiment} />
                  </td>
                  <td>{recall && recall.rate !== null ? `${recall.recalled}/${recall.attempts}` : "n/a"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
