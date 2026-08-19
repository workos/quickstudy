/**
 * Harness genericity: no consumer (vendor) name may appear in shipped
 * harness code — src/, the UI source, or scripts/. The contract's criterion
 * greps src/ only; this test widens the boundary so consumer-specific
 * strings can't leak into the shippable UI or shared tooling. Tests,
 * evals/, scorers/, runtime/, and experiments/ are deliberately out of
 * scope: consumer content may name its vendor freely.
 *
 * The forbidden names are an explicit list (the deleted packs/ directory
 * used to derive them); extend it when a second consumer lands.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCAN_ROOTS = ["src", "ui/src", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "__fixtures__", "__snapshots__", ".fixtures"]);
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".css", ".md", ".json", ".html", ".yml", ".yaml"]);

/** Explicit; extend when a second consumer lands. */
const CONSUMER_NAMES = ["workos"];

function collectFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectFiles(path, out);
    } else if (TEXT_EXTENSIONS.has(extname(entry.name))) {
      out.push(path);
    }
  }
  return out;
}

describe("harness genericity", () => {
  test("no consumer name appears in shipped harness code (src, ui/src, scripts)", () => {
    // Guard: an emptied list would scan for nothing and pass vacuously.
    expect(CONSUMER_NAMES.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of collectFiles(join(ROOT, root), [])) {
        const content = readFileSync(file, "utf8").toLowerCase();
        for (const name of CONSUMER_NAMES) {
          if (content.includes(name)) offenders.push(`${relative(ROOT, file)} mentions "${name}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
