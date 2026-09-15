/**
 * Docker lifecycle integration tests, against a tiny alpine image — not the
 * full agent-runtime image. They exercise the isolation contract directly:
 * exactly one mount (/results), the attempt label, env injection, fixture
 * delivery via cp, filtered workspace export, timeout kill+remove, and
 * verifiable teardown.
 *
 * The suite SKIPS (loudly) when no Docker daemon is reachable — run it
 * locally with Docker started: `bun test docker`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeStream } from "../src/adapters/parse.ts";
import type { ContainerAgentAdapter } from "../src/adapters/types.ts";
import { discoverEvals } from "../src/evals/discovery.ts";
import type { LoadedExperiment, Runtime } from "../src/experiments/types.ts";
import {
  CONTAINER_GONE_STDERR,
  createAttemptContainer,
  dockerDaemonReachable,
  imageExists,
  inspectAttemptLabel,
  inspectMounts,
  listAttemptContainers,
  startMcpSidecar,
} from "../src/isolation/docker.ts";
import { MCP_PROXY_IMAGE } from "../src/isolation/images.ts";
import { planRun } from "../src/plan.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore } from "../src/store/db.ts";

const TEST_IMAGE = "alpine:3";
const LIFECYCLE_TIMEOUT = 120_000;

const daemonUp = await dockerDaemonReachable();
let testImageReady = false;
if (daemonUp) {
  testImageReady = await imageExists(TEST_IMAGE);
  if (!testImageReady) {
    testImageReady = Bun.spawnSync(["docker", "pull", TEST_IMAGE]).exitCode === 0;
  }
}
const enabled = daemonUp && testImageReady;
if (!enabled) {
  console.warn(
    `\n⚠️  SKIPPING docker integration tests — ${
      daemonUp ? `test image ${TEST_IMAGE} unavailable (pull failed)` : "no Docker daemon reachable"
    }.\n   Start Docker (Desktop/OrbStack/Colima) and re-run \`bun test docker\` to cover the isolation contract.\n`,
  );
}
const describeDocker = enabled ? describe : describe.skip;

// The mcp sidecar suite additionally needs the harness-built proxy image.
const mcpImageReady = daemonUp && (await imageExists(MCP_PROXY_IMAGE));
if (daemonUp && !mcpImageReady) {
  console.warn(
    `\n⚠️  SKIPPING mcp-sidecar docker tests — image ${MCP_PROXY_IMAGE} not built.\n` +
      `   Build it with \`bun src/cli.ts images build\` and re-run.\n`,
  );
}
const describeMcpSidecar = mcpImageReady ? describe : describe.skip;

const silent = () => {};

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "quickstudy-fixture-"));
  writeFileSync(join(dir, "app.txt"), "fixture file contents\n");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "nested.txt"), "nested\n");
  return dir;
}

function makeStores(): { store: ResultsStore; artifacts: ArtifactsStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "quickstudy-docker-run-"));
  return {
    store: new ResultsStore(join(root, "results.db")),
    artifacts: new ArtifactsStore(join(root, "results")),
    root,
  };
}

/**
 * An eval whose scorer proves the split scoring contract: one check via
 * ctx.exec (live sandbox) and one via the exported workspace files.
 */
function discoverAlpineEval(): ReturnType<typeof discoverEvals> {
  const evalsRoot = mkdtempSync(join(tmpdir(), "quickstudy-alpine-evals-"));
  const dir = join(evalsRoot, "alpine-e2e");
  mkdirSync(join(dir, "local"), { recursive: true });
  writeFileSync(join(dir, "PROMPT.md"), "---\nid: alpine-e2e\nsuite: benchmark\n---\n\nCreate hello.txt.\n");
  writeFileSync(join(dir, "local", "app.txt"), "fixture file");
  writeFileSync(
    join(dir, "EVAL.ts"),
    `export default async (ctx) => {
  const inContainer = (await ctx.exec(["test", "-f", "/workspace/hello.txt"])).exitCode === 0;
  const onHost = await ctx.fileExists("hello.txt");
  return {
    passed: inContainer && onHost,
    checks: [
      { name: "hello-in-container", passed: inContainer },
      { name: "hello-on-host", passed: onHost },
    ],
  };
};\n`,
  );
  return discoverEvals(evalsRoot);
}

/**
 * A container experiment on the alpine test image whose runtime provisions a
 * per-attempt credential (the env-redaction fixture) — driven by the "fake"
 * container agent adapter below.
 */
function alpineExperiment(
  runtimeOverrides: Partial<Runtime> = {},
  agent: LoadedExperiment["experiment"]["agent"] = { adapter: "fake", model: "fake-v1" },
): LoadedExperiment {
  const dir = mkdtempSync(join(tmpdir(), "quickstudy-alpine-exp-"));
  const path = join(dir, "fake-alpine.ts");
  writeFileSync(path, "// synthetic module for fake-alpine\n");
  return {
    experiment: {
      id: "fake-alpine",
      agent,
      runtime: {
        kind: "container",
        image: TEST_IMAGE,
        provision: (ctx) =>
          Promise.resolve({ credentialRef: `cred-${ctx.attemptId}`, env: { PACK_CRED: "pack-secret-value-654321" } }),
        ...runtimeOverrides,
      },
    },
    path,
  };
}

const FAKE_PROVIDER_KEY = "fake-provider-secret-123456";

/** A stand-in agent: its "CLI" is a shell one-liner emitting a claude-shaped stream. */
function makeFakeAdapter(script: string): ContainerAgentAdapter {
  return {
    kind: "container",
    name: "fake",
    identity: {
      provider: "test",
      model: "fake-v1",
      reasoning: "none",
      cliVersion: "test-cli-v1",
      surfacePolicies: { docs: "scripted", mcp: "scripted", cli: "scripted" },
      nativeWebControl: "controlled",
      reproducible: true,
    },
    requiredHostEnv: ["FAKE_PROVIDER_KEY"],
    setupFiles: () => ({ "/workspace/.fake/config.json": '{"treatment":true}\n' }),
    command: () => ["sh", "-c", script],
    parseStream: parseClaudeStream,
  };
}

/** Run the alpine eval × fake-agent experiment through the v3 runner. */
async function runFakeAttempt(options: {
  script: string;
  store: ResultsStore;
  artifacts: ArtifactsStore;
  attemptTimeoutMs?: number;
  log?: (line: string) => void;
}): Promise<Awaited<ReturnType<typeof executeRunV3>>> {
  const evals = discoverAlpineEval();
  const experiments = [alpineExperiment()];
  return executeRunV3({
    evals,
    experiments,
    plan: planRun(evals, experiments.map((entry) => entry.experiment), 1),
    store: options.store,
    artifacts: options.artifacts,
    containerAdapters: { fake: () => makeFakeAdapter(options.script) },
    ...(options.attemptTimeoutMs !== undefined ? { attemptTimeoutMs: options.attemptTimeoutMs } : {}),
    log: options.log ?? silent,
  });
}

const HAPPY_SCRIPT = [
  "cat /workspace/.fake/config.json >/dev/null || exit 9",
  'printf "provider=%s pack=%s\\n" "$FAKE_PROVIDER_KEY" "$PACK_CRED"',
  "echo created > hello.txt",
  "mkdir -p node_modules && echo x > node_modules/dep.js",
  `echo '{"type":"result","num_turns":2,"total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":5}}'`,
].join(" && ");

describeDocker("docker isolation", () => {
  test(
    "lifecycle: label, single /results mount, env, fixture via cp, writable results, filtered export, teardown",
    async () => {
      const fixtureDir = makeFixture();
      const resultsDir = mkdtempSync(join(tmpdir(), "quickstudy-results-"));
      const attemptId = `test-${Date.now()}-lifecycle`;
      const container = await createAttemptContainer({
        image: TEST_IMAGE,
        env: { QS_TEST_SECRET: "hunter2-hunter2" },
        resultsDir,
        attemptId,
        fixtureDir,
      });
      try {
        // Label present — teardown accounting hangs off it.
        expect(await inspectAttemptLabel(container.id)).toBe(attemptId);
        expect(await listAttemptContainers()).toContain(container.id);

        // Exactly one mount, at /results — the isolation criterion.
        const mounts = await inspectMounts(container.id);
        expect(mounts).toHaveLength(1);
        expect(mounts[0]?.destination).toBe("/results");

        // Env injected at create.
        const env = await container.execInWorkspace(["printenv", "QS_TEST_SECRET"]);
        expect(env.exitCode).toBe(0);
        expect(env.stdout.trim()).toBe("hunter2-hunter2");

        // Fixture delivered via cp into /workspace (cwd of exec).
        const cat = await container.execInWorkspace(["cat", "app.txt"]);
        expect(cat.stdout).toBe("fixture file contents\n");
        expect((await container.execInWorkspace(["cat", "sub/nested.txt"])).stdout).toBe("nested\n");

        // /results is writable from inside and lands on the host.
        const write = await container.execInWorkspace(["sh", "-c", "echo collected > /results/out.txt"]);
        expect(write.exitCode).toBe(0);
        expect(readFileSync(join(resultsDir, "out.txt"), "utf8")).toBe("collected\n");

        // writeFile places config with parent dirs.
        await container.writeFile("/workspace/.deep/dir/config.json", '{"ok":true}');
        expect((await container.execInWorkspace(["cat", ".deep/dir/config.json"])).stdout).toBe('{"ok":true}');

        // Export excludes dependency directories.
        await container.execInWorkspace(["sh", "-c", "mkdir -p node_modules && echo x > node_modules/dep.js"]);
        const exportDir = join(mkdtempSync(join(tmpdir(), "quickstudy-export-to-")), "workspace");
        await container.exportWorkspace(exportDir);
        expect(readFileSync(join(exportDir, "app.txt"), "utf8")).toBe("fixture file contents\n");
        expect(existsSync(join(exportDir, "node_modules"))).toBeFalse();
      } finally {
        // Concurrent: a deadline kill racing the attempt's final teardown
        // must not surface the daemon's "removal already in progress".
        await Promise.all([container.teardown(), container.teardown()]);
      }

      // Teardown is verifiable: the labeled listing no longer has it.
      expect(await listAttemptContainers()).not.toContain(container.id);
      // Idempotent.
      await container.teardown();
    },
    LIFECYCLE_TIMEOUT,
  );

  test(
    "exec timeout flags timedOut; non-zero exits carry stderr",
    async () => {
      const container = await createAttemptContainer({
        image: TEST_IMAGE,
        env: {},
        resultsDir: mkdtempSync(join(tmpdir(), "quickstudy-results-")),
        attemptId: `test-${Date.now()}-timeout`,
        fixtureDir: makeFixture(),
      });
      try {
        const bad = await container.execInWorkspace(["sh", "-c", "echo boom >&2; exit 3"]);
        expect(bad.exitCode).toBe(3);
        expect(bad.stderr).toContain("boom");
        expect(bad.timedOut).toBeFalse();
        const slow = await container.execInWorkspace(["sleep", "30"], { timeoutMs: 1_500 });
        expect(slow.timedOut).toBeTrue();
        // Timeout stops the sandbox, including descendants; it is no longer reusable.
        expect((await container.execInWorkspace(["true"])).exitCode).not.toBe(0);
      } finally {
        await container.teardown();
      }
    },
    LIFECYCLE_TIMEOUT,
  );

  test(
    "two concurrent attempts get distinct containers and distinct envs",
    async () => {
      const fixtureDir = makeFixture();
      const make = (n: number) =>
        createAttemptContainer({
          image: TEST_IMAGE,
          env: { ATTEMPT_MARKER: `marker-${n}-abcdef` },
          resultsDir: mkdtempSync(join(tmpdir(), "quickstudy-results-")),
          attemptId: `test-${Date.now()}-concurrent-${n}`,
          fixtureDir,
        });
      const [one, two] = await Promise.all([make(1), make(2)]);
      try {
        expect(one.id).not.toBe(two.id);
        expect((await one.execInWorkspace(["printenv", "ATTEMPT_MARKER"])).stdout.trim()).toBe("marker-1-abcdef");
        expect((await two.execInWorkspace(["printenv", "ATTEMPT_MARKER"])).stdout.trim()).toBe("marker-2-abcdef");
        for (const container of [one, two]) {
          expect(await inspectMounts(container.id)).toHaveLength(1);
        }
      } finally {
        await Promise.all([one.teardown(), two.teardown()]);
      }
    },
    LIFECYCLE_TIMEOUT,
  );

  test(
    "container agent attempt through the v3 runner: setup files, env, redaction, telemetry, split scoring, teardown",
    async () => {
      process.env["FAKE_PROVIDER_KEY"] = FAKE_PROVIDER_KEY;
      const before = new Set(await listAttemptContainers());
      const { store, artifacts } = makeStores();
      const warnings: string[] = [];
      try {
        const summary = await runFakeAttempt({ script: HAPPY_SCRIPT, store, artifacts, log: (m) => warnings.push(m) });
        expect(summary.total).toBe(1);
        expect(summary.passed).toBe(1);

        const attempt = store.listAttempts(summary.runId)[0]!;
        expect(attempt.status).toBe("completed");
        expect(attempt.result?.passed).toBe(true);
        expect(attempt.result?.checks.map((check) => [check.name, check.passed])).toEqual([
          ["hello-in-container", true],
          ["hello-on-host", true],
        ]);
        expect(attempt.tokensIn).toBe(10);
        expect(attempt.tokensOut).toBe(5);
        expect(attempt.costUsd).toBe(0.01);

        // Raw stream is the transcript, with every secret redacted — the
        // provider key AND the runtime-provisioned credential.
        const transcript = readFileSync(attempt.transcriptRef as string, "utf8");
        expect(transcript).toContain("[REDACTED:FAKE_PROVIDER_KEY]");
        expect(transcript).toContain("[REDACTED:PACK_CRED]");
        expect(transcript).not.toContain(FAKE_PROVIDER_KEY);
        expect(transcript).not.toContain("pack-secret-value-654321");

        // Workspace exported without dependency dirs (the scorer proved
        // hello.txt via the export); the diff is skipped with a loud warning
        // on the gitless test image.
        const workspace = artifacts.paths(summary.runId, attempt.id).workspace;
        expect(existsSync(join(workspace, "hello.txt"))).toBeTrue();
        expect(existsSync(join(workspace, "node_modules"))).toBeFalse();
        expect(warnings.some((w) => w.includes("git is unavailable"))).toBeTrue();

        // Teardown left nothing labeled behind.
        const after = await listAttemptContainers();
        expect(after.filter((id) => !before.has(id))).toEqual([]);
      } finally {
        store.close();
        delete process.env["FAKE_PROVIDER_KEY"];
      }
    },
    LIFECYCLE_TIMEOUT,
  );

  test(
    "timeout: agent killed AND container removed, status 'incomplete', partial evidence kept",
    async () => {
      process.env["FAKE_PROVIDER_KEY"] = FAKE_PROVIDER_KEY;
      const before = new Set(await listAttemptContainers());
      const { store, artifacts } = makeStores();
      try {
        const summary = await runFakeAttempt({
          script: "echo partial-evidence-line && sleep 60",
          store,
          artifacts,
          attemptTimeoutMs: 2_000,
        });
        expect(summary.incomplete).toBe(1);

        const attempt = store.listAttempts(summary.runId)[0]!;
        expect(attempt.status).toBe("incomplete");
        expect(attempt.error).toContain("timed out");
        const errorText = readFileSync(join(artifacts.paths(summary.runId, attempt.id).error), "utf8");
        expect(errorText).toContain("timed out");
        // Evidence captured before the kill is preserved.
        expect(readFileSync(attempt.transcriptRef as string, "utf8")).toContain("partial-evidence-line");

        const after = await listAttemptContainers();
        expect(after.filter((id) => !before.has(id))).toEqual([]);
      } finally {
        store.close();
        delete process.env["FAKE_PROVIDER_KEY"];
      }
    },
    LIFECYCLE_TIMEOUT,
  );

  test(
    "agent non-zero exit: status 'error' with the exit code, stderr in the error artifact",
    async () => {
      process.env["FAKE_PROVIDER_KEY"] = FAKE_PROVIDER_KEY;
      const { store, artifacts } = makeStores();
      try {
        const summary = await runFakeAttempt({ script: 'echo "segfault somewhere" >&2; exit 7', store, artifacts });
        expect(summary.errors).toBe(1);
        const attempt = store.listAttempts(summary.runId)[0]!;
        expect(attempt.status).toBe("error");
        expect(attempt.error).toContain("agent command exited 7");
        const errorText = readFileSync(join(artifacts.paths(summary.runId, attempt.id).error), "utf8");
        expect(errorText).toContain("segfault somewhere");
      } finally {
        store.close();
        delete process.env["FAKE_PROVIDER_KEY"];
      }
    },
    LIFECYCLE_TIMEOUT,
  );
});

describe("container removal (no daemon required)", () => {
  test("the daemon's two 'already gone' responses to `rm -f` count as success; anything else does not", () => {
    expect(CONTAINER_GONE_STDERR.test("Error response from daemon: No such container: abc123\n")).toBeTrue();
    expect(
      CONTAINER_GONE_STDERR.test("Error response from daemon: removal of container abc123 is already in progress\n"),
    ).toBeTrue();
    expect(CONTAINER_GONE_STDERR.test("permission denied while trying to connect to the Docker daemon socket\n")).toBeFalse();
  });
});

describe("container agent preflight (no daemon required)", () => {
  test("a missing provider key fails the run before any container is created", async () => {
    const { store, artifacts } = makeStores();
    const evals = discoverAlpineEval();
    const experiments = [alpineExperiment()];
    try {
      expect(
        executeRunV3({
          evals,
          experiments,
          plan: planRun(evals, experiments.map((entry) => entry.experiment), 1),
          store,
          artifacts,
          containerAdapters: {
            fake: () => ({ ...makeFakeAdapter("true"), requiredHostEnv: ["QS_DEFINITELY_NOT_SET_KEY"] }),
          },
          log: silent,
        }),
      ).rejects.toThrow(/QS_DEFINITELY_NOT_SET_KEY/);
      expect(store.listRuns()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("an unknown container agent adapter fails fast, naming the available ones", async () => {
    const { store, artifacts } = makeStores();
    const evals = discoverAlpineEval();
    const experiments = [alpineExperiment()];
    try {
      expect(
        executeRunV3({
          evals,
          experiments,
          plan: planRun(evals, experiments.map((entry) => entry.experiment), 1),
          store,
          artifacts,
          log: silent,
        }),
      ).rejects.toThrow(/no container agent adapter named "fake" \(available: claude, codex\)/);
    } finally {
      store.close();
    }
  });

  // Model-pin enforcement moved from the legacy CLI validation into the v3
  // runner's preflight (successor to cli.test.ts's "run rejects Anthropic's
  // pre-4.6 dateless convenience aliases", deleted with the legacy flags).
  // Both tests drive the real default claude adapter factory: the rejection
  // must land before provider keys are read and before any run row exists.
  test("a moving-alias model pin is rejected before any container work", async () => {
    const { store, artifacts } = makeStores();
    const evals = discoverAlpineEval();
    const experiments = [alpineExperiment({}, { adapter: "claude", model: "claude-sonnet-4-5", reasoning: "high" })];
    try {
      await expect(
        executeRunV3({
          evals,
          experiments,
          plan: planRun(evals, experiments.map((entry) => entry.experiment), 1),
          store,
          artifacts,
          log: silent,
        }),
      ).rejects.toThrow(/pins model "claude-sonnet-4-5", which is a moving alias/);
      expect(store.listRuns()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("UNPINNED model or reasoning is rejected before any container work", async () => {
    const cases: Array<{ agent: LoadedExperiment["experiment"]["agent"]; error: RegExp }> = [
      { agent: { adapter: "claude" }, error: /must pin agent\.model to an exact versioned id/ },
      {
        agent: { adapter: "claude", model: "claude-sonnet-4-5-20250929" },
        error: /must pin agent\.reasoning so reasoning effort cannot drift/,
      },
    ];
    for (const { agent, error } of cases) {
      const { store, artifacts } = makeStores();
      const evals = discoverAlpineEval();
      const experiments = [alpineExperiment({}, agent)];
      try {
        await expect(
          executeRunV3({
            evals,
            experiments,
            plan: planRun(evals, experiments.map((entry) => entry.experiment), 1),
            store,
            artifacts,
            log: silent,
          }),
        ).rejects.toThrow(error);
        expect(store.listRuns()).toEqual([]);
      } finally {
        store.close();
      }
    }
  });
});

describeMcpSidecar("mcp auth-proxy sidecar", () => {
  test(
    "starts from an env-file, exposes initial tokens for read-back, tears down",
    async () => {
      const sidecar = await startMcpSidecar({
        runId: "mcp-sidecar-smoke",
        image: MCP_PROXY_IMAGE,
        // Unreachable upstreams are fine: startup + read-back touch no network.
        upstreams: {
          "svc one": { url: "https://mcp.invalid/mcp", tokenEndpoint: "https://as.invalid/token", clientId: "c-1" },
        },
        refreshTokens: { "svc one": "rt-initial" },
      });
      try {
        expect(await sidecar.isRunning()).toBeTrue();
        expect(sidecar.ip).not.toBe("");
        expect(sidecar.port).toBe(8914);
        // The sanitized state file exists from startup — teardown read-back
        // works even when no request ever triggered a refresh.
        const tokens = await sidecar.readRotatedRefreshTokens();
        expect(tokens["svc one"]).toBe("rt-initial");
      } finally {
        await sidecar.teardown();
      }
      expect(await sidecar.isRunning()).toBeFalse();
    },
    LIFECYCLE_TIMEOUT,
  );
});
