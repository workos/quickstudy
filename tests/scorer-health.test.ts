/**
 * Eval bands and scorer health: per-eval bands over scored arms, suspects
 * that failed under every arm while another graded check passed, the
 * language guard on the fixed summary, and the wiring into report.json and
 * the text renderer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedRun } from "../scripts/seed-run.ts";
import { seedSite } from "../scripts/seed-site.ts";
import type { CheckResult } from "../src/evals/types.ts";
import {
  buildReport,
  collectPairs,
  findBannedLanguage,
  methodologyNote,
  renderReportText,
  REPORT_SCHEMA_VERSION,
  type ReportJson,
} from "../src/report/report.ts";
import { collectBands, collectScorerHealth } from "../src/report/scorer-health.ts";
import { ResultsStore, type AttemptRecord } from "../src/store/db.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qs-scorer-health-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

let seq = 0;
function attempt(
  evalId: string,
  experimentId: string,
  status: AttemptRecord["status"],
  passed: boolean,
  checks: CheckResult[] = [],
): AttemptRecord {
  seq += 1;
  return {
    id: `a${String(seq).padStart(4, "0")}`,
    runId: "run",
    evalId,
    experimentId,
    suite: "benchmark",
    trialIndex: seq,
    attemptIdentityHash: "h",
    status,
    result: status === "completed" ? { passed, checks } : null,
  } as AttemptRecord;
}

/** `n` completed attempts of one pair with the given outcome and checks. */
function trials(evalId: string, experimentId: string, outcomes: boolean[], checks: (i: number) => CheckResult[] = () => []): AttemptRecord[] {
  return outcomes.map((passed, i) => attempt(evalId, experimentId, "completed", passed, checks(i)));
}

function bandOf(attempts: AttemptRecord[], evalId = "e1") {
  return collectBands(collectPairs(attempts)).get(evalId);
}

describe("bands", () => {
  test("two arms both at 1.0 → solved-by-all", () => {
    expect(bandOf([...trials("e1", "x", [true, true]), ...trials("e1", "y", [true])])).toBe("solved-by-all");
  });

  test("two arms both at 0 → failed-by-all", () => {
    expect(bandOf([...trials("e1", "x", [false, false]), ...trials("e1", "y", [false])])).toBe("failed-by-all");
  });

  test("1.0 against 0.5 → discriminating", () => {
    expect(bandOf([...trials("e1", "x", [true, true]), ...trials("e1", "y", [true, false])])).toBe("discriminating");
  });

  test("one scored arm → null", () => {
    expect(bandOf(trials("e1", "x", [true, true]))).toBeNull();
  });

  test("an arm with scored 0 (all errors) is ignored in the decision", () => {
    const attempts = [
      ...trials("e1", "x", [true]),
      ...trials("e1", "y", [true]),
      attempt("e1", "z", "error", false),
      attempt("e1", "z", "incomplete", false),
    ];
    expect(bandOf(attempts)).toBe("solved-by-all");
    // With only one scored arm left, the zero-scored arm does not make two.
    expect(bandOf([...trials("e1", "x", [false]), attempt("e1", "z", "error", false)])).toBeNull();
  });
});

describe("scorer health", () => {
  const shapeFails = (): CheckResult[] => [
    { name: "shape", passed: false },
    { name: "e2e", passed: true },
  ];

  test("(a) a check failing in every attempt of every arm while another passes → one suspect", () => {
    const attempts = [...trials("e1", "x", [false, false], shapeFails), ...trials("e1", "y", [false, false], shapeFails)];
    const health = collectScorerHealth(attempts, collectPairs(attempts));
    expect(health.suspects).toEqual([
      { eval_id: "e1", check: "shape", experiments: ["x", "y"], attempts: 4, passing_checks: ["e2e"] },
    ]);
    expect(health.summary).toBe(
      "1 check failed in every scored attempt of 1 eval under every arm while another check passed in those attempts. " +
        "Treat those evals' pass rates as unverified until the scorer is reviewed.",
    );
  });

  test("(b) every check failing everywhere → no suspect (an agent failure)", () => {
    const allFail = (): CheckResult[] => [
      { name: "shape", passed: false },
      { name: "e2e", passed: false },
    ];
    const attempts = [...trials("e1", "x", [false, false], allFail), ...trials("e1", "y", [false, false], allFail)];
    const health = collectScorerHealth(attempts, collectPairs(attempts));
    expect(health.suspects).toEqual([]);
    expect(health.summary).toBe("No check failed under every arm while another check passed.");
  });

  test("(c) a check failing in 3 of 4 attempts → no suspect", () => {
    const attempts = [
      ...trials("e1", "x", [false, false], shapeFails),
      ...trials("e1", "y", [false], shapeFails),
      attempt("e1", "y", "completed", false, [
        { name: "shape", passed: true },
        { name: "e2e", passed: true },
      ]),
    ];
    expect(collectScorerHealth(attempts, collectPairs(attempts)).suspects).toEqual([]);
  });

  test("(d) an ungraded check failing everywhere → no suspect", () => {
    const ungradedFails = (): CheckResult[] => [
      { name: "sdk-wired", passed: false, graded: false },
      { name: "e2e", passed: true },
    ];
    const attempts = [...trials("e1", "x", [false, false], ungradedFails), ...trials("e1", "y", [false], ungradedFails)];
    expect(collectScorerHealth(attempts, collectPairs(attempts)).suspects).toEqual([]);
  });

  test("(e) a banned substring in a check name stays out of the summary", () => {
    const causal = (): CheckResult[] => [
      { name: "causal-link", passed: false },
      { name: "e2e", passed: true },
    ];
    const attempts = [...trials("e1", "x", [false], causal), ...trials("e1", "y", [false], causal)];
    const health = collectScorerHealth(attempts, collectPairs(attempts));
    expect(health.suspects[0]?.check).toBe("causal-link");
    expect(findBannedLanguage(health.summary)).toEqual([]);
  });

  test("a check absent from some attempts never counts as failed in every attempt", () => {
    const attempts = [
      ...trials("e1", "x", [false], shapeFails),
      ...trials("e1", "y", [false], () => [{ name: "e2e", passed: true }]),
    ];
    expect(collectScorerHealth(attempts, collectPairs(attempts)).suspects).toEqual([]);
  });

  test("single-arm and discriminating evals are never flagged; suspects sort by attempts desc then eval", () => {
    const attempts = [
      // single arm: band null
      ...trials("solo", "x", [false, false], shapeFails),
      // discriminating
      ...trials("mixed", "x", [false], shapeFails),
      ...trials("mixed", "y", [true], shapeFails),
      // two failed-by-all evals with different attempt counts
      ...trials("b-eval", "x", [false], shapeFails),
      ...trials("b-eval", "y", [false], shapeFails),
      ...trials("a-eval", "x", [false], shapeFails),
      ...trials("a-eval", "y", [false], shapeFails),
      ...trials("c-eval", "x", [false, false], shapeFails),
      ...trials("c-eval", "y", [false], shapeFails),
    ];
    const health = collectScorerHealth(attempts, collectPairs(attempts));
    expect(health.suspects.map((s) => [s.eval_id, s.attempts])).toEqual([
      ["c-eval", 3],
      ["a-eval", 2],
      ["b-eval", 2],
    ]);
    expect(health.summary.startsWith("3 checks failed in every scored attempt of 3 evals")).toBeTrue();
    expect(findBannedLanguage(health.summary)).toEqual([]);
  });

  test("the methodology carries the scorer-health sentence and stays guard-clean", () => {
    const note = methodologyNote(3);
    expect(note).toContain("Scorer health lists checks that failed in every scored attempt of an eval under every arm");
    expect(findBannedLanguage(note)).toEqual([]);
  });

  test("(f) buildReport carries scorer_health and pairs[].band, and round-trips through JSON", () => {
    const root = tempRoot();
    const dbPath = join(root, "results.db");
    const resultsDir = join(root, "results");
    const { runId } = seedRun({ dbPath, resultsDir });
    const store = new ResultsStore(dbPath);
    try {
      const report = buildReport({ store, runId, resultsDir });
      expect(report.schema_version).toBe(REPORT_SCHEMA_VERSION);
      expect(report.schema_version).toBe(9);
      expect(report.scorer_health).toBeDefined();
      expect(report.scorer_health?.suspects).toEqual([]);
      for (const pair of report.pairs) expect(pair.band === null || typeof pair.band === "string").toBeTrue();
      // The sweep's arms disagree on every eval.
      expect(report.pairs.every((pair) => pair.band === "discriminating")).toBeTrue();
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
      const text = renderReportText(report);
      expect(text).toMatch(/^bands: discriminating 3 · solved by all 0 · failed by all 0$/m);
      expect(text).not.toContain("suspect:");
    } finally {
      store.close();
    }
  });
});

describe("renderer and seeded cell-states run", () => {
  test("the cell-states run bands both uniform evals and prints one suspect line", () => {
    const root = tempRoot();
    const { dbPath, resultsDir, runIds } = seedSite(root);
    const store = new ResultsStore(dbPath);
    try {
      const report = buildReport({ store, runId: runIds[1], resultsDir });
      const band = (evalId: string) => report.pairs.find((pair) => pair.eval_id === evalId)?.band;
      expect(band("uniform-pass")).toBe("solved-by-all");
      expect(band("uniform-fail")).toBe("failed-by-all");
      expect(band("auth-django")).toBeNull();
      expect(band("auth-nextjs")).toBe("discriminating");
      expect(report.scorer_health?.suspects).toEqual([
        {
          eval_id: "uniform-fail",
          check: "shape-check",
          experiments: ["claude-docs", "claude-mcp"],
          attempts: 6,
          passing_checks: ["works-e2e"],
        },
      ]);
      const text = renderReportText(report);
      expect(text).toContain("bands: discriminating 2 · solved by all 1 · failed by all 1");
      expect(text).toContain("suspect: uniform-fail · shape-check failed in 6 attempts under 2 arms; passing: works-e2e");
      expect(findBannedLanguage(text)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("an old report without band or scorer_health renders without either line", () => {
    const root = tempRoot();
    const dbPath = join(root, "results.db");
    const resultsDir = join(root, "results");
    const { runId } = seedRun({ dbPath, resultsDir });
    const store = new ResultsStore(dbPath);
    try {
      const report = buildReport({ store, runId, resultsDir });
      const { scorer_health: _dropped, ...rest } = report;
      const old = { ...rest, schema_version: 7, pairs: report.pairs.map(({ band: _band, ...pair }) => pair) } as unknown as ReportJson;
      const text = renderReportText(old);
      expect(text).not.toContain("bands:");
      expect(text).not.toContain("suspect:");
    } finally {
      store.close();
    }
  });
});
