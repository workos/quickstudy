/**
 * `runtime.promptPreamble`: the sanctioned way to tell an agent what a
 * treatment offers. Recorded per pair, composed before the eval body, and
 * identity-bearing — group members that differ must declare it.
 */
import { describe, expect, test } from "bun:test";
import { composePrompt, pairKey, resolvePairEnvironments } from "../src/execution-policy.ts";
import { ClaudeCodeAdapter } from "../src/adapters/claude.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { compareGroups } from "../src/experiments/groups.ts";
import type { Experiment, LoadedExperiment } from "../src/experiments/types.ts";
import type { LoadedEval } from "../src/evals/types.ts";
import { buildRunManifest } from "../src/manifest.ts";
import { discoverEvals } from "../src/evals/discovery.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { planRun } from "../src/plan.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore } from "../src/store/db.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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


describe("promptPreamble delivery", () => {
  test("container adapters put the composed prompt in the agent's argv verbatim", () => {
    // The container path hands `composePrompt(pair.promptPreamble, body)` to the
    // adapter as ctx.prompt (src/runner/execute.ts); a real container run needs an
    // agent key, so this pins the adapter half of that path offline.
    const prompt = composePrompt("A `acme` CLI is on PATH.", "Do the task.");
    const ctx = { runId: "r", attemptId: "a", prompt, trialIndex: 0, webPolicy: "native-web-blocked" as const };
    expect(new ClaudeCodeAdapter("claude", { model: "claude-sonnet-5", reasoning: "high" }).command(ctx)).toContain(prompt);
    expect(new CodexAdapter("codex", { model: "gpt-5.6-sol", reasoning: "high" }).command(ctx)).toContain(prompt);
  });

  test("the host runner hands the agent the recorded preamble followed by the verbatim eval body", async () => {
    const evals = await loadedEvals();
    const loaded = experiment("hinted", "cli", "A `acme` CLI is on PATH; run `acme --help`.");
    const root = mkdtempSync(join(tmpdir(), "qs-preamble-"));
    const store = new ResultsStore(join(root, "results.db"));
    const artifacts = new ArtifactsStore(join(root, "results"));
    const summary = await executeRunV3({
      evals,
      experiments: [loaded],
      plan: planRun(evals, [loaded.experiment], 1),
      store,
      artifacts,
      log: () => {},
    });
    expect(summary.total).toBe(1);
    const attempt = store.listAttempts(summary.runId)[0]!;
    const recorded = store.getRun(summary.runId)!.manifest.pairs?.[pairKey("hello-local", "hinted")]?.promptPreamble;
    expect(recorded).toBe("A `acme` CLI is on PATH; run `acme --help`.");
    // The echo adapter records the prompt it received as the first user turn.
    const transcript = readFileSync(artifacts.paths(summary.runId, attempt.id).transcript, "utf8");
    const userTurn = transcript.split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((event) => event?.role === "user");
    expect(userTurn?.content).toBe(`${recorded}\n\n${evals[0]!.promptBody}`);
  });
});
