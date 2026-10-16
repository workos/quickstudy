import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalMetadata } from "../src/evals/types.ts";
import type { Runtime } from "../src/experiments/types.ts";
import { buildRunManifest, type HarnessIdentity } from "../src/manifest.ts";
import { resolveRuntimeCapacity } from "../src/runner/capacity.ts";
import { schedule } from "../src/runner/scheduler.ts";

const pooled: EvalMetadata = { id: "authkit-nextjs", suite: "benchmark", topics: ["authentication"] };
const accountless: EvalMetadata = { id: "authkit-nocreds-nextjs", suite: "benchmark", topics: ["no-credentials"] };

test("a static capacity applies to every eval", () => {
  const runtime: Runtime = { kind: "container", image: "x:1", capacity: { key: "pool", limit: 2 } };
  expect(resolveRuntimeCapacity(runtime, pooled)).toEqual({ key: "pool", limit: 2 });
  expect(resolveRuntimeCapacity(runtime, accountless)).toEqual({ key: "pool", limit: 2 });
});

test("a resolver decides per eval and can exempt one", () => {
  const seen: string[] = [];
  const runtime: Runtime = {
    kind: "container",
    image: "x:1",
    capacity: (metadata) => {
      seen.push(metadata.id);
      return metadata.topics?.includes("no-credentials") ? undefined : { key: "pool", limit: 2 };
    },
  };
  expect(resolveRuntimeCapacity(runtime, pooled)).toEqual({ key: "pool", limit: 2 });
  expect(resolveRuntimeCapacity(runtime, accountless)).toBeUndefined();
  expect(seen).toEqual(["authkit-nextjs", "authkit-nocreds-nextjs"]);
});

test("no runtime, no capacity, or no eval to ask about means no slot", () => {
  expect(resolveRuntimeCapacity(undefined, pooled)).toBeUndefined();
  expect(resolveRuntimeCapacity({ kind: "host" }, pooled)).toBeUndefined();
  expect(resolveRuntimeCapacity({ kind: "host", capacity: () => ({ key: "pool", limit: 1 }) }, undefined)).toBeUndefined();
});

test("a static capacity enters the experiment's identity; a resolver, like other capability functions, does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "qs-capacity-identity-"));
  const path = join(dir, "x.ts");
  writeFileSync(path, "export default {};\n");
  const harness: HarnessIdentity = { version: "test", revision: "test", dirty: false, source: { sha256: "0".repeat(64) } };
  const hashOf = (runtime: Runtime): string =>
    buildRunManifest({
      evals: [],
      experiments: [{ experiment: { id: "x", agent: { adapter: "echo", model: "echo-v1" }, runtime }, path }],
      harness,
    }).experiments["x"]!.components.runtime;
  const none = hashOf({ kind: "host" });
  const fixed = hashOf({ kind: "host", capacity: { key: "pool", limit: 2 } });
  const resolved = hashOf({ kind: "host", capacity: () => ({ key: "pool", limit: 2 }) });
  expect(fixed).not.toBe(none);
  expect(resolved).toBe(none);
});

test("through the scheduler: an exempt eval starts while the pool is full, and pooled attempts keep the limit", async () => {
  const runtime: Runtime = {
    kind: "container",
    image: "x:1",
    capacity: (metadata) => (metadata.topics?.includes("no-credentials") ? undefined : { key: "pool", limit: 1 }),
  };
  const metadataById: Record<string, EvalMetadata> = { "authkit-nextjs": pooled, "authkit-nocreds-nextjs": accountless };
  // Two pooled attempts and one exempt one; the first pooled attempt holds the only slot until released.
  const plan = [
    { evalId: "authkit-nextjs", experimentId: "x", trialIndex: 0 },
    { evalId: "authkit-nextjs", experimentId: "x", trialIndex: 1 },
    { evalId: "authkit-nocreds-nextjs", experimentId: "x", trialIndex: 0 },
  ];
  const started: string[] = [];
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let activePooled = 0;
  let peakPooled = 0;
  const run = schedule(
    plan,
    3,
    async (entry) => {
      started.push(`${entry.evalId}#${entry.trialIndex}`);
      const pooledEntry = entry.evalId === "authkit-nextjs";
      if (pooledEntry) {
        activePooled += 1;
        peakPooled = Math.max(peakPooled, activePooled);
      }
      if (entry.trialIndex === 0 && pooledEntry) await held;
      else await Bun.sleep(5);
      if (pooledEntry) activePooled -= 1;
    },
    { capacity: (entry) => resolveRuntimeCapacity(runtime, metadataById[entry.evalId]) },
  );
  await Bun.sleep(25);
  // The exempt attempt is running beside the slot holder; the second pooled attempt waits.
  expect(started).toEqual(["authkit-nextjs#0", "authkit-nocreds-nextjs#0"]);
  release();
  await run;
  expect(started).toEqual(["authkit-nextjs#0", "authkit-nocreds-nextjs#0", "authkit-nextjs#1"]);
  expect(peakPooled).toBe(1);
});
