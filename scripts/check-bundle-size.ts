#!/usr/bin/env bun
/**
 * Bundle-size budget check, run by `bun run ui:build` after `vite build`.
 * Dependency bloat is a spec failure mode: casually pulled chart/diff libs
 * make every exported site slow to load and heavy to share. Warns (exit 0)
 * above the budget so CI output flags the regression loudly without blocking
 * a release on a few kilobytes.
 */

import { gzipSync } from "bun";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BUDGET_GZIP_BYTES = 1.5 * 1024 * 1024;

const distDir = join(import.meta.dir, "../ui/dist");

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

let total = 0;
let files: string[];
try {
  files = walk(distDir);
} catch {
  console.error(`check-bundle-size: no ui/dist at ${distDir} — run \`bun run ui:build\` first`);
  process.exit(1);
}

for (const file of files) {
  total += gzipSync(readFileSync(file)).byteLength;
}

const mb = (total / (1024 * 1024)).toFixed(2);
if (total > BUDGET_GZIP_BYTES) {
  console.warn(`⚠️  ui/dist is ${mb} MB gzipped — over the 1.50 MB budget. A dependency probably snuck in; check the vite build output.`);
} else {
  console.log(`ui/dist bundle: ${mb} MB gzipped (budget 1.50 MB) — OK`);
}
