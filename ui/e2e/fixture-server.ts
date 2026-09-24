#!/usr/bin/env bun
/**
 * E2E fixture server: seed → export (real pipeline, real ui/dist bundle) →
 * serve. Three sites under ui/e2e/.fixtures:
 *
 *   /site           three runs (full sweep + cell-states + trials-1), groups + reports wired
 *   /site-mismatch  same site with schemaVersion bumped → error banner
 *   /site-empty     zero runs → friendly empty state
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedSite } from "../../scripts/seed-site.ts";
import { exportSite } from "../../src/export.ts";
import { serveSite } from "../../src/serve.ts";
import { ResultsStore } from "../../src/store/db.ts";
import { FIXTURE_PORT } from "./playwright.config.ts";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(E2E_DIR, ".fixtures");
const BUNDLE_DIR = join(E2E_DIR, "../dist");

rmSync(FIXTURES, { recursive: true, force: true });
mkdirSync(join(FIXTURES, "seed"), { recursive: true });

const seeded = seedSite(join(FIXTURES, "seed"));
const store = new ResultsStore(seeded.dbPath);
try {
  await exportSite({
    store,
    resultsDir: seeded.resultsDir,
    runIds: seeded.runIds,
    outDir: join(FIXTURES, "site"),
    bundleDir: BUNDLE_DIR,
  });
  await exportSite({ store, resultsDir: seeded.resultsDir, runIds: seeded.runIds, outDir: join(FIXTURES, "site-hosted"), bundleDir: BUNDLE_DIR, mode: "hosted" });
  const original = store.getRun(seeded.runIds[0]!)!;
  const originalAttempts = store.listAttempts(original.id);
  for (const suite of ["regression", "other"] as const) {
    const manifest = structuredClone(original.manifest);
    for (const entry of Object.values(manifest.evals)) entry.metadata = { ...entry.metadata, suite, product: suite, framework: suite, topics: [suite] };
    store.insertRun({ id: suite, startedAt: original.startedAt, config: original.config, manifest });
    for (const row of originalAttempts) store.insertAttempt({ ...row, id: `${suite}-${row.id}`, runId: suite, suite });
    store.finishRun(suite, Date.now());
  }
  await exportSite({ store, resultsDir: seeded.resultsDir, runIds: [original.id, "regression", "other"], outDir: join(FIXTURES, "site-single"), bundleDir: BUNDLE_DIR });
  await exportSite({
    store,
    resultsDir: seeded.resultsDir,
    runIds: [],
    outDir: join(FIXTURES, "site-empty"),
    bundleDir: BUNDLE_DIR,
  });
} finally {
  store.close();
}

// The mismatch site: bump schemaVersion in both the fetched meta.json and the
// inlined index (the UI prefers the inline copy). Match any current integer so
// the fixture remains a real mismatch when the supported schema advances.
const mismatchDir = join(FIXTURES, "site-mismatch");
cpSync(join(FIXTURES, "site"), mismatchDir, { recursive: true });
const metaPath = join(mismatchDir, "data", "meta.json");
const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { schemaVersion: number };
meta.schemaVersion = 999;
writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
const indexPath = join(mismatchDir, "index.html");
const index = readFileSync(indexPath, "utf8");
const mismatchedIndex = index.replace(/"meta":\{"schemaVersion":\d+/, '"meta":{"schemaVersion":999');
if (mismatchedIndex === index) throw new Error("schema mismatch fixture could not find the inlined meta schemaVersion");
writeFileSync(
  indexPath,
  mismatchedIndex,
  "utf8",
);

const server = serveSite(FIXTURES, FIXTURE_PORT);
console.log(
  `fixture server: ${server.url} (sweep run ${seeded.runIds[0]}, cell-states run ${seeded.runIds[1]}, trials-1 run ${seeded.runIds[2]})`,
);

// Serve until Playwright tears the process down.
await new Promise(() => {});
