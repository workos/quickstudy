/**
 * Egress-proxy end-to-end tests against a live Docker daemon — fully
 * hermetic (a bun-served origin container stands in for the internet):
 *
 *   - v3 run under --egress-proxy: internal network means NO direct route; a
 *     denied host 403s through the proxy; the composed allowlist (runtime +
 *     agent adapter layers) lands in the run's config_json; the network and
 *     sidecar are verifiably torn down;
 *   - allowed path: an allowlisted host is reachable THROUGH the proxy
 *     (and still is after a sidecar restart), a non-allowlisted one is not.
 *
 * (The legacy per-attempt egress-denials.log artifact and the
 * `egress_no_route` fail reason died with the v2 orchestrator; the proxy's
 * own denial-event shape is still covered by tests/proxy.test.ts.)
 *
 * The suite SKIPS (loudly) without a daemon, the alpine test image, or a
 * built quickstudy/egress-proxy image: `quickstudy images build` first.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeStream } from "../src/adapters/parse.ts";
import type { ContainerAgentAdapter } from "../src/adapters/types.ts";
import { discoverEvals } from "../src/evals/discovery.ts";
import type { LoadedExperiment } from "../src/experiments/types.ts";
import {
  createAttemptContainer,
  createRunNetwork,
  dockerDaemonReachable,
  imageExists,
  listRunContainers,
  listRunNetworks,
  removeRunNetwork,
  startEgressSidecar,
} from "../src/isolation/docker.ts";
import { EGRESS_PROXY_IMAGE } from "../src/isolation/images.ts";
import { planRun } from "../src/plan.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore } from "../src/store/db.ts";

const TEST_IMAGE = "alpine:3";
const E2E_TIMEOUT = 180_000;

const daemonUp = await dockerDaemonReachable();
let alpineReady = false;
let proxyImageReady = false;
if (daemonUp) {
  alpineReady = (await imageExists(TEST_IMAGE)) || Bun.spawnSync(["docker", "pull", TEST_IMAGE]).exitCode === 0;
  proxyImageReady = await imageExists(EGRESS_PROXY_IMAGE);
}
const enabled = daemonUp && alpineReady && proxyImageReady;
if (!enabled) {
  const reason = !daemonUp
    ? "no Docker daemon reachable"
    : !alpineReady
      ? `test image ${TEST_IMAGE} unavailable (pull failed)`
      : `${EGRESS_PROXY_IMAGE} not built — run \`bun src/cli.ts images build\``;
  console.warn(
    `\n⚠️  SKIPPING egress e2e tests — ${reason}.\n   Fix that and re-run \`bun test egress\` to cover the egress-proxy contract.\n`,
  );
}
const describeEgress = enabled ? describe : describe.skip;

const silent = () => {};
const FAKE_PROVIDER_KEY = "fake-provider-secret-123456";

function docker(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["docker", ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function makeStores(): { store: ResultsStore; artifacts: ArtifactsStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "quickstudy-egress-run-"));
  return {
    store: new ResultsStore(join(root, "results.db")),
    artifacts: new ArtifactsStore(join(root, "results")),
    root,
  };
}

/** One eval whose scorer proves proof.txt landed (via the live sandbox). */
function discoverEgressEval(): ReturnType<typeof discoverEvals> {
  const evalsRoot = mkdtempSync(join(tmpdir(), "quickstudy-egress-evals-"));
  const dir = join(evalsRoot, "egress-e2e");
  mkdirSync(join(dir, "local"), { recursive: true });
  writeFileSync(join(dir, "PROMPT.md"), "---\nid: egress-e2e\nsuite: benchmark\n---\n\nCreate proof.txt.\n");
  writeFileSync(join(dir, "local", "app.txt"), "fixture file");
  writeFileSync(
    join(dir, "EVAL.ts"),
    `export default async (ctx) => {
  const created = (await ctx.exec(["test", "-f", "/workspace/proof.txt"])).exitCode === 0;
  return { passed: created, checks: [{ name: "proof-created", passed: created }] };
};\n`,
  );
  return discoverEvals(evalsRoot);
}

/** A container experiment whose runtime contributes the product-layer egress hosts. */
function egressExperiment(): LoadedExperiment {
  const dir = mkdtempSync(join(tmpdir(), "quickstudy-egress-exp-"));
  const path = join(dir, "fake-egress.ts");
  writeFileSync(path, "// synthetic module for fake-egress\n");
  return {
    experiment: {
      id: "fake-egress",
      agent: { adapter: "fake", model: "fake-v1" },
      runtime: {
        kind: "container",
        image: TEST_IMAGE,
        egressHosts: () => ["pack-contributed.example"],
      },
    },
    path,
  };
}

/** A stand-in agent whose "CLI" is a shell script emitting a claude-shaped stream. */
function makeFakeAdapter(script: string, egressHosts: readonly string[]): ContainerAgentAdapter {
  return {
    kind: "container",
    name: "fake",
    identity: {
      provider: "test",
      model: "fake-v1",
      reasoning: "none",
      cliVersion: "test-cli-v1",
      surfacePolicies: { docs: "web disabled", mcp: "mcp only", cli: "cli only" },
      nativeWebControl: "controlled",
      reproducible: true,
    },
    requiredHostEnv: ["FAKE_PROVIDER_KEY"],
    egressHosts,
    setupFiles: () => ({}),
    command: () => ["sh", "-c", script],
    parseStream: parseClaudeStream,
  };
}

// The attempt script proves three things from INSIDE the container: no
// direct route (nc to a public IP fails), a denied host 403s through the
// proxy, and the proxy env was injected.
const PROBE_SCRIPT = [
  "(nc -z -w 3 1.1.1.1 443 && echo DIRECT_ROUTE_OPEN) || echo DIRECT_ROUTE_BLOCKED",
  "(wget -T 5 -q -O- http://denied.example/ 2>&1 && echo DENIED_HOST_FETCHED) || echo DENIED_AS_EXPECTED",
  'echo "proxy-env=$HTTP_PROXY"',
  "echo done > proof.txt",
  `echo '{"type":"result","num_turns":1,"usage":{"input_tokens":1,"output_tokens":1}}'`,
].join("; ");

describeEgress("egress proxy e2e (docker)", () => {
  test(
    "v3 proxied run: no direct route, deny-by-default through the proxy, allowlist audited, resources torn down",
    async () => {
      process.env["FAKE_PROVIDER_KEY"] = FAKE_PROVIDER_KEY;
      const { store, artifacts } = makeStores();
      try {
        const evals = discoverEgressEval();
        const experiments = [egressExperiment()];
        const summary = await executeRunV3({
          evals,
          experiments,
          plan: planRun(evals, experiments.map((entry) => entry.experiment), 1),
          store,
          artifacts,
          egressProxy: true,
          containerAdapters: { fake: () => makeFakeAdapter(PROBE_SCRIPT, ["harness-default.example"]) },
          log: silent,
        });
        expect(summary.total).toBe(1);
        expect(summary.passed).toBe(1);

        const attempt = store.listAttempts(summary.runId)[0]!;
        const transcript = readFileSync(attempt.transcriptRef as string, "utf8");
        // The isolation claim itself: the internal network has no route out.
        expect(transcript).toContain("DIRECT_ROUTE_BLOCKED");
        expect(transcript).not.toContain("DIRECT_ROUTE_OPEN");
        // Deny-by-default through the proxy, and env injection.
        expect(transcript).toContain("DENIED_AS_EXPECTED");
        expect(transcript).toMatch(/proxy-env=http:\/\/\d+\.\d+\.\d+\.\d+:3128/);

        // The COMPOSED allowlist (agent adapter + runtime layers) is
        // auditable in config_json.
        const run = store.getRun(summary.runId)!;
        expect(run.config.egress).toEqual({
          proxy: true,
          allowlist: ["harness-default.example", "pack-contributed.example"],
        });

        // Verifiable teardown: no run-labeled networks or sidecars remain.
        expect(await listRunNetworks()).toEqual([]);
        expect(await listRunContainers()).toEqual([]);
      } finally {
        store.close();
        delete process.env["FAKE_PROVIDER_KEY"];
      }
    },
    E2E_TIMEOUT,
  );

  test(
    "allowed path: an allowlisted host is reachable through the proxy (also after sidecar restart); others are not",
    async () => {
      const stamp = `e2e${Date.now()}`;
      const internalNet = await createRunNetwork(stamp);
      const originNet = `quickstudy-e2e-origin-${stamp}`;
      expect(docker("network", "create", originNet).exitCode).toBe(0);
      // The origin serves via bun from the (already required) proxy image —
      // alpine's busybox lacks the httpd applet, and this stays hermetic.
      const origin = docker(
        "run",
        "-d",
        "--network",
        originNet,
        "--network-alias",
        "origin",
        "--entrypoint",
        "bun",
        EGRESS_PROXY_IMAGE,
        "-e",
        'Bun.serve({ port: 8080, fetch: () => new Response("egress-e2e-origin-content\\n") }); console.log("origin up");',
      );
      expect(origin.exitCode).toBe(0);
      const originId = origin.stdout.trim();

      let sidecar: Awaited<ReturnType<typeof startEgressSidecar>> | undefined;
      let attempt: Awaited<ReturnType<typeof createAttemptContainer>> | undefined;
      try {
        sidecar = await startEgressSidecar({
          runId: stamp,
          networkName: internalNet,
          allowlist: ["origin"],
          image: EGRESS_PROXY_IMAGE,
        });
        // Give the proxy a face toward the hermetic "internet" (the origin).
        expect(docker("network", "connect", originNet, sidecar.id).exitCode).toBe(0);
        expect(await sidecar.isRunning()).toBeTrue();

        const fixtureDir = mkdtempSync(join(tmpdir(), "quickstudy-egress-fixture-"));
        writeFileSync(join(fixtureDir, "app.txt"), "fixture");
        attempt = await createAttemptContainer({
          image: TEST_IMAGE,
          env: sidecar.proxyEnv(),
          resultsDir: mkdtempSync(join(tmpdir(), "quickstudy-egress-results-")),
          attemptId: `test-${stamp}-allowed`,
          fixtureDir,
          network: internalNet,
        });

        // Allowlisted host: content comes back through the proxy.
        const allowed = await attempt.execInWorkspace(["wget", "-T", "8", "-q", "-O-", "http://origin:8080/"]);
        expect(allowed.exitCode).toBe(0);
        expect(allowed.stdout).toContain("egress-e2e-origin-content");

        // Same origin server, different (non-allowlisted) name: 403.
        const denied = await attempt.execInWorkspace(["wget", "-T", "8", "-q", "-O-", "http://not-origin:8080/"]);
        expect(denied.exitCode).not.toBe(0);

        // The mitigation path: restart the sidecar, the allowed path still works.
        await sidecar.restart();
        expect(await sidecar.isRunning()).toBeTrue();
        const afterRestart = await attempt.execInWorkspace([
          "sh",
          "-c",
          `HTTP_PROXY=http://${sidecar.ip}:${sidecar.port} http_proxy=http://${sidecar.ip}:${sidecar.port} wget -T 8 -q -O- http://origin:8080/`,
        ]);
        expect(afterRestart.exitCode).toBe(0);
        expect(afterRestart.stdout).toContain("egress-e2e-origin-content");

        // Decision log carries both verdicts.
        const logs = await sidecar.logs();
        expect(logs).toContain('"host":"origin","port":8080,"decision":"allowed"');
        expect(logs).toContain('"host":"not-origin","port":8080,"decision":"denied","reason":"not_allowlisted"');
      } finally {
        await attempt?.teardown();
        await sidecar?.teardown();
        await removeRunNetwork(internalNet);
        docker("rm", "-f", originId);
        docker("network", "rm", originNet);
      }
    },
    E2E_TIMEOUT,
  );
});
