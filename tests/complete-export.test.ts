import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverEvals } from "../src/evals/discovery.ts";
import { buildRunManifest, attemptIdentityHash } from "../src/manifest.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore } from "../src/store/db.ts";
import { buildReport } from "../src/report/report.ts";
import { exportSite } from "../src/export.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { planRun } from "../src/plan.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qs-publish-"));
  roots.push(root);
  for (const id of ["complete", "partial"]) {
    const dir = join(root, "evals", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PROMPT.md"), `---\nid: ${id}\nsuite: benchmark\n---\nTry.`);
    writeFileSync(
      join(dir, "EVAL.ts"),
      'export default async () => ({ passed: false, checks: [{name:"outcome",passed:false}] });',
    );
  }
  const path = join(root, "experiment.ts");
  writeFileSync(path, "export default {};");
  const experiments = [
    { path, experiment: { id: "echo", agent: { adapter: "echo" }, runtime: { kind: "host" as const } } },
  ];
  const evals = discoverEvals(join(root, "evals"));
  const manifest = buildRunManifest({ evals, experiments });
  const store = new ResultsStore(join(root, "results.db"));
  store.insertRun({
    id: "source",
    startedAt: 1,
    config: { trials: 2, evalIds: ["complete", "partial"], experimentIds: ["echo"] },
    manifest,
  });
  for (const evalId of ["complete", "partial"])
    for (const trialIndex of [0, 1]) {
      if (evalId === "partial" && trialIndex === 1) continue;
      store.insertAttempt({
        id: `${evalId}-${trialIndex}`,
        runId: "source",
        evalId,
        experimentId: "echo",
        trialIndex,
        suite: "benchmark",
        status: "completed",
        result: { passed: false, checks: [{ name: "outcome", passed: false }] },
        attemptIdentityHash: attemptIdentityHash({ evalId, experimentId: "echo", trialIndex }, manifest),
      });
    }
  store.finishRun("source", 2);
  return { root, store, evals, experiments };
}
test("complete-sample export excludes gaps, keeps failures and discloses omitted source samples", async () => {
  const { root, store } = fixture();
  try {
    const outDir = join(root, "site");
    await exportSite({ store, resultsDir: root, runIds: ["source"], outDir, expectedTrials: 2, log: () => {} });
    const report = JSON.parse(readFileSync(join(outDir, "data/runs/source/report.json"), "utf8"));
    expect(report.totals.failed).toBe(2);
    expect(report.totals.passed).toBe(0);
    expect(report.publication.source_totals.attempts).toBe(3);
    expect(report.publication.omitted[0].reasons).toEqual(["missing trial 1"]);
    expect(readFileSync(join(outDir, "data/runs/source/omissions.txt"), "utf8")).toContain(
      "partial × echo: missing trial 1",
    );
    expect(store.listAttempts("source")).toHaveLength(3);
    const data = JSON.parse(readFileSync(join(outDir, "data/runs/source/run.json"), "utf8"));
    expect(data.attempts).toHaveLength(2);
    expect(data.excluded_attempts).toHaveLength(1);
    await expect(
      exportSite({ store, resultsDir: root, runIds: ["source"], outDir: join(root, "empty"), expectedTrials: 3 }),
    ).rejects.toThrow("no eligible complete samples");
  } finally {
    store.close();
  }
});
test("duplicate coordinates and changed attempt identity cannot qualify for publication", () => {
  const { root, store } = fixture();
  try {
    const first = store.listAttempts("source")[0]!;
    store.insertAttempt({ ...first, id: "duplicate" });
    expect(() => buildReport({ store, runId: "source", resultsDir: root, expectedTrials: 2 })).toThrow(
      "duplicate trial",
    );
    const run = store.getRun("source")!;
    store.insertRun({ ...run, id: "drift" });
    for (const row of store.listAttempts("source").filter((a) => a.id !== "duplicate"))
      store.insertAttempt({ ...row, id: `drift-${row.id}`, runId: "drift", attemptIdentityHash: "changed" });
    expect(() => buildReport({ store, runId: "drift", resultsDir: root, expectedTrials: 2 })).toThrow(
      "identity mismatch",
    );
  } finally {
    store.close();
  }
});
test("interruption then resume exports a fully scored failing sample", async () => {
  const { root, store, evals, experiments } = fixture();
  const controller = new AbortController();
  controller.abort();
  const options = {
    evals,
    experiments,
    store,
    artifacts: new ArtifactsStore(join(root, "results")),
    plan: planRun(
      evals,
      experiments.map((e) => e.experiment),
      2,
    ),
    log: () => {},
  };
  try {
    const first = await executeRunV3({ ...options, signal: controller.signal });
    const resumed = await executeRunV3({ ...options, resumeRunId: first.runId });
    expect(resumed.failed).toBe(4);
    const summary = await exportSite({
      store,
      resultsDir: options.artifacts.rootDir,
      runIds: [first.runId],
      outDir: join(root, "resumed"),
      expectedTrials: 2,
    });
    expect(summary.attempts).toBe(4);
  } finally {
    store.close();
  }
});

test("modern exports regenerate stale reports and retain the prior coherent snapshot", async () => {
  const { root, store } = fixture();
  try {
    const resultsDir = join(root, "results");
    mkdirSync(join(resultsDir, "source"), { recursive: true });
    const stale = buildReport({ store, runId: "source", resultsDir });
    writeFileSync(join(resultsDir, "source/report.json"), JSON.stringify(stale));
    const outDir = join(root, "site");
    await exportSite({ store, resultsDir, runIds: ["source"], outDir, mode: "hosted", log: () => {} });
    const oldMeta = JSON.parse(readFileSync(join(outDir, "data/meta.json"), "utf8"));
    const row = store.listAttempts("source").find((r) => r.evalId === "partial")!;
    store.insertAttempt({ ...row, id: "partial-1", trialIndex: 1 });
    await exportSite({ store, resultsDir, runIds: ["source"], outDir, mode: "hosted", log: () => {} });
    const fresh = JSON.parse(readFileSync(join(outDir, "data/runs/source/report.json"), "utf8"));
    expect(fresh.incomplete).toBe(false);
    expect(fresh.totals.attempts).toBe(4);
    const newMeta = JSON.parse(readFileSync(join(outDir, "data/meta.json"), "utf8"));
    expect(newMeta.run_paths.source).not.toBe(oldMeta.run_paths.source);
    const retained = JSON.parse(readFileSync(join(outDir, "data", oldMeta.run_paths.source, "report.json"), "utf8"));
    expect(retained.incomplete).toBe(true);
    expect(retained.totals.attempts).toBe(3);
  } finally {
    store.close();
  }
});
