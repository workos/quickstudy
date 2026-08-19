import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverEvals } from "../src/evals/discovery.ts";
import type { LoadedExperiment } from "../src/experiments/types.ts";
import { canonicalJson, diffIdentity } from "../src/identity-diff.ts";
import {
  attemptIdentityHash,
  buildRunManifest,
  MANIFEST_VERSION,
  type HarnessIdentity,
} from "../src/manifest.ts";

const HARNESS: HarnessIdentity = {
  version: "test",
  revision: "test",
  dirty: false,
  source: { sha256: "0".repeat(64) },
};

function makeFixture(): { root: string; evalsRoot: string; experimentsRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "qs-identity-v3-"));
  const evalsRoot = join(root, "evals");
  const dir = join(evalsRoot, "hello");
  mkdirSync(join(dir, "local"), { recursive: true });
  writeFileSync(join(dir, "PROMPT.md"), "---\nid: hello\nsuite: benchmark\n---\n\nWrite HELLO.md.\n");
  writeFileSync(join(dir, "EVAL.ts"), "export default async () => ({ passed: true, checks: [] });\n");
  writeFileSync(join(dir, "local", "seed.txt"), "seed\n");

  const experimentsRoot = join(root, "experiments");
  mkdirSync(experimentsRoot, { recursive: true });
  writeFileSync(
    join(experimentsRoot, "echo-x.ts"),
    `export default { id: "echo-x", agent: { adapter: "echo", model: "echo-v1" }, runtime: { kind: "host" } };\n`,
  );
  return { root, evalsRoot, experimentsRoot };
}

function loadExperiments(experimentsRoot: string): LoadedExperiment[] {
  const path = join(experimentsRoot, "echo-x.ts");
  return [
    {
      experiment: { id: "echo-x", agent: { adapter: "echo", model: "echo-v1" }, runtime: { kind: "host" } },
      path,
    },
  ];
}

function build(fixture: ReturnType<typeof makeFixture>) {
  return buildRunManifest({
    evals: discoverEvals(fixture.evalsRoot),
    experiments: loadExperiments(fixture.experimentsRoot),
    harness: HARNESS,
  });
}

describe("v3 run manifest", () => {
  test("canonical JSON is key-order independent and mismatch paths are precise", () => {
    // Ported from the deleted tests/experiment-identity.test.ts — the hashing
    // primitive it covered (src/identity-diff.ts) survives into v3.
    expect(canonicalJson({ b: 2, a: { y: 1, x: true } })).toBe(canonicalJson({ a: { x: true, y: 1 }, b: 2 }));
    expect(diffIdentity({ fixture: "a", agent: { model: "m" } }, { fixture: "b", agent: { model: "m" } }))
      .toEqual([{ path: "identity.fixture", a: "a", b: "b" }]);
  });

  test("component key sets are exhaustive snapshots — changing one is a deliberate act", () => {
    const manifest = build(makeFixture());
    expect(Object.keys(manifest).sort()).toEqual(["evals", "experiments", "harness", "hash", "images", "manifestVersion"]);
    expect(manifest.manifestVersion).toBe(MANIFEST_VERSION);

    const evalIdentity = manifest.evals["hello"]!;
    expect(Object.keys(evalIdentity).sort()).toEqual(["components", "hash", "id", "metadata"]);
    expect(Object.keys(evalIdentity.components).sort()).toEqual([
      "effectivePrompt",
      "local",
      "metadata",
      "promptSource",
      "scorer",
    ]);

    const experimentIdentity = manifest.experiments["echo-x"]!;
    expect(Object.keys(experimentIdentity).sort()).toEqual(["components", "hash", "id"]);
    expect(Object.keys(experimentIdentity.components).sort()).toEqual([
      "agent",
      "harness",
      "image",
      "runtime",
      "source",
      "treatment",
    ]);
    expect(Object.keys(experimentIdentity.components.agent).sort()).toEqual([
      "adapter",
      "cliVersion",
      "model",
      "provider",
      "reasoning",
    ]);

    // No legacy manifest components may survive into v3.
    for (const forbidden of ["pack", "packRuntime", "reference"]) {
      expect(manifest).not.toContainKey(forbidden);
      expect(evalIdentity.components).not.toContainKey(forbidden);
      expect(experimentIdentity.components).not.toContainKey(forbidden);
    }
  });

  test("hashes are stable across rebuilds and change with any content byte", () => {
    const fixture = makeFixture();
    const a = build(fixture);
    const b = build(fixture);
    expect(a.hash).toBe(b.hash);

    // One byte of prompt body.
    writeFileSync(join(fixture.evalsRoot, "hello", "PROMPT.md"), "---\nid: hello\nsuite: benchmark\n---\n\nWrite HELLO.md!\n");
    const promptChanged = build(fixture);
    expect(promptChanged.hash).not.toBe(a.hash);
    expect(promptChanged.evals["hello"]?.components.effectivePrompt).not.toBe(a.evals["hello"]?.components.effectivePrompt);
    expect(promptChanged.experiments["echo-x"]?.hash).toBe(a.experiments["echo-x"]?.hash);

    // One local/ file.
    writeFileSync(join(fixture.evalsRoot, "hello", "local", "seed.txt"), "different seed\n");
    const localChanged = build(fixture);
    expect(localChanged.evals["hello"]?.components.local).not.toBe(promptChanged.evals["hello"]?.components.local);

    // Experiment module source.
    writeFileSync(
      join(fixture.experimentsRoot, "echo-x.ts"),
      `export default { id: "echo-x", agent: { adapter: "echo", model: "echo-v2" }, runtime: { kind: "host" } };\n`,
    );
    const experimentChanged = build(fixture);
    expect(experimentChanged.experiments["echo-x"]?.components.source).not.toBe(localChanged.experiments["echo-x"]?.components.source);
    expect(experimentChanged.hash).not.toBe(localChanged.hash);
  });

  test("resolved image identities land in the manifest and change its hash", () => {
    const fixture = makeFixture();
    const base = build(fixture);
    expect(base.images).toEqual({});

    const identity = { tag: "qs/agent:latest", id: "sha256:" + "a".repeat(64), repoDigests: [] };
    const withImages = buildRunManifest({
      evals: discoverEvals(fixture.evalsRoot),
      experiments: loadExperiments(fixture.experimentsRoot),
      images: { "qs/agent:latest": identity },
      harness: HARNESS,
    });
    expect(withImages.images["qs/agent:latest"]).toEqual(identity);
    expect(withImages.hash).not.toBe(base.hash);
  });

  test("a probed cliVersion beats the experiment's declared string and changes its hash", () => {
    const fixture = makeFixture();
    const base = build(fixture);
    expect(base.experiments["echo-x"]?.components.agent.cliVersion).toBe("unspecified");

    const probed = buildRunManifest({
      evals: discoverEvals(fixture.evalsRoot),
      experiments: loadExperiments(fixture.experimentsRoot),
      cliVersions: { "echo-x": "9.9.9 (probed)" },
      harness: HARNESS,
    });
    expect(probed.experiments["echo-x"]?.components.agent.cliVersion).toBe("9.9.9 (probed)");
    expect(probed.experiments["echo-x"]?.hash).not.toBe(base.experiments["echo-x"]?.hash);
  });

  test("experiment config changes the experiment hash", () => {
    const fixture = makeFixture();
    const base = build(fixture);
    const tweaked = buildRunManifest({
      evals: discoverEvals(fixture.evalsRoot),
      experiments: [
        {
          experiment: {
            id: "echo-x",
            agent: { adapter: "echo", model: "echo-v1" },
            runtime: { kind: "host", config: { temperature: 1 } },
          },
          path: join(fixture.experimentsRoot, "echo-x.ts"),
        },
      ],
      harness: HARNESS,
    });
    expect(tweaked.experiments["echo-x"]?.components.runtime).not.toBe(base.experiments["echo-x"]?.components.runtime);
    expect(tweaked.hash).not.toBe(base.hash);
  });

  test("secret-pattern files in local/ never enter the hash (SECRET_FILE exclusion)", () => {
    const fixture = makeFixture();
    const before = build(fixture);
    // Ported from tests/experiment-identity.test.ts: differently named,
    // differently valued secret files must leave the digest untouched.
    writeFileSync(join(fixture.evalsRoot, "hello", "local", ".mcp-auth.env"), "REFRESH_TOKEN=secret-a");
    const withSecretA = build(fixture);
    expect(withSecretA.hash).toBe(before.hash);
    writeFileSync(join(fixture.evalsRoot, "hello", "local", "leaked-credentials.log"), "totally-different-secret-b");
    const withSecretB = build(fixture);
    expect(withSecretB.evals["hello"]?.components.local).toBe(before.evals["hello"]?.components.local);
  });

  test("attemptIdentityHash is stable per eval × experiment pair and shared across trials", () => {
    const fixture = makeFixture();
    const manifest = build(fixture);
    const trial0 = attemptIdentityHash({ evalId: "hello", experimentId: "echo-x", trialIndex: 0 }, manifest);
    const trial1 = attemptIdentityHash({ evalId: "hello", experimentId: "echo-x", trialIndex: 1 }, manifest);
    expect(trial0).toBe(trial1);
    expect(() => attemptIdentityHash({ evalId: "ghost", experimentId: "echo-x", trialIndex: 0 }, manifest)).toThrow(
      /eval "ghost" is not in the manifest/,
    );
    expect(() => attemptIdentityHash({ evalId: "hello", experimentId: "ghost", trialIndex: 0 }, manifest)).toThrow(
      /experiment "ghost" is not in the manifest/,
    );
  });
});
