/**
 * Ungraded checks: `graded: false` checks are recorded, tallied and exported
 * but never enter pass/fail; the report derives per-experiment SDK recall
 * from them, and the UI counts graded checks only.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedRun } from "../scripts/seed-run.ts";
import { selectDiagnosablePairs } from "../src/diagnose/select.ts";
import { validEvalResult } from "../src/evals/result.ts";
import { discoverEvals } from "../src/evals/discovery.ts";
import type { CheckResult } from "../src/evals/types.ts";
import { discoverExperiments } from "../src/experiments/discovery.ts";
import type { DataRun } from "../src/export-types.ts";
import { exportSite } from "../src/export.ts";
import { planRun } from "../src/plan.ts";
import {
  buildReport,
  collectPairs,
  collectRecall,
  findBannedLanguage,
  methodologyNote,
  renderReportText,
  REPORT_SCHEMA_VERSION,
  type ReportJson,
} from "../src/report/report.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore, type AttemptRecord } from "../src/store/db.ts";
import { countGradedChecks, isGraded } from "../ui/src/checks.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const silent = (): void => {};
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qs-graded-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

let seq = 0;
function attempt(experimentId: string, status: AttemptRecord["status"], passed: boolean, checks: CheckResult[]): AttemptRecord {
  seq += 1;
  return {
    id: `a${String(seq).padStart(4, "0")}`,
    runId: "run",
    evalId: "e1",
    experimentId,
    suite: "benchmark",
    trialIndex: seq,
    attemptIdentityHash: "h",
    status,
    result: status === "completed" ? { passed, checks } : null,
  } as AttemptRecord;
}

function seeded() {
  const root = tempRoot();
  const dbPath = join(root, "results.db");
  const resultsDir = join(root, "results");
  const { runId } = seedRun({ dbPath, resultsDir });
  return { root, resultsDir, runId, store: new ResultsStore(dbPath) };
}

describe("validation", () => {
  const base = (graded: unknown) => ({ passed: true, checks: [{ name: "sdk-wired", passed: false, graded }] });

  test("accepts absent, true and false graded flags", () => {
    expect(validEvalResult({ passed: true, checks: [{ name: "a", passed: true }] })).toBeTrue();
    expect(validEvalResult(base(true))).toBeTrue();
    expect(validEvalResult(base(false))).toBeTrue();
  });

  test("rejects a non-boolean graded flag", () => {
    expect(validEvalResult(base("no"))).toBeFalse();
    expect(validEvalResult(base(0))).toBeFalse();
    expect(validEvalResult(base(null))).toBeFalse();
  });
});

describe("report", () => {
  test("an ungraded failure is tallied without touching the pair's pass count", () => {
    const pairs = collectPairs([
      attempt("x", "completed", true, [{ name: "flow", passed: true }, { name: "sdk-wired", passed: false, graded: false }]),
      attempt("x", "incomplete", false, []),
      attempt("x", "error", false, []),
    ]);
    expect(pairs).toHaveLength(1);
    const pair = pairs[0]!;
    expect(pair.passed).toBe(1);
    expect(pair.checks).toEqual([
      { name: "flow", passed: 1, total: 1, graded: true },
      { name: "sdk-wired", passed: 0, total: 1, graded: false },
    ]);
  });

  test("a name ungraded in any attempt marks the whole tally ungraded", () => {
    const pairs = collectPairs([
      attempt("x", "completed", true, [{ name: "mixed", passed: true, graded: true }]),
      attempt("x", "completed", true, [{ name: "mixed", passed: false, graded: false }]),
    ]);
    expect(pairs[0]!.checks).toEqual([{ name: "mixed", passed: 1, total: 2, graded: false }]);
  });

  test("SDK recall counts scored attempts that recorded an ungraded check", () => {
    const attempts = [
      attempt("x", "completed", true, [{ name: "sdk-wired", passed: true, graded: false }]),
      attempt("x", "completed", false, [{ name: "sdk-wired", passed: false, graded: false }, { name: "flow", passed: false }]),
      // Not in the denominator: no ungraded check, or not scored.
      attempt("x", "completed", true, [{ name: "flow", passed: true }]),
      attempt("x", "incomplete", false, []),
      attempt("y", "completed", true, [{ name: "flow", passed: true }]),
    ];
    expect(collectRecall(attempts, "x")).toEqual({ attempts: 2, recalled: 1, rate: 0.5 });
    expect(collectRecall(attempts, "y")).toEqual({ attempts: 0, recalled: 0, rate: null });
  });

  test("the methodology sentence passes the language guard", () => {
    expect(methodologyNote(3)).toContain("SDK recall");
    expect(findBannedLanguage(methodologyNote(3))).toEqual([]);
    expect(findBannedLanguage(methodologyNote(1))).toEqual([]);
  });

  test("seeded run: mcp recalls every attempt, docs recalls none, text renders the line", () => {
    const { store, resultsDir, runId } = seeded();
    const report = buildReport({ store, runId, resultsDir });
    expect(report.schema_version).toBe(REPORT_SCHEMA_VERSION);
    const recallOf = (id: string) => report.experiments!.find((e) => e.experiment_id === id)!.sdk_recall!;
    expect(recallOf("claude-mcp").rate).toBe(1);
    expect(recallOf("claude-mcp").attempts).toBeGreaterThan(0);
    expect(recallOf("claude-docs")).toMatchObject({ recalled: 0, rate: 0 });
    const text = renderReportText(report);
    expect(text).toMatch(/sdk recall: \d+\/\d+ \(100%\)/);
    expect(text).toMatch(/sdk recall: 0\/\d+ \(0%\)/);
    store.close();
  });

  test("an older report without sdk_recall renders n/a", () => {
    const { store, resultsDir, runId } = seeded();
    const report = buildReport({ store, runId, resultsDir });
    const legacy = { ...report, experiments: report.experiments!.map(({ sdk_recall: _unused, ...rest }) => rest) } as ReportJson;
    expect(renderReportText(legacy)).toContain("sdk recall: n/a");
    store.close();
  });

  test("diagnosis lists only graded checks as failed", () => {
    const selection = selectDiagnosablePairs([
      attempt("x", "completed", false, [{ name: "flow", passed: false }, { name: "sdk-wired", passed: false, graded: false }]),
    ]);
    expect(selection.pairs[0]!.failedChecks).toEqual(["flow"]);
  });

  test("export rebuilds a stored report written under an older schema", async () => {
    const { store, resultsDir, runId, root } = seeded();
    const stale = { ...buildReport({ store, runId, resultsDir }), schema_version: 6, stale_marker: true };
    mkdirSync(join(resultsDir, runId), { recursive: true });
    writeFileSync(join(resultsDir, runId, "report.json"), JSON.stringify(stale), "utf8");
    const logs: string[] = [];
    const outDir = join(root, "site");
    await exportSite({ store, resultsDir, runIds: [runId], outDir, log: (message) => logs.push(message) });
    const exported = JSON.parse(readFileSync(join(outDir, "data", "runs", runId, "report.json"), "utf8")) as Record<string, unknown>;
    expect(exported["schema_version"]).toBe(REPORT_SCHEMA_VERSION);
    expect(exported["stale_marker"]).toBeUndefined();
    expect(logs.some((line) => line.includes("schema 6") && line.includes("rebuilding"))).toBeTrue();
    store.close();
  });
});

describe("invariant", () => {
  test("an attempt whose only failing check is ungraded scores passed=true end to end", async () => {
    const evalsRoot = tempRoot();
    cpSync(join(FIXTURES, "evals", "hello-local"), join(evalsRoot, "hello-local"), { recursive: true });
    writeFileSync(
      join(evalsRoot, "hello-local", "EVAL.ts"),
      `import type { CheckResult, EvalContext, EvalResult } from "quickstudy";
export default async function score(ctx: EvalContext): Promise<EvalResult> {
  const checks: CheckResult[] = [
    { name: "notes-written", passed: await ctx.fileExists("NOTES.md") },
    { name: "sdk-wired", passed: await ctx.fileExists("sdk.txt"), graded: false },
  ];
  const graded = checks.filter((c) => c.graded !== false);
  return { passed: graded.every((c) => c.passed), checks };
}
`,
    );
    const evals = discoverEvals(evalsRoot);
    const experiments = await discoverExperiments(join(FIXTURES, "experiments"));
    const plan = planRun(evals, experiments.map((entry) => entry.experiment), 1);
    const root = tempRoot();
    const store = new ResultsStore(join(root, "results.db"));
    const artifacts = new ArtifactsStore(join(root, "results"));
    const summary = await executeRunV3({ evals, experiments, plan, store, artifacts, log: silent });

    const [only] = store.listAttempts(summary.runId);
    expect(only?.status).toBe("completed");
    expect(only?.result?.passed).toBe(true);
    expect(only?.result?.checks.find((c) => c.name === "sdk-wired")).toMatchObject({ passed: false, graded: false });

    const report = buildReport({ store, runId: summary.runId, resultsDir: artifacts.rootDir });
    expect(report.pairs[0]!.passed).toBe(1);
    expect(report.experiments![0]!.sdk_recall).toEqual({ attempts: 1, recalled: 0, rate: 0 });

    const outDir = join(root, "site");
    await exportSite({ store, resultsDir: artifacts.rootDir, runIds: [summary.runId], outDir, log: silent });
    const runJson = JSON.parse(readFileSync(join(outDir, "data", "runs", summary.runId, "run.json"), "utf8")) as DataRun;
    expect(runJson.attempts[0]!.checks?.find((c) => c.name === "sdk-wired")?.graded).toBe(false);
    store.close();
  });
});

describe("matrix", () => {
  test("countGradedChecks ignores ungraded checks", () => {
    expect(countGradedChecks([{ name: "a", graded: false, passed: false }, { name: "b", passed: true }])).toEqual({ passed: 1, total: 1 });
    expect(countGradedChecks(null)).toEqual({ passed: 0, total: 0 });
    expect(isGraded({})).toBeTrue();
    expect(isGraded({ graded: true })).toBeTrue();
    expect(isGraded({ graded: false })).toBeFalse();
  });
});
