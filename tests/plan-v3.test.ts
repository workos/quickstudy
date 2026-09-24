import { describe, expect, test } from "bun:test";
import type { LoadedEval } from "../src/evals/types.ts";
import { defineExperiment, type Experiment } from "../src/experiments/types.ts";
import { filterEvals, planRun } from "../src/plan.ts";

function makeEval(id: string, metadata: Partial<LoadedEval["metadata"]> = {}): LoadedEval {
  return {
    metadata: { id, suite: "benchmark", ...metadata },
    dir: `/evals/${id}`,
    promptPath: `/evals/${id}/PROMPT.md`,
    promptBody: "do the thing",
    scorerPath: `/evals/${id}/EVAL.ts`,
    localDir: null,
    solutionDir: null,
  };
}

function makeExperiment(id: string): Experiment {
  return defineExperiment({ id, agent: { adapter: "echo" }, runtime: { kind: "host" } });
}

describe("v3 planner", () => {
  test("a plan entry has EXACTLY evalId, experimentId, trialIndex — axis creep is a bug", () => {
    const plan = planRun([makeEval("e1")], [makeExperiment("x1")], 1);
    expect(plan).toHaveLength(1);
    expect(Object.keys(plan[0] as object)).toEqual(["evalId", "experimentId", "trialIndex"]);
  });

  test("zero evals is an empty plan, not an error", () => {
    expect(planRun([], [makeExperiment("x1")], 3)).toEqual([]);
    expect(planRun([makeEval("e1")], [], 3)).toEqual([]);
  });

  test("deterministic ordering: evals by id, experiments by id, trials innermost", () => {
    const evals = [makeEval("b-eval"), makeEval("c-eval"), makeEval("a-eval")];
    const experiments = [makeExperiment("x2"), makeExperiment("x1")];
    const plan = planRun(evals, experiments, 3);
    expect(plan).toHaveLength(3 * 2 * 3);
    expect(plan).toEqual(planRun([...evals].reverse(), [...experiments].reverse(), 3));
    expect(plan.slice(0, 7)).toEqual([
      { evalId: "a-eval", experimentId: "x1", trialIndex: 0 },
      { evalId: "a-eval", experimentId: "x1", trialIndex: 1 },
      { evalId: "a-eval", experimentId: "x1", trialIndex: 2 },
      { evalId: "a-eval", experimentId: "x2", trialIndex: 0 },
      { evalId: "a-eval", experimentId: "x2", trialIndex: 1 },
      { evalId: "a-eval", experimentId: "x2", trialIndex: 2 },
      { evalId: "b-eval", experimentId: "x1", trialIndex: 0 },
    ]);
  });

  test("trials must be a positive integer", () => {
    expect(() => planRun([makeEval("e1")], [makeExperiment("x1")], 0)).toThrow(/trials must be an integer >= 1/);
    expect(() => planRun([makeEval("e1")], [makeExperiment("x1")], 1.5)).toThrow(/trials must be an integer >= 1/);
  });

  test("metadata filters apply to the eval list BEFORE planning and never appear in the plan", () => {
    const evals = [
      makeEval("bench", { suite: "benchmark", framework: "alpha", product: "widgets" }),
      makeEval("regr", { suite: "regression", framework: "beta" }),
      makeEval("bare"),
    ];
    expect(filterEvals(evals, {}).map((e) => e.metadata.id)).toEqual(["bench", "regr", "bare"]);
    expect(filterEvals(evals, { suites: ["regression"] }).map((e) => e.metadata.id)).toEqual(["regr"]);
    expect(filterEvals(evals, { frameworks: ["alpha"] }).map((e) => e.metadata.id)).toEqual(["bench"]);
    expect(filterEvals(evals, { products: ["widgets"] }).map((e) => e.metadata.id)).toEqual(["bench"]);
    expect(filterEvals(evals, { suites: ["benchmark"], frameworks: ["beta"] })).toEqual([]);

    const plan = planRun(filterEvals(evals, { suites: ["regression"] }), [makeExperiment("x1")], 1);
    expect(plan).toEqual([{ evalId: "regr", experimentId: "x1", trialIndex: 0 }]);
    expect(Object.keys(plan[0] as object)).toEqual(["evalId", "experimentId", "trialIndex"]);
  });
});
