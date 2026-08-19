/**
 * v3 experiments: discovery of the committed fixture experiments root,
 * duplicate-id refusal, and comparison-group withhold-and-diff semantics —
 * all offline (group checks run against config objects and synthetic module
 * files, never containers).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverEvals } from "../src/evals/discovery.ts";
import { discoverExperiments } from "../src/experiments/discovery.ts";
import { compareGroups } from "../src/experiments/groups.ts";
import { defineExperiment, type Experiment, type LoadedExperiment } from "../src/experiments/types.ts";
import { buildRunManifest } from "../src/manifest.ts";
import { planRun } from "../src/plan.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore } from "../src/store/db.ts";

const EXPERIMENTS_ROOT = join(import.meta.dir, "__fixtures__", "experiments", "groups");
const silent = (): void => {};

/** Wrap a constructed experiment in a LoadedExperiment with a real module file. */
function loadedExperiment(experiment: Experiment): LoadedExperiment {
  const dir = mkdtempSync(join(tmpdir(), "qs-exp-groups-"));
  const path = join(dir, `${experiment.id}.ts`);
  writeFileSync(path, `// synthetic module for ${experiment.id}\n`);
  return { experiment, path };
}

function manifestFor(experiments: LoadedExperiment[]): ReturnType<typeof buildRunManifest> {
  return buildRunManifest({ evals: [], experiments });
}

describe("experiments/ discovery", () => {
  test("the committed fixture root yields six experiments in two allowed comparison groups", async () => {
    const loaded = await discoverExperiments(EXPERIMENTS_ROOT);
    expect(loaded.map((entry) => entry.experiment.id)).toEqual([
      "group-a-cli",
      "group-a-docs",
      "group-a-mcp",
      "group-b-cli",
      "group-b-docs",
      "group-b-mcp",
    ]);

    const groups = compareGroups(
      loaded.map((entry) => entry.experiment),
      manifestFor(loaded),
    );
    expect(groups.map((group) => group.group)).toEqual(["group-a", "group-b"]);
    for (const group of groups) {
      expect(group.experimentIds).toHaveLength(3);
      expect(group.comparison).toBe("allowed");
      expect(group.mismatches).toEqual([]);
    }
  });

  test("two modules claiming one id abort discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "qs-exp-dup-"));
    const module = `export default { id: "twin", agent: { adapter: "echo" }, runtime: { kind: "host" } };\n`;
    writeFileSync(join(root, "a.ts"), module);
    writeFileSync(join(root, "b.ts"), module);
    expect(discoverExperiments(root)).rejects.toThrow(/duplicate experiment id "twin"/);
  });
});

describe("defineExperiment", () => {
  test("treatment is an opaque string — no enum validation", () => {
    const experiment = defineExperiment({
      id: "weird",
      agent: { adapter: "echo" },
      runtime: { kind: "host" },
      treatment: "docs-but-printed-and-mailed",
    });
    expect(experiment.treatment).toBe("docs-but-printed-and-mailed");
  });

  test("a container runtime accepts a containerImage resolver instead of a static image", () => {
    expect(() =>
      defineExperiment({ id: "no-image", agent: { adapter: "x" }, runtime: { kind: "container" } }),
    ).toThrow(/needs an image/);
    const experiment = defineExperiment({
      id: "resolved-image",
      agent: { adapter: "x" },
      runtime: { kind: "container", containerImage: () => "img:latest" },
    });
    expect(experiment.runtime.containerImage?.({ id: "e", suite: "other" })).toBe("img:latest");
  });

  test("an empty comparisonGroup is refused", () => {
    expect(() =>
      defineExperiment({ id: "x", agent: { adapter: "echo" }, runtime: { kind: "host" }, comparisonGroup: " " }),
    ).toThrow(/comparisonGroup/);
  });
});

describe("comparison groups (withhold-and-diff)", () => {
  const agent = { adapter: "claude", provider: "anthropic", model: "model-a", reasoning: "high" };

  test("members differing only by treatment + its config subtree are allowed", () => {
    const docs = loadedExperiment({
      id: "g-docs",
      comparisonGroup: "g",
      treatment: "docs",
      agent,
      runtime: { kind: "container", image: "img:1", command: ["true"], config: { docs: { nativeWeb: true } } },
    });
    const mcp = loadedExperiment({
      id: "g-mcp",
      comparisonGroup: "g",
      treatment: "mcp",
      agent,
      runtime: { kind: "container", image: "img:1", command: ["true"], config: { mcp: { servers: ["s"] } } },
    });
    const groups = compareGroups([docs.experiment, mcp.experiment], manifestFor([docs, mcp]));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.comparison).toBe("allowed");
    expect(groups[0]?.details).toEqual([]);
  });

  test("a mismatched model within a group is withheld and the diff names the component", () => {
    const a = loadedExperiment({
      id: "g-a",
      comparisonGroup: "g",
      treatment: "docs",
      agent: { ...agent, model: "model-a" },
      runtime: { kind: "container", image: "img:1", command: ["true"], config: { docs: {} } },
    });
    const b = loadedExperiment({
      id: "g-b",
      comparisonGroup: "g",
      treatment: "mcp",
      agent: { ...agent, model: "model-b" },
      runtime: { kind: "container", image: "img:1", command: ["true"], config: { mcp: {} } },
    });
    const groups = compareGroups([a.experiment, b.experiment], manifestFor([a, b]));
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.comparison).toBe("withheld");
    expect(group.mismatches.map((mismatch) => mismatch.path)).toEqual(["identity.agent.model"]);
    expect(group.details[0]).toContain("g-a vs g-b");
    expect(group.details[0]).toContain("identity.agent.model");
    expect(group.details[0]).toContain('"model-a" -> "model-b"');
  });

  test("shared (non-treatment) runtime config drift is a mismatch; a singleton group is trivially allowed", () => {
    const a = loadedExperiment({
      id: "d-a",
      comparisonGroup: "d",
      treatment: "docs",
      agent,
      runtime: { kind: "container", image: "img:1", command: ["true"], config: { docs: {}, shared: { retries: 1 } } },
    });
    const b = loadedExperiment({
      id: "d-b",
      comparisonGroup: "d",
      treatment: "mcp",
      agent,
      runtime: { kind: "container", image: "img:1", command: ["true"], config: { mcp: {}, shared: { retries: 2 } } },
    });
    const solo = loadedExperiment({
      id: "solo",
      comparisonGroup: "lonely",
      agent,
      runtime: { kind: "host" },
    });
    const ungrouped = loadedExperiment({ id: "free", agent, runtime: { kind: "host" } });

    const groups = compareGroups(
      [a.experiment, b.experiment, solo.experiment, ungrouped.experiment],
      manifestFor([a, b, solo, ungrouped]),
    );
    expect(groups.map((group) => group.group)).toEqual(["d", "lonely"]);
    expect(groups[0]?.comparison).toBe("withheld");
    expect(groups[0]?.mismatches.some((mismatch) => mismatch.path.includes("runtime.config.shared"))).toBe(true);
    expect(groups[1]?.comparison).toBe("allowed");
  });

  test("a withheld group never blocks the run — raw per-experiment results still land", async () => {
    const evalsRoot = mkdtempSync(join(tmpdir(), "qs-evals-withheld-"));
    const dir = join(evalsRoot, "hello");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PROMPT.md"), "---\nid: hello\nsuite: benchmark\n---\n\nSay hello.\n");
    writeFileSync(join(dir, "EVAL.ts"), `export default async () => ({ passed: true, checks: [{ name: "ok", passed: true }] });\n`);
    const evals = discoverEvals(evalsRoot);

    const a = loadedExperiment({
      id: "w-a",
      comparisonGroup: "w",
      treatment: "docs",
      agent: { adapter: "echo", model: "model-a" },
      runtime: { kind: "host" },
    });
    const b = loadedExperiment({
      id: "w-b",
      comparisonGroup: "w",
      treatment: "cli",
      agent: { adapter: "echo", model: "model-b" },
      runtime: { kind: "host" },
    });
    const experiments = [a, b];
    const manifest = manifestFor(experiments);
    const groups = compareGroups(experiments.map((entry) => entry.experiment), manifest);
    expect(groups[0]?.comparison).toBe("withheld");

    const root = mkdtempSync(join(tmpdir(), "qs-withheld-run-"));
    const store = new ResultsStore(join(root, "results.db"));
    const artifacts = new ArtifactsStore(join(root, "results"));
    const summary = await executeRunV3({
      evals,
      experiments,
      plan: planRun(evals, experiments.map((entry) => entry.experiment), 1),
      store,
      artifacts,
      log: silent,
    });
    expect(summary).toMatchObject({ total: 2, passed: 2, failed: 0, errors: 0, incomplete: 0 });
    const attempts = store.listAttempts(summary.runId);
    expect(attempts.map((attempt) => attempt.experimentId).sort()).toEqual(["w-a", "w-b"]);
    expect(attempts.every((attempt) => attempt.result?.passed)).toBe(true);
    store.close();
  });
});
