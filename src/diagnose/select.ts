/**
 * Pair selection for diagnosis: which (eval × experiment) pairs are worth
 * model spend, and which attempts feed each pair's evidence bundle.
 *
 * Pair counts and flaky/check aggregation reuse the report's `collectPairs`
 * helper so the two views cannot drift.
 */

import { collectPairs, type ReportPair } from "../report/report.ts";
import type { AttemptRecord } from "../store/db.ts";

export type AttemptClass = "passed" | "failed" | "error" | "incomplete";

/** At most this many non-passing attempts feed one pair bundle. */
export const MAX_BUNDLE_ATTEMPTS = 3;

/** Report-semantics attempt classification (see module docblock). */
export function classifyAttempt(attempt: AttemptRecord): AttemptClass {
  if (attempt.status === "incomplete") return "incomplete";
  if (attempt.status === "error") return "error";
  return attempt.result?.passed ? "passed" : "failed";
}

export type PairTallies = Pick<ReportPair, "total" | "passed" | "failed" | "errors" | "incomplete">;

/** One attempt selected into a pair's bundle. */
export interface BundleSelection {
  attempt: AttemptRecord;
  class: AttemptClass;
  /** True for the single passing attempt included as flaky-pair contrast. */
  contrast: boolean;
}

/** A pair with at least one failed/errored/incomplete attempt. */
export interface DiagnosablePair {
  evalId: string;
  experimentId: string;
  tallies: PairTallies;
  flaky: boolean;
  /** Check names that failed at least once across the pair's attempts, sorted. */
  failedChecks: string[];
  /** ≤ MAX_BUNDLE_ATTEMPTS non-passing attempts (+ 1 passing contrast when flaky). */
  bundle: BundleSelection[];
}

export interface PairSelection {
  pairs: DiagnosablePair[];
  /** Passing-only pairs — skipped, never sent to the model. */
  skipped: number;
}

/** Bundle ordering: failed first, then errors, then incomplete. */
const CLASS_ORDER: Record<Exclude<AttemptClass, "passed">, number> = {
  failed: 0,
  error: 1,
  incomplete: 2,
};

/**
 * Group attempts into pairs, classify, and select each diagnosable pair's
 * bundle. Deterministic: pairs sort by eval id then experiment id (the
 * report's order); within a class, attempts sort by ULID (id) order.
 */
export function selectDiagnosablePairs(attempts: AttemptRecord[]): PairSelection {
  const byPair = new Map<string, AttemptRecord[]>();
  for (const attempt of attempts) {
    const key = `${attempt.evalId}|${attempt.experimentId}`;
    const group = byPair.get(key);
    if (group) group.push(attempt);
    else byPair.set(key, [attempt]);
  }

  const pairs: DiagnosablePair[] = [];
  let skipped = 0;

  for (const group of byPair.values()) {
    const report = collectPairs(group)[0]!;
    if (report.failed + report.errors + report.incomplete === 0) {
      skipped += 1;
      continue;
    }

    const classified = group
      .map((attempt) => ({ attempt, class: classifyAttempt(attempt) }))
      .sort((a, b) => a.attempt.id.localeCompare(b.attempt.id));
    const nonPassing = classified
      .filter((entry): entry is { attempt: AttemptRecord; class: Exclude<AttemptClass, "passed"> } => entry.class !== "passed")
      .sort((a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class] || a.attempt.id.localeCompare(b.attempt.id));
    const bundle: BundleSelection[] = nonPassing
      .slice(0, MAX_BUNDLE_ATTEMPTS)
      .map((entry) => ({ attempt: entry.attempt, class: entry.class, contrast: false }));

    if (report.flaky) {
      const passing = classified.find((entry) => entry.class === "passed");
      if (passing) bundle.push({ attempt: passing.attempt, class: "passed", contrast: true });
    }

    pairs.push({
      evalId: report.eval_id,
      experimentId: report.experiment_id,
      tallies: report,
      flaky: report.flaky,
      failedChecks: report.checks.filter((check) => check.passed < check.total).map((check) => check.name),
      bundle,
    });
  }

  pairs.sort((a, b) => a.evalId.localeCompare(b.evalId) || a.experimentId.localeCompare(b.experimentId));
  return { pairs, skipped };
}
