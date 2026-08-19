import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveImagesRoot } from "../src/isolation/images.ts";

describe("resolveImagesRoot", () => {
  test("with no override, materializes the embedded contexts (never the checkout)", () => {
    const root = resolveImagesRoot();
    expect(existsSync(join(root, "images", "agent-runtime", "Dockerfile"))).toBe(true);
    // Embedded-only by design: the checkout is not consulted, so the same
    // contexts build everywhere. --images-dir is the sole override.
    expect(root).not.toBe(resolve(import.meta.dir, ".."));
  });

  test("an explicit override wins and is resolved to an absolute path", () => {
    expect(resolveImagesRoot("/tmp/somewhere")).toBe(resolve("/tmp/somewhere"));
    const rel = resolveImagesRoot("relative/dir");
    expect(isAbsolute(rel)).toBe(true);
    expect(rel).toBe(resolve("relative/dir"));
  });
});
