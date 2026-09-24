/**
 * Per-experiment leaderboard: one row per experiment from the report's
 * `experiments[].aggregate` (benchmark suite only), sorted by pass rate on
 * discriminating evals. Reports written before the aggregate existed get a
 * one-line "regenerate" note instead of a partial table.
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
  return (
    <div className="card" data-testid="leaderboard">
      <div className="head">
        <h3>Which experiment is best?</h3>
        <span className="muted">sorted by pass rate on discriminating evals</span>
      </div>
      <div className="body">
        <table className="data">
          <thead>
            <tr>
              <th>Experiment</th>
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
