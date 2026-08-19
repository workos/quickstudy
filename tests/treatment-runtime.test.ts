/**
 * Docker-gated: runtime-owned treatment wiring through REAL containers.
 *
 * One fixture eval runs under three runtime configs and the scorer asserts
 * the WIRING, not vendor binaries:
 *   - docs: the egress allowlist is applied (proxy env + internal network,
 *     hosts recorded verbatim in the run config) and no MCP config is offered;
 *   - mcp: the mcp-proxy sidecar is configured from the server spec + auth
 *     env file, and the container sees only a credential-free proxy URL;
 *   - cli: PATH starts with the treatment directory.
 * Plus provisioning success/failure/teardown-failure paths with a fake
 * provisioner, and the export-before-scoring ordering contract.
 *
 * Skips loudly without a daemon/images; QUICKSTUDY_REQUIRE_DOCKER=1 turns
 * that skip into a failure (tests/helpers.ts).
 */

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverEvals } from "../src/evals/discovery.ts";
import type { Experiment, LoadedExperiment } from "../src/experiments/types.ts";
import { listRunNetworks } from "../src/isolation/docker.ts";
import { AGENT_RUNTIME_IMAGE, EGRESS_PROXY_IMAGE, MCP_PROXY_IMAGE } from "../src/isolation/images.ts";
import { planRun } from "../src/plan.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore } from "../src/store/db.ts";
import { requireDockerOrSkip } from "./helpers.ts";

const describeDocker = await requireDockerOrSkip(
  [AGENT_RUNTIME_IMAGE, EGRESS_PROXY_IMAGE, MCP_PROXY_IMAGE],
  "treatment-runtime",
);

const silent = (): void => {};
const CAPTURE_ENV_COMMAND = ["sh", "-c", "printenv > CAPTURE.txt"];

function makeStores(): { store: ResultsStore; artifacts: ArtifactsStore } {
  const root = mkdtempSync(join(tmpdir(), "qs-treatment-"));
  return { store: new ResultsStore(join(root, "results.db")), artifacts: new ArtifactsStore(join(root, "results")) };
}

function writeEval(id: string, evalTs: string): ReturnType<typeof discoverEvals> {
  const evalsRoot = mkdtempSync(join(tmpdir(), "qs-treatment-evals-"));
  const dir = join(evalsRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PROMPT.md"), `---\nid: ${id}\nsuite: benchmark\n---\n\nProbe the ${id} wiring.\n`);
  writeFileSync(join(dir, "EVAL.ts"), evalTs);
  return discoverEvals(evalsRoot);
}

/** Wrap a constructed experiment with a real module file (the manifest hashes it). */
function loadedExperiment(experiment: Experiment): LoadedExperiment {
  const dir = mkdtempSync(join(tmpdir(), "qs-treatment-exp-"));
  const path = join(dir, `${experiment.id}.ts`);
  writeFileSync(path, `// synthetic module for ${experiment.id}\n`);
  return { experiment, path };
}

describeDocker("treatment wiring (container path)", () => {
  test(
    "docs, mcp, and cli runtime configs wire egress, mcp-proxy, and PATH through a real container",
    async () => {
      // The one scorer proves the export-before-scoring ordering for every
      // arm and the arm-specific wiring by experiment id.
      const evals = writeEval(
        "treatment-probe",
        String.raw`export default async (ctx) => {
  const exists = await ctx.fileExists("CAPTURE.txt");
  const captured = exists ? await ctx.readFile("CAPTURE.txt") : "";
  const live = await ctx.exec(["cat", "CAPTURE.txt"]);
  const checks = [
    { name: "workspace-exported-before-scoring", passed: exists },
    { name: "sandbox-alive-while-scoring", passed: live.exitCode === 0 },
  ];
  if (ctx.experimentId === "docs-arm") {
    checks.push({ name: "egress-proxy-env-applied", passed: /(^|\n)HTTPS_PROXY=http:\/\/[0-9.]+:3128(\n|$)/.test(captured) });
    checks.push({ name: "no-proxy-keeps-loopback", passed: /(^|\n)NO_PROXY=localhost,127\.0\.0\.1/.test(captured) });
    checks.push({ name: "no-mcp-config-offered", passed: !captured.includes("QUICKSTUDY_MCP_SERVERS=") });
  }
  if (ctx.experimentId === "mcp-arm") {
    checks.push({ name: "mcp-proxy-url-offered", passed: /QUICKSTUDY_MCP_SERVERS=\{"probe":\{"url":"http:\/\/[0-9.]+:8914\/probe"\}\}/.test(captured) });
    checks.push({ name: "no-upstream-url-leaked", passed: !captured.includes("mcp.treatment-probe.test") });
    checks.push({ name: "no-credentials-leaked", passed: !captured.includes("rt-secret-probe") && !captured.includes("client-probe") });
    checks.push({ name: "no-egress-proxy-for-this-arm", passed: !captured.includes("HTTPS_PROXY=") });
  }
  if (ctx.experimentId === "cli-arm") {
    checks.push({ name: "path-starts-with-treatment-dir", passed: /(^|\n)PATH=\/opt\/treatment-cli:/.test(captured) });
  }
  return { passed: checks.every((check) => check.passed), checks };
};
`,
      );

      // MCP auth env file, exactly what login tooling would maintain (0600).
      const authDir = mkdtempSync(join(tmpdir(), "qs-treatment-auth-"));
      const authFile = join(authDir, ".mcp-auth.env");
      writeFileSync(authFile, "PROBE_CLIENT_ID=client-probe\nPROBE_REFRESH_TOKEN=rt-secret-probe\n", { mode: 0o600 });
      chmodSync(authFile, 0o600);

      const docsArm = loadedExperiment({
        id: "docs-arm",
        comparisonGroup: "probe",
        treatment: "docs",
        agent: { adapter: "scripted" },
        runtime: {
          kind: "container",
          image: AGENT_RUNTIME_IMAGE,
          command: CAPTURE_ENV_COMMAND,
          config: { docs: { hosts: ["docs.treatment-probe.test"] } },
          egressHosts: () => ["docs.treatment-probe.test", "*.treatment-probe.test"],
        },
      });
      const mcpArm = loadedExperiment({
        id: "mcp-arm",
        comparisonGroup: "probe",
        treatment: "mcp",
        agent: { adapter: "scripted" },
        runtime: {
          kind: "container",
          image: AGENT_RUNTIME_IMAGE,
          command: CAPTURE_ENV_COMMAND,
          config: { mcp: { servers: ["probe"] } },
          mcpServers: () => ({
            probe: {
              url: "https://mcp.treatment-probe.test/mcp",
              auth: {
                kind: "oauth-refresh",
                tokenEndpoint: "https://as.treatment-probe.test/oauth2/token",
                credentialsFile: authFile,
                clientIdKey: "PROBE_CLIENT_ID",
                refreshTokenKey: "PROBE_REFRESH_TOKEN",
              },
            },
          }),
        },
      });
      const cliArm = loadedExperiment({
        id: "cli-arm",
        comparisonGroup: "probe",
        treatment: "cli",
        agent: { adapter: "scripted" },
        runtime: {
          kind: "container",
          image: AGENT_RUNTIME_IMAGE,
          command: CAPTURE_ENV_COMMAND,
          config: { cli: { dir: "/opt/treatment-cli" } },
          pathTreatment: () => "/opt/treatment-cli",
        },
      });

      const experiments = [docsArm, mcpArm, cliArm];
      const { store, artifacts } = makeStores();
      const summary = await executeRunV3({
        evals,
        experiments,
        plan: planRun(evals, experiments.map((entry) => entry.experiment), 1),
        store,
        artifacts,
        egressProxy: true,
        attemptTimeoutMs: 60_000,
        log: silent,
      });
      expect(summary).toMatchObject({ total: 3, passed: 3, failed: 0, errors: 0, incomplete: 0 });

      const attempts = store.listAttempts(summary.runId);
      for (const attempt of attempts) {
        expect(attempt.status).toBe("completed");
        expect(attempt.error).toBeNull();
        expect(attempt.result?.checks.filter((check) => !check.passed)).toEqual([]);
      }

      // The docs-arm hosts land in the run config VERBATIM (composed,
      // validated, sorted) — the failure mode this guards is hosts lost in
      // translation between the runtime and the proxy.
      const run = store.getRun(summary.runId);
      expect(run?.config.egress).toEqual({
        proxy: true,
        allowlist: ["*.treatment-probe.test", "docs.treatment-probe.test"],
      });

      // Run-scoped treatment infrastructure tore down with the run.
      expect(await listRunNetworks()).not.toContain(`quickstudy-run-${summary.runId.toLowerCase()}`);
      store.close();
    },
    300_000,
  );

  test(
    "a fake provisioner's env reaches the container, capabilities reach the scorer, and teardown runs after scoring",
    async () => {
      const evals = writeEval(
        "provision-probe",
        String.raw`export default async (ctx) => {
  const captured = (await ctx.fileExists("CAPTURE.txt")) ? (await ctx.readFile("CAPTURE.txt")) : "";
  const client = ctx.getClient("probe");
  return {
    passed: true,
    checks: [
      { name: "provisioned-env-delivered", passed: captured.includes("PROVISIONED_FLAG=yes") },
      { name: "capability-provided", passed: client !== null && typeof client === "object" && client.flag === "yes" },
    ],
  };
};
`,
      );

      const events: string[] = [];
      const experiment = loadedExperiment({
        id: "provisioned-arm",
        agent: { adapter: "scripted" },
        runtime: {
          kind: "container",
          image: AGENT_RUNTIME_IMAGE,
          command: CAPTURE_ENV_COMMAND,
          provision: async () => {
            events.push("provision");
            return {
              env: { PROVISIONED_FLAG: "yes" },
              credentialRef: "cred-1",
              teardown: async () => {
                events.push("teardown");
              },
            };
          },
          scorerCapabilities: (ctx) => ({
            getClient: (name: string) => {
              events.push(`capability:${name}`);
              return { flag: ctx.env["PROVISIONED_FLAG"] };
            },
          }),
        },
      });

      const { store, artifacts } = makeStores();
      const summary = await executeRunV3({
        evals,
        experiments: [experiment],
        plan: planRun(evals, [experiment.experiment], 1),
        store,
        artifacts,
        attemptTimeoutMs: 60_000,
        log: silent,
      });
      expect(summary).toMatchObject({ total: 1, passed: 1, errors: 0 });
      const attempt = store.listAttempts(summary.runId)[0]!;
      expect(attempt.status).toBe("completed");
      expect(attempt.error).toBeNull();
      expect(attempt.result?.checks.every((check) => check.passed)).toBe(true);
      // Provision first, capability during scoring, teardown strictly last.
      expect(events).toEqual(["provision", "capability:probe", "teardown"]);
      store.close();
    },
    120_000,
  );

  test(
    "a failing provisioner is an explicit attempt error with no agent spend, and teardown is still attempted",
    async () => {
      const evals = writeEval(
        "provision-fail",
        `export default async () => ({ passed: true, checks: [] });\n`,
      );
      const events: string[] = [];
      const experiment = loadedExperiment({
        id: "doomed-arm",
        agent: { adapter: "scripted" },
        runtime: {
          kind: "container",
          image: AGENT_RUNTIME_IMAGE,
          command: CAPTURE_ENV_COMMAND,
          provision: async () => {
            throw new Error("mint quota exhausted");
          },
          teardown: async () => {
            events.push("runtime-teardown");
          },
        },
      });

      const { store, artifacts } = makeStores();
      const summary = await executeRunV3({
        evals,
        experiments: [experiment],
        plan: planRun(evals, [experiment.experiment], 1),
        store,
        artifacts,
        attemptTimeoutMs: 60_000,
        log: silent,
      });
      expect(summary).toMatchObject({ total: 1, errors: 1, passed: 0 });
      const attempt = store.listAttempts(summary.runId)[0]!;
      expect(attempt.status).toBe("error");
      expect(attempt.error).toContain("provision failed: mint quota exhausted");
      // No agent spend: the container never ran, so no transcript exists.
      expect(attempt.transcriptRef).toBeNull();
      expect(events).toEqual(["runtime-teardown"]);
      store.close();
    },
    120_000,
  );

  test(
    "the committed treatment-fixture eval flows through the runner: local/ starting state, scorer import, stable check vocabulary",
    async () => {
      // The committed fixture eval replaces the synthetic tmpdir fixture:
      // discovery reads the committed fixture root, the runner copies its
      // local/ starting state, and score time imports the committed EVAL.ts.
      // The scripted arm does no agent work, so the checks that need it must
      // FAIL (honest failures with notes, never "error"), while local/
      // delivery keeps its checks passing and the check-name vocabulary
      // stays the registered set. (Real consumer content runs this diagonal
      // as the consumer repo's post-split smoke — see docs/ideation/
      // quickstudy-split/contract.md.)
      const evals = discoverEvals(join(import.meta.dir, "__fixtures__", "evals")).filter(
        (entry) => entry.metadata.id === "treatment-fixture",
      );
      expect(evals).toHaveLength(1);
      expect(evals[0]?.localDir).not.toBeNull();

      const experiment = loadedExperiment({
        id: "fixture-diagonal-arm",
        agent: { adapter: "scripted" },
        runtime: {
          kind: "container",
          image: AGENT_RUNTIME_IMAGE,
          command: ["sh", "-c", "ls > /dev/null"],
        },
      });

      const { store, artifacts } = makeStores();
      const summary = await executeRunV3({
        evals,
        experiments: [experiment],
        plan: planRun(evals, [experiment.experiment], 1),
        store,
        artifacts,
        attemptTimeoutMs: 120_000,
        log: silent,
      });
      // No agent work + unmodified starting state: the attempt completes and
      // fails honestly — never lands "error".
      expect(summary).toMatchObject({ total: 1, passed: 0, failed: 1, errors: 0 });
      const attempt = store.listAttempts(summary.runId)[0]!;
      expect(attempt.status).toBe("completed");
      expect(attempt.error).toBeNull();
      expect(attempt.result?.passed).toBe(false);
      expect(attempt.result?.checks.map((check) => check.name)).toEqual([
        "starting_state_delivered",
        "settings_configured",
        "notes_written",
        "seed_untampered",
      ]);
      const byName = new Map(attempt.result!.checks.map((check) => [check.name, check]));
      // The copied local/ tree reached the container workspace and the export.
      expect(byName.get("starting_state_delivered")?.passed).toBe(true);
      expect(byName.get("seed_untampered")?.passed).toBe(true);
      // The undone work is a failed check that blames the missing artifact.
      expect(byName.get("settings_configured")?.passed).toBe(false);
      expect(byName.get("settings_configured")?.notes).toContain("settings.json");
      expect(byName.get("notes_written")?.passed).toBe(false);
      store.close();
    },
    300_000,
  );

  test(
    "a failing teardown never masks the result — the attempt keeps it, with the failure recorded",
    async () => {
      const evals = writeEval(
        "teardown-fail",
        String.raw`export default async (ctx) => ({
  passed: true,
  checks: [{ name: "scored-against-live-sandbox", passed: (await ctx.exec(["true"])).exitCode === 0 }],
});
`,
      );
      const experiment = loadedExperiment({
        id: "leaky-arm",
        agent: { adapter: "scripted" },
        runtime: {
          kind: "container",
          image: AGENT_RUNTIME_IMAGE,
          command: CAPTURE_ENV_COMMAND,
          provision: async () => ({
            env: {},
            teardown: async () => {
              throw new Error("scrub failed");
            },
          }),
        },
      });

      const { store, artifacts } = makeStores();
      const summary = await executeRunV3({
        evals,
        experiments: [experiment],
        plan: planRun(evals, [experiment.experiment], 1),
        store,
        artifacts,
        attemptTimeoutMs: 60_000,
        log: silent,
      });
      // The result survives: the attempt still counts as passed…
      expect(summary).toMatchObject({ total: 1, passed: 1, errors: 0 });
      const attempt = store.listAttempts(summary.runId)[0]!;
      expect(attempt.status).toBe("completed");
      expect(attempt.result?.passed).toBe(true);
      // …and the teardown failure is recorded explicitly, never silently.
      expect(attempt.error).toContain("runtime teardown failed: scrub failed");
      store.close();
    },
    120_000,
  );
});
