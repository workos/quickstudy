/**
 * `validate --oracle`: score each eval's reference solution (`solution/`
 * overlaid on `local/`) on the host, with no agent and no runtime.
 *
 * `exec`, `query` and `getClient` are runtime-only here: each records that it
 * was called and throws {@link RuntimeCapabilityError}. Tracking is by
 * invocation on the parent side of the scorer worker (the worker RPCs every
 * capability call back to this context), so a scorer that swallows the error
 * is still reported as deferred. Evals that defer are proven by running an
 * oracle experiment under the real runtime, which costs no model spend.
 */

import { rm } from "node:fs/promises";
import { DEFAULT_BUDGETS } from "../execution-policy.ts";
import { validEvalResult } from "../evals/result.ts";
import type { EvalExecResult, LoadedEval } from "../evals/types.ts";
import { buildEvalContext, RuntimeCapabilityError } from "./context.ts";
import { deadline, StageTimeoutError } from "./deadline.ts";
import { scoreInWorker } from "./score-worker.ts";
import { prepWorkspaceSource } from "./workspace-source.ts";

export type OracleOutcome =
  | { kind: "pass"; ungradedFailures: string[] }
  | { kind: "deferred"; capabilities: string[] }
  | { kind: "failed"; failingChecks: string[]; error?: string }
  | { kind: "missing" };

export interface ValidateOracleOptions {
  /** Scoring deadline; defaults to the runner's scoring budget. */
  timeoutMs?: number;
}

const EXPERIMENT_ID = "validate-oracle";

/** Score one eval's reference solution; see the module doc for the outcomes. */
export async function validateOracle(loaded: LoadedEval, opts: ValidateOracleOptions = {}): Promise<OracleOutcome> {
  if (loaded.solutionDir === null) return { kind: "missing" };

  const used = new Set<"exec" | "query" | "getClient">();
  const runtimeOnly = (capability: "exec" | "query" | "getClient"): never => {
    used.add(capability);
    throw new RuntimeCapabilityError(
      capability,
      `${capability}() is runtime-only under validate --oracle — run the oracle experiment under the real runtime`,
    );
  };

  const workspaceDir = await prepWorkspaceSource(loaded, "solution");
  try {
    let result;
    try {
      result = await deadline("scoring", opts.timeoutMs ?? DEFAULT_BUDGETS.scoreMs, (signal) =>
        scoreInWorker(
          loaded.scorerPath,
          buildEvalContext({
            signal,
            evalId: loaded.metadata.id,
            experimentId: EXPERIMENT_ID,
            trialIndex: 0,
            ...(loaded.metadata.framework !== undefined ? { framework: loaded.metadata.framework } : {}),
            workspaceDir,
            exec: async (): Promise<EvalExecResult> => runtimeOnly("exec"),
            query: async () => runtimeOnly("query"),
            getClient: () => runtimeOnly("getClient"),
          }),
          signal,
        ),
      );
      if (!validEvalResult(result)) throw new Error("scorer returned an invalid EvalResult");
    } catch (err) {
      // A scorer that runs past its deadline failed, whatever it touched first.
      if (used.size > 0 && !(err instanceof StageTimeoutError)) return { kind: "deferred", capabilities: [...used].sort() };
      return { kind: "failed", failingChecks: [], error: err instanceof Error ? err.message : String(err) };
    }

    // A scorer that reached for a runtime-only capability has not been proven
    // here, even when it swallowed the error and returned passing checks.
    if (used.size > 0) return { kind: "deferred", capabilities: [...used].sort() };
    const graded = result.checks.filter((check) => check.graded !== false);
    const failingGraded = graded.filter((check) => !check.passed).map((check) => check.name);
    if (result.passed && failingGraded.length === 0) {
      const ungradedFailures = result.checks.filter((check) => check.graded === false && !check.passed).map((check) => check.name);
      return { kind: "pass", ungradedFailures };
    }
    return failingGraded.length > 0
      ? { kind: "failed", failingChecks: failingGraded }
      : { kind: "failed", failingChecks: [], error: "scorer returned passed: false" };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

/** One `validate --oracle` output line for an eval (without the leading bullet). */
export function formatOracleOutcome(evalId: string, outcome: OracleOutcome): string {
  switch (outcome.kind) {
    case "pass":
      return outcome.ungradedFailures.length > 0
        ? `${evalId}: 1.0 (ungraded checks failing: ${outcome.ungradedFailures.join(", ")})`
        : `${evalId}: 1.0`;
    case "deferred":
      return `${evalId}: deferred (scorer needs ${outcome.capabilities.join(", ")} — run the oracle experiment under the real runtime)`;
    case "failed": {
      const detail = outcome.failingChecks.length > 0 ? outcome.failingChecks.join(", ") : outcome.error ?? "scorer failed";
      return `${evalId}: FAILED (${detail})`;
    }
    case "missing":
      return `${evalId}: MISSING (no solution/)`;
  }
}
