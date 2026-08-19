/**
 * The embedded image build contexts: the drift guard (committed module ===
 * regenerated from source) and the materialization path the compiled binary
 * takes when `images build` runs outside a checkout.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildContexts } from "../scripts/generate-image-contexts.ts";
import { IMAGE_CONTEXT_FILES } from "../src/isolation/image-contexts.generated.ts";
import { materializeEmbeddedContexts } from "../src/isolation/images.ts";

describe("embedded image contexts", () => {
  test("committed module matches a fresh regeneration (drift guard)", () => {
    expect(IMAGE_CONTEXT_FILES).toEqual(buildContexts());
  });

  test("every docker build entry point is embedded", () => {
    for (const dockerfile of [
      "images/agent-runtime/Dockerfile",
      "images/egress-proxy/Dockerfile",
      "images/mcp-proxy/Dockerfile",
    ]) {
      expect(IMAGE_CONTEXT_FILES[dockerfile]).toBeDefined();
    }
  });

  test("materialization mirrors the repo layout and is shared per process", () => {
    const root = materializeEmbeddedContexts();
    for (const [rel, contents] of Object.entries(IMAGE_CONTEXT_FILES)) {
      const abs = join(root, rel);
      expect(existsSync(abs)).toBeTrue();
      expect(readFileSync(abs, "utf8")).toBe(contents);
    }
    // The three image builds of one `images build` share the directory.
    expect(materializeEmbeddedContexts()).toBe(root);
  });
});
