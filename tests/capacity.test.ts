import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalMetadata } from "../src/evals/types.ts";
import type { Runtime } from "../src/experiments/types.ts";
import { buildRunManifest, type HarnessIdentity } from "../src/manifest.ts";
import { resolveRuntimeCapacity } from "../src/runner/capacity.ts";

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
