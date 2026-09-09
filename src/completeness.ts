import { validEvalResult } from "./evals/result.ts";
import { attemptIdentityHash } from "./manifest.ts";
import type { AttemptRecord, RunRecord } from "./store/db.ts";

export interface PairCoverage {
  eval_id: string;
  experiment_id: string;
  expected_trials: number;
  complete: boolean;
  reasons: string[];
}

/** Coordinate coverage, shared by publication and resume. Failures are measurements. */
export function trialCoverage(
  run: RunRecord,
  attempts: AttemptRecord[],
  expectedTrials = run.config.trials,
): PairCoverage[] {
  if (!Number.isInteger(expectedTrials) || expectedTrials < 1)
    throw new Error("expected trials must be a positive integer");
  const pairs: PairCoverage[] = [];
  for (const evalId of run.config.evalIds) {
    for (const experimentId of run.config.experimentIds) {
      const rows = attempts.filter((a) => a.evalId === evalId && a.experimentId === experimentId);
      const reasons: string[] = [];
      if (expectedTrials !== run.config.trials)
        reasons.push(`expected ${expectedTrials} trials differs from recorded ${run.config.trials}`);
      for (let trialIndex = 0; trialIndex < expectedTrials; trialIndex++) {
        const trials = rows.filter((a) => a.trialIndex === trialIndex);
        if (trials.length === 0) reasons.push(`missing trial ${trialIndex}`);
        else if (trials.length > 1) reasons.push(`duplicate trial ${trialIndex}`);
        for (const row of trials) {
          if (row.status !== "completed") reasons.push(`trial ${trialIndex}: ${row.status}`);
          else if (!validEvalResult(row.result)) {
            reasons.push(`trial ${trialIndex}: invalid scored outcome`);
          }
          // Historical v3 manifests remain readable, but cannot attest the stronger identity.
          if (
            run.manifest.manifestVersion !== "v3" &&
            row.attemptIdentityHash !== attemptIdentityHash({ evalId, experimentId, trialIndex }, run.manifest)
          ) {
            reasons.push(`trial ${trialIndex}: identity mismatch`);
          }
        }
      }
      if (rows.some((a) => !Number.isInteger(a.trialIndex) || a.trialIndex < 0 || a.trialIndex >= expectedTrials))
        reasons.push("unexpected trial index");
      pairs.push({
        eval_id: evalId,
        experiment_id: experimentId,
        expected_trials: expectedTrials,
        complete: reasons.length === 0,
        reasons,
      });
    }
  }
  for (const row of attempts) {
    if (!run.config.evalIds.includes(row.evalId) || !run.config.experimentIds.includes(row.experimentId)) {
      pairs.push({
        eval_id: row.evalId,
        experiment_id: row.experimentId,
        expected_trials: expectedTrials,
        complete: false,
        reasons: ["unplanned pair"],
      });
    }
  }
  return pairs;
}

export interface PublicationCoverage {
  expected_trials: number;
  eligible: PairCoverage[];
  omitted: PairCoverage[];
}
/** Publish comparison arms over identical complete eval coverage. */
export function publicationCoverage(
  run: RunRecord,
  attempts: AttemptRecord[],
  expectedTrials: number,
): PublicationCoverage {
  const coverage = trialCoverage(run, attempts, expectedTrials);
  if (run.manifest.manifestVersion !== "v4")
    for (const pair of coverage) {
      pair.complete = false;
      pair.reasons.push("historical identity cannot attest v4 complete-sample publication");
    }
  for (const group of run.config.groups ?? []) {
    if (group.comparison !== "allowed") continue;
    for (const evalId of run.config.evalIds) {
      const members = coverage.filter((p) => p.eval_id === evalId && group.experimentIds.includes(p.experiment_id));
      if (members.some((p) => !p.complete))
        for (const pair of members.filter((p) => p.complete)) {
          pair.complete = false;
          pair.reasons.push(`comparison group ${group.group} lacks a complete arm for this eval`);
        }
    }
  }
  return {
    expected_trials: expectedTrials,
    eligible: coverage.filter((p) => p.complete),
    omitted: coverage.filter((p) => !p.complete),
  };
}
