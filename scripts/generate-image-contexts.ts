#!/usr/bin/env bun
/**
 * Generate `src/isolation/image-contexts.generated.ts` — the harness image
 * build contexts (the `images/star/` Dockerfiles plus the proxy sources their
 * builds COPY), embedded so the compiled single-file binary can run
 * `images build` with no checkout on disk: the CLI materializes these files
 * into a temp directory and hands that to `docker build`.
 *
 * Committed populated: regeneration is
 * idempotent, so a clean tree stays clean — a diff means the committed module
 * had drifted from its sources (tests/image-contexts.test.ts re-runs
 * buildContexts and deep-equals it against the committed module).
 *
 *   bun scripts/generate-image-contexts.ts
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const GENERATED = join(ROOT, "src/isolation/image-contexts.generated.ts");

/**
 * The directories `docker build` needs, repo-relative. Materialization
 * mirrors this exact layout, so `imagePaths()` resolves identically against
 * a checkout and against a materialized temp root.
 */
const CONTEXT_DIRS = [
  "images/agent-runtime",
  "images/egress-proxy",
  "images/mcp-proxy",
  "src/isolation/proxy",
  "src/isolation/mcp-proxy",
] as const;

/** Walk a directory into sorted, POSIX-separated relative paths (dotfiles skipped). */
function walkFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Build the embedded map: repo-relative POSIX path → file contents. */
export function buildContexts(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const contextDir of CONTEXT_DIRS) {
    for (const rel of walkFiles(join(ROOT, contextDir))) {
      files[`${contextDir}/${rel}`] = readFileSync(join(ROOT, contextDir, rel), "utf8");
    }
  }
  return files;
}

/** Escape file contents for embedding in a backtick template literal. */
function escapeForTemplateLiteral(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

/** Render the generated module's source text. */
export function renderModule(files: Record<string, string>): string {
  const entries = Object.entries(files)
    .map(([path, contents]) => `  ${JSON.stringify(path)}: \`${escapeForTemplateLiteral(contents)}\`,`)
    .join("\n");
  return `/**
 * AUTO-GENERATED — do not edit by hand.
 *
 * The harness image build contexts (Dockerfiles + the proxy sources they
 * COPY), embedded so the compiled binary can \`images build\` without a
 * checkout: resolveImagesRoot materializes these into a temp directory and
 * \`docker build\` runs against that. Paths are repo-relative and mirror the
 * source tree exactly.
 *
 * Regenerate with: bun scripts/generate-image-contexts.ts
 * (tests/image-contexts.test.ts fails when this module drifts from source.)
 */

export const IMAGE_CONTEXT_FILES: Record<string, string> = {
${entries}
};
`;
}

if (import.meta.main) {
  const files = buildContexts();
  writeFileSync(GENERATED, renderModule(files));
  console.log(`generated ${GENERATED} (${Object.keys(files).length} files)`);
}
