import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.ts";
import { discoverEvals } from "../src/evals/discovery.ts";
import { discoverExperiments } from "../src/experiments/discovery.ts";
import type { LoadedExperiment } from "../src/experiments/types.ts";
import { dockerDaemonReachable, imageExists } from "../src/isolation/docker.ts";
import { AGENT_RUNTIME_IMAGE } from "../src/isolation/images.ts";
import { planRun } from "../src/plan.ts";
import { buildReport, renderReportText } from "../src/report/report.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore } from "../src/store/db.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const silent = (): void => {};

function makeStores(): { store: ResultsStore; artifacts: ArtifactsStore } {
  const root = mkdtempSync(join(tmpdir(), "qs-runner-v3-"));
  return { store: new ResultsStore(join(root, "results.db")), artifacts: new ArtifactsStore(join(root, "results")) };
}

function writeTmpEval(root: string, id: string, evalTs: string, local?: Record<string, string>): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PROMPT.md"), `---\nid: ${id}\nsuite: benchmark\n---\n\nDo the ${id} task.\n`);
  writeFileSync(join(dir, "EVAL.ts"), evalTs);
  if (local) {
    mkdirSync(join(dir, "local"), { recursive: true });
    for (const [name, content] of Object.entries(local)) writeFileSync(join(dir, "local", name), content);
  }
}

function hostExperiment(id: string, adapter = "echo"): LoadedExperiment {
  const dir = mkdtempSync(join(tmpdir(), "qs-exp-"));
  const path = join(dir, `${id}.ts`);
  writeFileSync(path, `export default { id: "${id}", agent: { adapter: "${adapter}" }, runtime: { kind: "host" } };\n`);
  return { experiment: { id, agent: { adapter }, runtime: { kind: "host" } }, path };
}

describe("v3 runner (host path)", () => {
  test("end-to-end: fixture eval × echo experiment discovered, planned, executed, scored, reported", async () => {
    // The fixture root also holds treatment-fixture (treatment-runtime's
    // diagonal eval) — this host smoke exercises the hello-local pair only.
    const evals = discoverEvals(join(FIXTURES, "evals")).filter((entry) => entry.metadata.id === "hello-local");
    const experiments = await discoverExperiments(join(FIXTURES, "experiments"));
    expect(experiments.map((entry) => entry.experiment.id)).toEqual(["echo-local"]);
    const plan = planRun(evals, experiments.map((entry) => entry.experiment), 1);
    expect(plan).toEqual([{ evalId: "hello-local", experimentId: "echo-local", trialIndex: 0 }]);

    const { store, artifacts } = makeStores();
    const summary = await executeRunV3({ evals, experiments, plan, store, artifacts, log: silent });
    expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0, incomplete: 0, errors: 0 });

    const attempts = store.listAttempts(summary.runId);
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt.status).toBe("completed");
    expect(attempt.result?.passed).toBe(true);
    expect(attempt.result?.checks.map((check) => check.name).sort()).toEqual(["local-state-preserved", "notes-written"]);
    expect(attempt.attemptIdentityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt.transcriptRef).not.toBeNull();
    expect(attempt.suite).toBe("benchmark");

    const run = store.getRun(summary.runId);
    expect(run?.finishedAt).not.toBeNull();
    expect(run?.manifest.evals["hello-local"]?.components.local).not.toBeNull();

    const report = renderReportText(
      buildReport({ store, runId: summary.runId, resultsDir: artifacts.rootDir }),
    );
    expect(report).toContain("hello-local × echo-local");
    expect(report).toContain("notes-written");
    expect(report).toContain("100% pass rate");
    store.close();
  });

  test("a shared local: fixture root is copied into the workspace, never mutated", async () => {
    const evalsRoot = mkdtempSync(join(tmpdir(), "qs-evals-shared-"));
    mkdirSync(join(evalsRoot, "shared", "alpha"), { recursive: true });
    writeFileSync(join(evalsRoot, "shared", "alpha", "seed.txt"), "alpha seed\n");
    const dir = join(evalsRoot, "multi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "PROMPT.md"),
      `---\nid: multi\nsuite: benchmark\nframeworks:\n  - alpha\nlocal: ../shared\n---\n\nDo the multi task.\n`,
    );
    writeFileSync(
      join(dir, "EVAL.ts"),
      `export default async (ctx) => { const ok = await ctx.fileExists("seed.txt"); return { passed: ok, checks: [{ name: "seeded", passed: ok }] }; };\n`,
    );

    const evals = discoverEvals(evalsRoot);
    expect(evals.map((entry) => entry.metadata.id)).toEqual(["multi-alpha"]);
    const experiment = hostExperiment("echo-shared");
    const { store, artifacts } = makeStores();
    const summary = await executeRunV3({
      evals,
      experiments: [experiment],
      plan: planRun(evals, [experiment.experiment], 1),
      store,
      artifacts,
      log: silent,
    });
    expect(summary).toMatchObject({ total: 1, passed: 1, errors: 0 });

    // The shared fixture root is starting state, not a workspace: the run
    // must leave it byte-identical (echo writes its NOTES.md into the copy).
    expect(readdirSync(join(evalsRoot, "shared", "alpha")).sort()).toEqual(["seed.txt"]);
    expect(readFileSync(join(evalsRoot, "shared", "alpha", "seed.txt"), "utf8")).toBe("alpha seed\n");
    store.close();
  });

  test("a throwing scorer records status=error and the run continues", async () => {
    const evalsRoot = mkdtempSync(join(tmpdir(), "qs-evals-run-"));
    writeTmpEval(evalsRoot, "boom", `export default async () => { throw new Error("scorer exploded"); };\n`);
    writeTmpEval(evalsRoot, "calm", `export default async () => ({ passed: true, checks: [{ name: "ok", passed: true }] });\n`);
    const evals = discoverEvals(evalsRoot);
    const experiment = hostExperiment("echo-x");
    const plan = planRun(evals, [experiment.experiment], 1);

    const { store, artifacts } = makeStores();
    const summary = await executeRunV3({ evals, experiments: [experiment], plan, store, artifacts, log: silent });
    expect(summary).toMatchObject({ total: 2, passed: 1, errors: 1, incomplete: 0 });

    const attempts = store.listAttempts(summary.runId);
    const boom = attempts.find((attempt) => attempt.evalId === "boom")!;
    expect(boom.status).toBe("error");
    expect(boom.error).toContain("scorer exploded");
    expect(boom.result).toBeNull();
    const calm = attempts.find((attempt) => attempt.evalId === "calm")!;
    expect(calm.status).toBe("completed");
    expect(store.getRun(summary.runId)?.finishedAt).not.toBeNull();
    store.close();
  });

  test("an adapter that outlives its timeout records status=incomplete", async () => {
    const evalsRoot = mkdtempSync(join(tmpdir(), "qs-evals-stall-"));
    writeTmpEval(evalsRoot, "stalled", `export default async () => ({ passed: true, checks: [] });\n`);
    const evals = discoverEvals(evalsRoot);
    const experiment = hostExperiment("stall-x", "stall");
    const stall: AgentAdapter = { name: "stall", runAttempt: () => new Promise(() => {}) };

    const { store, artifacts } = makeStores();
    const summary = await executeRunV3({
      evals,
      experiments: [experiment],
      plan: planRun(evals, [experiment.experiment], 1),
      store,
      artifacts,
      hostAdapters: { stall },
      attemptTimeoutMs: 50,
      log: silent,
    });
    expect(summary).toMatchObject({ total: 1, incomplete: 1, passed: 0, errors: 0 });
    const attempt = store.listAttempts(summary.runId)[0]!;
    expect(attempt.status).toBe("incomplete");
    expect(attempt.error).toContain("timed out");
    store.close();
  });

  test("2 trials produce 2 rows with distinct trial_index and one shared identity hash", async () => {
    const evals = discoverEvals(join(FIXTURES, "evals")).filter((entry) => entry.metadata.id === "hello-local");
    const experiments = await discoverExperiments(join(FIXTURES, "experiments"));
    const plan = planRun(evals, experiments.map((entry) => entry.experiment), 2);

    const { store, artifacts } = makeStores();
    const summary = await executeRunV3({ evals, experiments, plan, store, artifacts, log: silent });
    expect(summary.total).toBe(2);
    const attempts = store.listAttempts(summary.runId);
    expect(attempts.map((attempt) => attempt.trialIndex).sort()).toEqual([0, 1]);
    expect(new Set(attempts.map((attempt) => attempt.attemptIdentityHash)).size).toBe(1);
    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(2);
    store.close();
  });

  test("unresolvable plan entries fail fast before any attempt runs", async () => {
    const evals = discoverEvals(join(FIXTURES, "evals"));
    const experiments = await discoverExperiments(join(FIXTURES, "experiments"));
    const { store, artifacts } = makeStores();
    expect(
      executeRunV3({
        evals,
        experiments,
        plan: [{ evalId: "ghost", experimentId: "echo-local", trialIndex: 0 }],
        store,
        artifacts,
        log: silent,
      }),
    ).rejects.toThrow(/unknown eval "ghost"/);
    store.close();
  });
});

// --- Docker-gated: scripted command in the agent-runtime image -------------

const daemonUp = await dockerDaemonReachable();
const runtimeImageReady = daemonUp && (await imageExists(AGENT_RUNTIME_IMAGE));
if (!runtimeImageReady) {
  console.warn(
    `\n⚠️  SKIPPING v3 container-runner tests — ${
      daemonUp ? `image ${AGENT_RUNTIME_IMAGE} not built (build it with \`bun src/cli.ts images build\`)` : "no Docker daemon reachable"
    }.\n   Start Docker and re-run \`bun test runner-v3\` to cover the container path.\n`,
  );
}
const describeContainer = runtimeImageReady ? describe : describe.skip;

describeContainer("v3 runner (container path)", () => {
  test(
    "scripted container command mutates the workspace; export happens before scoring with the sandbox alive",
    async () => {
      const evalsRoot = mkdtempSync(join(tmpdir(), "qs-evals-docker-"));
      // The scorer proves BOTH halves of the ordering contract: the exported
      // workspace already contains the container's mutation, and ctx.exec
      // still reaches the LIVE sandbox while scoring runs.
      writeTmpEval(
        evalsRoot,
        "container-touch",
        `export default async (ctx) => {
  const exported = (await ctx.fileExists("CONTAINER.md")) && (await ctx.readFile("CONTAINER.md")).includes("container-was-here");
  const seedKept = await ctx.fileExists("seed.txt");
  const live = await ctx.exec(["cat", "CONTAINER.md"]);
  return {
    passed: exported && seedKept && live.exitCode === 0,
    checks: [
      { name: "workspace-exported-before-scoring", passed: exported },
      { name: "local-seed-delivered", passed: seedKept },
      { name: "sandbox-alive-while-scoring", passed: live.exitCode === 0 && live.stdout.includes("container-was-here") },
    ],
  };
};\n`,
        { "seed.txt": "seed\n" },
      );
      const evals = discoverEvals(evalsRoot);

      const experimentDir = mkdtempSync(join(tmpdir(), "qs-exp-docker-"));
      const experimentPath = join(experimentDir, "scripted-container.ts");
      writeFileSync(
        experimentPath,
        `export default { id: "scripted-container", agent: { adapter: "scripted" }, runtime: { kind: "container", image: ${JSON.stringify(AGENT_RUNTIME_IMAGE)}, command: ["sh", "-c", "echo container-was-here > CONTAINER.md"] } };\n`,
      );
      const experiments: LoadedExperiment[] = [
        {
          experiment: {
            id: "scripted-container",
            agent: { adapter: "scripted" },
            runtime: {
              kind: "container",
              image: AGENT_RUNTIME_IMAGE,
              command: ["sh", "-c", "echo container-was-here > CONTAINER.md"],
            },
          },
          path: experimentPath,
        },
      ];

      const { store, artifacts } = makeStores();
      const summary = await executeRunV3({
        evals,
        experiments,
        plan: planRun(evals, experiments.map((entry) => entry.experiment), 1),
        store,
        artifacts,
        attemptTimeoutMs: 60_000,
        log: silent,
      });
      expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0, errors: 0, incomplete: 0 });
      const attempt = store.listAttempts(summary.runId)[0]!;
      expect(attempt.status).toBe("completed");
      expect(attempt.result?.checks.every((check) => check.passed)).toBe(true);
      store.close();
    },
    120_000,
  );
});
