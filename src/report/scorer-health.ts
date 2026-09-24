/**
 * Eval bands and scorer health — deterministic, offline statements about the
 * instrument, derived from the same pairs and attempts as the report.
 *
 * A band says whether an eval separates the arms at all; scorer health lists
 * checks that failed in every scored attempt of an eval under every arm while
 * another graded check in those same attempts passed. Names never enter the
 * generated summary sentence (the language guard cannot vet data the harness
 * does not control); they travel in the structured `suspects` array.
 */
import type { AttemptRecord } from "../store/db.ts";
import type { ReportPair } from "./report.ts";

export type EvalBand = "discriminating" | "solved-by-all" | "failed-by-all";

export interface ScorerHealthSuspect {
  eval_id: string;
  check: string;
  /** Experiments whose scored attempts all failed this check. */
  experiments: string[];
  /** Scored attempts of the eval (across those experiments) — every one failed this check. */
  attempts: number;
  /** Graded checks that passed in every one of those attempts (the evidence the work was done). */
  passing_checks: string[];
}

export interface ScorerHealth {
  suspects: ScorerHealthSuspect[];
  /** Fixed template, names never interpolated — must pass findBannedLanguage. */
  summary: string;
}

/** Per eval: over pairs with scored > 0. null when fewer than 2 arms scored. */
export function collectBands(pairs: ReportPair[]): Map<string, EvalBand | null> {
  const byEval = new Map<string, ReportPair[]>();
  for (const pair of pairs) {
    const list = byEval.get(pair.eval_id) ?? [];
    list.push(pair);
    byEval.set(pair.eval_id, list);
  }
  const bands = new Map<string, EvalBand | null>();
  for (const [evalId, evalPairs] of byEval) {
    const scored = evalPairs.filter((pair) => pair.scored > 0);
    if (scored.length < 2) bands.set(evalId, null);
    else if (scored.every((pair) => pair.pass_rate === 1)) bands.set(evalId, "solved-by-all");
    else if (scored.every((pair) => pair.pass_rate === 0)) bands.set(evalId, "failed-by-all");
    else bands.set(evalId, "discriminating");
  }
  return bands;
}

const plural = (count: number): string => (count === 1 ? "" : "s");

export function scorerHealthSummary(suspects: ScorerHealthSuspect[]): string {
  if (suspects.length === 0) return "No check failed under every arm while another check passed.";
  const evals = new Set(suspects.map((suspect) => suspect.eval_id)).size;
  return (
    `${suspects.length} check${plural(suspects.length)} failed in every scored attempt of ${evals} eval${plural(evals)} ` +
    `under every arm while another check passed in those attempts. Treat those evals' pass rates as unverified ` +
    `until the scorer is reviewed.`
  );
}

/**
 * Suspects come only from `failed-by-all` evals (≥2 scored arms). A check is a
 * suspect when it is present and failing in every scored (completed) attempt
 * of those arms, and at least one other graded check is present and passing
 * in every one of them. A name flagged `graded: false` in any attempt (the
 * pair tally's rule) is excluded from both sides.
 */
export function collectScorerHealth(attempts: AttemptRecord[], pairs: ReportPair[]): ScorerHealth {
  const bands = collectBands(pairs);
  const suspects: ScorerHealthSuspect[] = [];
  for (const [evalId, band] of bands) {
    if (band !== "failed-by-all") continue;
    const arms = pairs.filter((pair) => pair.eval_id === evalId && pair.scored > 0);
    const experiments = arms.map((pair) => pair.experiment_id).sort((a, b) => a.localeCompare(b));
    const ungraded = new Set(arms.flatMap((pair) => pair.checks.filter((check) => check.graded === false).map((check) => check.name)));
    const scored = attempts.filter(
      (attempt) => attempt.evalId === evalId && attempt.status === "completed" && experiments.includes(attempt.experimentId),
    );
    if (scored.length === 0) continue;
    const names = new Set<string>();
    for (const attempt of scored) {
      for (const check of attempt.result?.checks ?? []) {
        if (check.graded === false) ungraded.add(check.name);
        names.add(check.name);
      }
    }
    const outcomeEverywhere = (name: string, passed: boolean): boolean =>
      scored.every((attempt) => (attempt.result?.checks ?? []).some((check) => check.name === name && check.passed === passed));
    const graded = [...names].filter((name) => !ungraded.has(name)).sort((a, b) => a.localeCompare(b));
    const failing = graded.filter((name) => outcomeEverywhere(name, false));
    const passing = graded.filter((name) => outcomeEverywhere(name, true));
    if (passing.length === 0) continue;
    for (const check of failing) {
      suspects.push({ eval_id: evalId, check, experiments: [...experiments], attempts: scored.length, passing_checks: [...passing] });
    }
  }
  suspects.sort(
    (a, b) => b.attempts - a.attempts || a.eval_id.localeCompare(b.eval_id) || a.check.localeCompare(b.check),
  );
  return { suspects, summary: scorerHealthSummary(suspects) };
}
