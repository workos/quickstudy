#!/usr/bin/env bun
/**
 * Regenerate the committed `ui/dev-data/` directory: the seeded data dir the
 * Vite dev server serves at /data, so UI contributors run `bun run ui:dev`
 * with zero setup — no Docker, no agents, no API keys.
 *
 *   bun run ui:dev-data
 *
 * Generation is deterministic (seeded ids, fixed timestamps): regenerating
 * produces a byte-identical tree unless the seed content or export shape
 * changed — so a diff here IS the review surface for such changes.
 */

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSite } from "../src/export.ts";
import { ResultsStore } from "../src/store/db.ts";
import { SEED_GENERATED_AT } from "./seed-run.ts";
import { seedSite } from "./seed-site.ts";

const DEV_DATA_DIR = join(import.meta.dir, "../ui/dev-data");

const scratch = mkdtempSync(join(tmpdir(), "quickstudy-dev-data-"));
try {
  const seeded = seedSite(scratch);
  const store = new ResultsStore(seeded.dbPath);
  try {
    const outDir = join(scratch, "site");
    const summary = await exportSite({
      store,
      resultsDir: seeded.resultsDir,
      runIds: seeded.runIds,
      outDir,
      generatedAt: SEED_GENERATED_AT,
      // Data dir only — the bundle never belongs in dev-data.
    });
    rmSync(DEV_DATA_DIR, { recursive: true, force: true });
    cpSync(summary.dataDir, DEV_DATA_DIR, { recursive: true });
    console.log(
      `ui/dev-data regenerated: ${summary.runs} runs, ${summary.attempts} attempts ` +
        `(long transcript on attempt ${seeded.longTranscriptAttemptId})`,
    );
    console.log("next: bun run ui:dev");
  } finally {
    store.close();
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
