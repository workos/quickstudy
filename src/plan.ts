/**
 * The v3 planner: the eval × experiment × trials cross-product, and nothing
 * else. Planning is pure and deterministic — evals sorted by id, experiments
 * by id, trials innermost. Concurrency and interleaving are the runner's
 * concern, never the plan's identity; metadata filters apply to the eval
 * list BEFORE planning and never appear in the plan.
 */

import type { LoadedEval } from "./evals/types.ts";
import type { Experiment } from "./experiments/types.ts";

/** One planned attempt. Exactly these keys — axis creep is a bug. */
export interface AttemptPlan {
  evalId: string;
  experimentId: string;
  /** 0..trials-1 */
  trialIndex: number;
}

/** Metadata filters applied to the eval list before planning. */
export interface EvalFilter {
  suites?: string[];
  frameworks?: string[];
  products?: string[];
}

/** Keep only evals matching every provided filter axis (OR within an axis). */
export function filterEvals(evals: LoadedEval[], filter: EvalFilter): LoadedEval[] {
  return evals.filter((entry) => {
    const { suite, framework, product } = entry.metadata;
    if (filter.suites && filter.suites.length > 0 && !filter.suites.includes(suite)) return false;
    if (filter.frameworks && filter.frameworks.length > 0 && (framework === undefined || !filter.frameworks.includes(framework))) return false;
    if (filter.products && filter.products.length > 0 && (product === undefined || !filter.products.includes(product))) return false;
    return true;
  });
}

/** Expand the cross-product. Zero evals or experiments is an empty plan, not an error. */
export function planRun(evals: LoadedEval[], experiments: Experiment[], trials: number): AttemptPlan[] {
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`planRun: trials must be an integer >= 1, got ${trials}`);
  }
  const evalIds = evals.map((entry) => entry.metadata.id).sort((a, b) => a.localeCompare(b));
  const experimentIds = experiments.map((entry) => entry.id).sort((a, b) => a.localeCompare(b));

  const plan: AttemptPlan[] = [];
  for (const evalId of evalIds) {
    for (const experimentId of experimentIds) {
      for (let trialIndex = 0; trialIndex < trials; trialIndex += 1) {
        plan.push({ evalId, experimentId, trialIndex });
      }
    }
  }
  return plan;
}
