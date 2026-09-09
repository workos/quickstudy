#!/usr/bin/env bun
/** Run the shipped example from an isolated consumer directory using package imports. */
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const packageRoot = resolve(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "qs-portable-consumer-"));
try {
  cpSync(join(packageRoot, "examples/harbor-notes"), root, {
    recursive: true,
    filter: (p) => !p.includes("node_modules") && !p.includes("results"),
  });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(packageRoot, join(root, "node_modules/quickstudy"), "dir");
  for (const args of [
    ["validate"],
    ["run", "--trials", "2", "--egress-proxy", "--concurrency", "2"],
    ["report", "--latest", "--strict"],
  ]) {
    const proc = Bun.spawn([process.execPath, join(root, "node_modules/quickstudy/src/cli.ts"), ...args], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) !== 0) throw new Error(`portable example failed: ${args.join(" ")}`);
  }
  console.log("portable consumer example passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
