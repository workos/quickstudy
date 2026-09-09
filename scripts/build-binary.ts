#!/usr/bin/env bun
/**
 * Build the self-contained `quickstudy` binary.
 *
 * `bun build --compile` bundles the CLI into one executable, but the UI shell
 * (`ui/dist/index.html`) is read from disk at runtime and isn't part of that
 * bundle. So this script base64-embeds it into `src/ui-bundle.generated.ts`
 * for the duration of the compile, then restores that file's committed
 * placeholder so the working tree stays clean.
 *
 * Usage:
 *   bun scripts/build-binary.ts [--target <bun-target>] [--outfile <path>]
 *
 * `--target` cross-compiles (e.g. bun-darwin-arm64, bun-linux-x64); omit it to
 * build for the host. Cross-compiled macOS binaries must be smoke-tested on
 * native hardware before release (Bun Mach-O signing has regressed before).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashTree } from "../src/hash.ts";

const ROOT = join(import.meta.dir, "..");
const GENERATED = join(ROOT, "src/ui-bundle.generated.ts");
const UI_INDEX = join(ROOT, "ui/dist/index.html");
const BUILD_INFO = join(ROOT, "src/build-info.generated.ts");

/** package.json is the single source of truth for the released version. */
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

function flag(name: string, fallback: string): string {
  const i = Bun.argv.indexOf(name);
  return i >= 0 && Bun.argv[i + 1] ? Bun.argv[i + 1]! : fallback;
}

const target = flag("--target", "");
const outfile = flag("--outfile", join(ROOT, "dist/quickstudy"));

// 1. Build the UI bundle (produces ui/dist/index.html).
console.log("• building UI bundle (bun run ui:build)…");
if (Bun.spawnSync(["bun", "run", "ui:build"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode !== 0) {
  console.error("ui:build failed");
  process.exit(1);
}

// 2. Regenerate the embedded image build contexts so the binary must
//    `images build` from contexts matching this source tree. The module is
//    committed populated and there is no restore step: regeneration is
//    idempotent, so a clean tree stays clean — a diff here means the
//    committed module had drifted (tests/image-contexts.test.ts catches that).
console.log("• regenerating image contexts (bun scripts/generate-image-contexts.ts)…");
if (
  Bun.spawnSync(["bun", join(ROOT, "scripts/generate-image-contexts.ts")], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode !== 0
) {
  console.error("image contexts regeneration failed");
  process.exit(1);
}

// 3. Embed the UI shell, keeping the committed placeholder for restore.
const placeholder = readFileSync(GENERATED, "utf8");
const buildInfoPlaceholder = readFileSync(BUILD_INFO, "utf8");
const base64 = readFileSync(UI_INDEX).toString("base64");
const populated = placeholder.replace(
  /export const UI_INDEX_HTML_BASE64 = "[^"]*";/,
  `export const UI_INDEX_HTML_BASE64 = ${JSON.stringify(base64)};`,
);
if (populated === placeholder) {
  console.error(`could not find the UI_INDEX_HTML_BASE64 marker in ${GENERATED}`);
  process.exit(1);
}

let failed = false;
try {
  const revisionResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "ignore" });
  const statusResult = Bun.spawnSync(
    ["git", "status", "--porcelain", "--untracked-files=all", "--", "src", "package.json", "bun.lock"],
    { cwd: ROOT, stdout: "pipe", stderr: "ignore" },
  );
  const revision = revisionResult.exitCode === 0 ? revisionResult.stdout.toString().trim() : "unversioned";
  const dirty = statusResult.exitCode !== 0 || statusResult.stdout.toString().trim() !== "";
  const sourceHash = hashTree(join(ROOT, "src")).sha256;
  writeFileSync(
    BUILD_INFO,
    `/** Generated for the compiled binary; restored after build. */\n` +
      `export const EMBEDDED_BUILD_INFO = ${JSON.stringify({ version: VERSION, revision, dirty, sourceHash }, null, 2)} as const;\n`,
  );
  writeFileSync(GENERATED, populated);
  console.log(`• embedded UI shell (${(base64.length / 1024).toFixed(0)} KB base64)`);

  mkdirSync(dirname(outfile), { recursive: true });
  const cmd = ["bun", "build", "--compile", "./src/cli.ts", "./src/runner/scorer-worker.ts", "--outfile", outfile];
  if (target) cmd.push(`--target=${target}`);
  console.log(`• ${cmd.join(" ")}`);
  failed = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode !== 0;
} finally {
  // Restore the committed placeholder (runs even if the compile threw — but NOT
  // if we process.exit inside the try, which is why we defer the exit below).
  writeFileSync(GENERATED, placeholder);
  writeFileSync(BUILD_INFO, buildInfoPlaceholder);
}

if (failed) {
  console.error("compile failed");
  process.exit(1);
}
console.log(`✓ built ${outfile}`);
