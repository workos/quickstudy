/**
 * `runtime.promptPreamble`: the sanctioned way to tell an agent what a
 * treatment offers. Recorded per pair, composed before the eval body, and
 * identity-bearing — group members that differ must declare it.
 */
import { describe, expect, test } from "bun:test";
import { composePrompt, pairKey, resolvePairEnvironments } from "../src/execution-policy.ts";
import { compareGroups } from "../src/experiments/groups.ts";
import type { Experiment, LoadedExperiment } from "../src/experiments/types.ts";
import type { LoadedEval } from "../src/evals/types.ts";
import { buildRunManifest } from "../src/manifest.ts";
import { discoverEvals } from "../src/evals/discovery.ts";
import { resolve } from "node:path";

const FIXTURE_EVALS = resolve(import.meta.dir, "__fixtures__", "evals");

function experiment(id: string, treatment: string, preamble: string | undefined, fields: string[] = []): LoadedExperiment {
  const exp: Experiment = {
    id,
    comparisonGroup: "g",
    treatment,
    agent: { adapter: "echo", provider: "local", model: "echo-v1", reasoning: "none", cliVersion: "built-in" },
    runtime: {
      kind: "host",
      config: { [treatment]: { hint: preamble ?? null } },
      ...(preamble !== undefined ? { promptPreamble: () => preamble } : {}),
      ...(fields.length > 0 ? { treatmentPolicyFields: fields } : {}),
    },
  } as Experiment;
  // The module path is hashed into the manifest; every test experiment shares one real fixture module.
  return { experiment: exp, path: resolve(import.meta.dir, "__fixtures__", "experiments", "echo-local.ts") };
}

async function loadedEvals(): Promise<LoadedEval[]> {
  const discovered = await discoverEvals(FIXTURE_EVALS);
  return discovered.filter((loaded) => loaded.metadata.id === "hello-local");
}

describe("composePrompt", () => {
  test("no preamble leaves the body byte-identical", () => {
    expect(composePrompt(null, "Do the task.")).toBe("Do the task.");
    expect(composePrompt(undefined, "Do the task.")).toBe("Do the task.");
    expect(composePrompt("   ", "Do the task.")).toBe("Do the task.");
  });
  test("a preamble precedes the body, separated by one blank line, with surrounding whitespace trimmed", () => {
    expect(composePrompt("\nA `acme` CLI is on PATH.\n", "Do the task.")).toBe("A `acme` CLI is on PATH.\n\nDo the task.");
  });
});

describe("promptPreamble identity", () => {
  test("is recorded per pair, null when absent or blank", async () => {
    const evals = await loadedEvals();
    const pairs = resolvePairEnvironments({
      evals,
      experiments: [experiment("cli", "cli", "A `acme` CLI is on PATH."), experiment("base", "baseline", undefined), experiment("blank", "blank", "  ")],
    });
    expect(pairs[pairKey("hello-local", "cli")]?.promptPreamble).toBe("A `acme` CLI is on PATH.");
    expect(pairs[pairKey("hello-local", "base")]?.promptPreamble).toBeNull();
    expect(pairs[pairKey("hello-local", "blank")]?.promptPreamble).toBeNull();
  });

  test("changing the preamble changes the manifest hash", async () => {
    const evals = await loadedEvals();
    const harness = { version: "test", revision: "0000000", dirty: false, source: { sha256: "0", files: 0, excluded: 0 } };
    const a = buildRunManifest({ evals, experiments: [experiment("cli", "cli", "v1")], harness });
    const b = buildRunManifest({ evals, experiments: [experiment("cli", "cli", "v2")], harness });
    expect(a.hash).not.toBe(b.hash);
  });

  test("group members that differ only by an undeclared preamble are withheld; declaring it allows the comparison", async () => {
    const evals = await loadedEvals();
    const harness = { version: "test", revision: "0000000", dirty: false, source: { sha256: "0", files: 0, excluded: 0 } };
    const undeclared = [experiment("cli", "cli", "A `acme` CLI is on PATH."), experiment("base", "baseline", undefined)];
    const withheld = compareGroups(undeclared.map((e) => e.experiment), buildRunManifest({ evals, experiments: undeclared, harness }));
    expect(withheld[0]?.comparison).toBe("withheld");
    expect(withheld[0]?.details.join("\n")).toContain("promptPreamble");

    const declared = [
      experiment("cli", "cli", "A `acme` CLI is on PATH.", ["promptPreamble"]),
      experiment("base", "baseline", undefined, ["promptPreamble"]),
    ];
    const allowed = compareGroups(declared.map((e) => e.experiment), buildRunManifest({ evals, experiments: declared, harness }));
    expect(allowed[0]?.comparison).toBe("allowed");
  });
});
