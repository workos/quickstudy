/**
 * Per-experiment leaderboard aggregate — one row per experiment, derived from
 * the same attempts and (banded) pairs as the rest of the report.
 *
 * Every number is restricted to headline-suite attempts (HEADLINE_SUITES:
 * benchmark and regression), so the smoke, discovery and other suites never
 * move the headline row. Telemetry follows the report's rule: sums and means cover
 * only attempts that reported a value, and are null (never 0) when none did.
 */
import { isHeadlineSuite } from "../evals/types.ts";
import type { AttemptRecord } from "../store/db.ts";
import type { RunCostEstimate } from "./costs.ts";
import type { ReportExperiment, ReportPair } from "./report.ts";

/**
 * The pass-rate gate: an experiment whose headline pass rate is below this
 * is listed after every experiment that clears it, whatever its cost or
 * time. Pass rate is a gate, not a rank — the leaderboard orders the arms
 * that clear it by time-to-pass, then cost-to-pass.
 */
export const DEFAULT_PASS_GATE = 0.8;

export interface ExperimentAggregate {
  /** Headline-suite attempts of this experiment (every status). */
  attempts: number;
  completed: number;
  passed: number;
  failed: number;
  incomplete: number;
  errors: number;
  /** Attempts whose agent phase hit the timeout limit (graded timeouts are also completed). */
  timeouts: number;
  /** passed / (passed + failed) over headline-suite pairs; null when nothing scored. */
  pass_rate_all: number | null;
  /** Same, restricted to evals whose band is "discriminating". */
  pass_rate_discriminating: number | null;
  /** Discriminating headline evals where this experiment scored at least one attempt. */
  discriminating_evals: number;
  /** Numerator and denominator of pass_rate_discriminating. */
  discriminating_passed: number;
  discriminating_scored: number;
  /** Median of (agent_finished_at - agent_started_at) over scored attempts with both stamps; null when none. */
  median_agent_ms: number | null;
  agent_time_attempts: number;
  /** Each mean divides by the attempts that reported that value. */
  mean_tokens_in: number | null;
  mean_tokens_out: number | null;
  token_attempts: number;
  /** Provider-reported, summed over the attempts that reported it. */
  cost_usd: number | null;
  cost_attempts: number;
  /**
   * Cost-to-pass: reported cost summed over the attempts that reported it,
   * divided by the passes among those same attempts — what one success cost,
   * failures included. null when nothing reported cost or none of it passed.
   */
  cost_per_pass_usd: number | null;
  /**
   * Time-to-pass: agent time summed over the scored attempts that recorded
   * both stamps, divided by the passes among them. null when none did, or
   * none of them passed.
   */
  agent_ms_per_pass: number | null;
  /** pass_rate_all >= the report's pass gate; null when nothing scored. */
  clears_gate: boolean | null;
  /** Present only when the report was built with --pricing. */
  estimated_cost_usd?: number | null;
  estimated_attempts?: number;
  /** --pricing's estimate over the estimated attempts, divided by their passes. */
  estimated_cost_per_pass_usd?: number | null;
}

const sum = (values: number[]): number => values.reduce((total, v) => total + v, 0);
const mean = (values: number[]): number | null => (values.length > 0 ? sum(values) / values.length : null);

/** Median; an even count takes the mean of the two middle values. null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Aggregate one experiment. `pairs` must already carry their bands (the way
 * `buildReport` assigns them); `costEstimate` is the report's --pricing layer,
 * whose per-attempt entries are keyed by attempt id only.
 */
export function collectExperimentAggregate(
  attempts: AttemptRecord[],
  pairs: ReportPair[],
  experimentId: string,
  costEstimate?: RunCostEstimate,
  passGate: number = DEFAULT_PASS_GATE,
): ExperimentAggregate {
  const mine = attempts.filter((a) => a.experimentId === experimentId && isHeadlineSuite(a.suite));
  const completed = mine.filter((a) => a.status === "completed");
  const passed = completed.filter((a) => a.result?.passed).length;

  const headlinePairs = pairs.filter((p) => p.experiment_id === experimentId && isHeadlineSuite(p.suite));
  const scoredAll = sum(headlinePairs.map((p) => p.scored));
  const passedAll = sum(headlinePairs.map((p) => p.passed));
  const discriminating = headlinePairs.filter((p) => p.band === "discriminating" && p.scored > 0);
  const discScored = sum(discriminating.map((p) => p.scored));
  const discPassed = sum(discriminating.map((p) => p.passed));

  const stamped = completed.filter((a) => typeof a.agentStartedAt === "number" && typeof a.agentFinishedAt === "number");
  const durations = stamped.map((a) => (a.agentFinishedAt as number) - (a.agentStartedAt as number));
  const stampedPasses = stamped.filter((a) => a.result?.passed).length;
  const tokensIn = mine.map((a) => a.tokensIn).filter((v): v is number => v !== null && v !== undefined);
  const tokensOut = mine.map((a) => a.tokensOut).filter((v): v is number => v !== null && v !== undefined);
  const costed = mine.filter((a) => a.costUsd !== null && a.costUsd !== undefined);
  const costs = costed.map((a) => a.costUsd as number);
  const costedPasses = costed.filter((a) => a.status === "completed" && a.result?.passed).length;

  let estimated: Pick<ExperimentAggregate, "estimated_cost_usd" | "estimated_attempts" | "estimated_cost_per_pass_usd"> = {};
  if (costEstimate !== undefined) {
    const byId = new Map(mine.map((a) => [a.id, a]));
    const priced = costEstimate.attempts.filter((e) => byId.has(e.attempt_id) && e.cost_usd !== null);
    const values = priced.map((e) => e.cost_usd as number);
    const pricedPasses = priced.filter((e) => {
      const attempt = byId.get(e.attempt_id);
      return attempt?.status === "completed" && attempt.result?.passed;
    }).length;
    estimated = {
      estimated_cost_usd: values.length > 0 ? sum(values) : null,
      estimated_attempts: values.length,
      estimated_cost_per_pass_usd: values.length > 0 && pricedPasses > 0 ? sum(values) / pricedPasses : null,
    };
  }
  const passRateAll = scoredAll > 0 ? passedAll / scoredAll : null;

  return {
    attempts: mine.length,
    completed: completed.length,
    passed,
    failed: completed.length - passed,
    incomplete: mine.filter((a) => a.status === "incomplete").length,
    errors: mine.filter((a) => a.status === "error").length,
    timeouts: mine.filter((a) => a.status === "completed" && a.limitHit === "timeout").length,
    pass_rate_all: passRateAll,
    pass_rate_discriminating: discScored > 0 ? discPassed / discScored : null,
    discriminating_evals: new Set(discriminating.map((p) => p.eval_id)).size,
    discriminating_passed: discPassed,
    discriminating_scored: discScored,
    median_agent_ms: median(durations),
    agent_time_attempts: durations.length,
    mean_tokens_in: mean(tokensIn),
    mean_tokens_out: mean(tokensOut),
    token_attempts: Math.max(tokensIn.length, tokensOut.length),
    cost_usd: costs.length > 0 ? sum(costs) : null,
    cost_attempts: costs.length,
    cost_per_pass_usd: costs.length > 0 && costedPasses > 0 ? sum(costs) / costedPasses : null,
    agent_ms_per_pass: durations.length > 0 && stampedPasses > 0 ? sum(durations) / stampedPasses : null,
    clears_gate: passRateAll === null ? null : passRateAll >= passGate,
    ...estimated,
  };
}

/** Ascending with nulls (and absent values) last; equal when both are absent. */
function ascending(a: number | null | undefined, b: number | null | undefined): number {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x - y;
}

/**
 * Leaderboard order: agent arms before controls (the oracle would otherwise
 * lead every board); arms that clear the pass gate before those that do not;
 * then time-to-pass ascending (every adapter reports agent time), then
 * cost-to-pass ascending (null where the provider reports no dollars sorts
 * last); then discriminating and all-eval pass rate desc as tie-breaks; then
 * experiment id — a total order, so every consumer renders the same rows in
 * the same sequence.
 */
export function compareLeaderboard(a: ReportExperiment, b: ReportExperiment): number {
  const rate = (value: number | null | undefined): number => (value === null || value === undefined ? -1 : value);
  const control = (experiment: ReportExperiment): number => ((experiment.role ?? "agent") === "agent" ? 0 : 1);
  const gate = (experiment: ReportExperiment): number => (experiment.aggregate?.clears_gate === true ? 0 : 1);
  return (
    control(a) - control(b) ||
    gate(a) - gate(b) ||
    ascending(a.aggregate?.agent_ms_per_pass, b.aggregate?.agent_ms_per_pass) ||
    ascending(a.aggregate?.cost_per_pass_usd, b.aggregate?.cost_per_pass_usd) ||
    rate(b.aggregate?.pass_rate_discriminating) - rate(a.aggregate?.pass_rate_discriminating) ||
    rate(b.aggregate?.pass_rate_all) - rate(a.aggregate?.pass_rate_all) ||
    a.experiment_id.localeCompare(b.experiment_id)
  );
}
