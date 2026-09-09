import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedRun } from "../scripts/seed-run.ts";
import { ResultsStore } from "../src/store/db.ts";
import { trialCoverage } from "../src/completeness.ts";
import { buildReport } from "../src/report/report.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qs-coverage-"));
  roots.push(root);
  const dbPath = join(root, "results.db");
  const resultsDir = join(root, "results");
  const { runId } = seedRun({ dbPath, resultsDir });
  const store = new ResultsStore(dbPath);
  const run = store.getRun(runId)!;
  const rows = store.listAttempts(runId);
  const first = rows[0]!;
  run.config = { trials: 2, evalIds: [first.evalId], experimentIds: [first.experimentId] };
  const good = [0, 1].map((trialIndex) => ({
    ...first,
    id: `trial-${trialIndex}`,
    trialIndex,
    status: "completed" as const,
    result: { passed: false, checks: [{ name: "outcome", passed: false }] },
  }));
  return { root, dbPath, resultsDir, runId, run, store, good };
}
test("distinct scored failures are complete; duplicates, gaps, invalid results and timeouts are not", () => {
  const { run, store, good } = fixture();
  try {
    expect(trialCoverage(run, good)[0]!.complete).toBe(true);
    expect(trialCoverage(run, [good[0]!, good[0]!])[0]!.reasons).toEqual(["duplicate trial 0", "missing trial 1"]);
    expect(trialCoverage(run, [good[0]!, { ...good[1]!, status: "incomplete", result: null }])[0]!.complete).toBe(
      false,
    );
    expect(trialCoverage(run, [good[0]!, { ...good[1]!, result: null }])[0]!.complete).toBe(false);
    expect(trialCoverage(run, [])[0]!.reasons).toHaveLength(2);
    expect(trialCoverage(run, [...good, { ...good[0]!, trialIndex: 5 }])[0]!.reasons).toContain(
      "unexpected trial index",
    );
  } finally {
    store.close();
  }
});
test("a finished timeout-only run fails report --strict and retains its diagnostic report", () => {
  const { root, dbPath, resultsDir, run, store, good } = fixture();
  const runId = "timeout-only";
  store.insertRun({ ...run, id: runId });
  for (const row of good)
    store.insertAttempt({ ...row, id: `timeout-${row.id}`, runId, status: "incomplete", result: null });
  store.finishRun(runId, Date.now());
  expect(buildReport({ store, resultsDir, runId }).incomplete).toBe(true);
  store.close();
  const cli = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../src/cli.ts"),
      "report",
      runId,
      "--strict",
      "--db",
      dbPath,
      "--results",
      resultsDir,
    ],
    { cwd: root },
  );
  expect(cli.exitCode).not.toBe(0);
  expect(cli.stderr.toString()).toContain("not publishable");
  expect(cli.stdout.toString()).toContain("trial 0: incomplete");
});
