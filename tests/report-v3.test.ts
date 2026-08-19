/**
 * The v3 report contract: honest aggregation from seeded stores — pass-rate
 * denominators, comparison-group raw counts, withheld groups rendering their
 * diff, null telemetry handling, the language guard, and the report.json
 * schema pin. jq assertions run VERBATIM against the written report.json.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedRun } from "../scripts/seed-run.ts";
import {
  buildReport,
  findBannedLanguage,
  readReportJson,
  renderReportText,
  ReportError,
  REPORT_SCHEMA_VERSION,
  writeReportJson,
  type ReportJson,
} from "../src/report/report.ts";
import { ResultsStore } from "../src/store/db.ts";
import type { RunManifest } from "../src/manifest.ts";

function seeded(options: { unfinished?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qs-report-v3-"));
  const dbPath = join(root, "results.db");
  const resultsDir = join(root, "results");
  const { runId } = seedRun({ dbPath, resultsDir, ...options });
  return { root, dbPath, resultsDir, runId, store: new ResultsStore(dbPath) };
}

function pairOf(report: ReportJson, evalId: string, experimentId: string) {
  const pair = report.pairs.find((candidate) => candidate.eval_id === evalId && candidate.experiment_id === experimentId);
  expect(pair).toBeDefined();
  return pair as NonNullable<typeof pair>;
}

describe("v3 report aggregation", () => {
  test("pass rates use scored = passed + failed; errors and incompletes never enter the denominator", () => {
    const { store, resultsDir, runId } = seeded();
    const report = buildReport({ store, runId, resultsDir });

    // codex-mcp on django: [fail, pass, error] → 1/2 scored, 1 errored.
    const withError = pairOf(report, "auth-django", "codex-mcp");
    expect(withError.total).toBe(3);
    expect(withError.errors).toBe(1);
    expect(withError.scored).toBe(2);
    expect(withError.scored).toBe(withError.passed + withError.failed);
    expect(withError.pass_rate).toBe(0.5);

    // codex-cli on django: [pass, pass, incomplete] → 2/2 scored, 1 incomplete.
    const withIncomplete = pairOf(report, "auth-django", "codex-cli");
    expect(withIncomplete.incomplete).toBe(1);
    expect(withIncomplete.scored).toBe(2);
    expect(withIncomplete.pass_rate).toBe(1);

    // Totals separate the states rather than folding them into failures.
    expect(report.totals.attempts).toBe(54);
    expect(report.totals.errors).toBe(1);
    expect(report.totals.incomplete).toBe(1);
    expect(report.totals.passed + report.totals.failed + report.totals.incomplete + report.totals.errors).toBe(54);
    store.close();
  });

  test("zero-attempt pairs are absent, never 0%", () => {
    const { store, resultsDir, runId } = seeded();
    const report = buildReport({ store, runId, resultsDir });
    expect(report.pairs).toHaveLength(18);
    expect(report.pairs.every((pair) => pair.total > 0)).toBeTrue();
    store.close();
  });

  test("named checks tally per pair, and flaky pairs are flagged", () => {
    const { store, resultsDir, runId } = seeded();
    const report = buildReport({ store, runId, resultsDir });

    // claude-mcp failures cluster on flow-wired.
    const mcpPair = pairOf(report, "auth-nextjs", "claude-mcp");
    const flowWired = mcpPair.checks.find((check) => check.name === "flow-wired");
    expect(flowWired).toEqual({ name: "flow-wired", passed: 0, total: 3 });

    // claude-cli is deliberately flaky (pass, fail, pass).
    expect(pairOf(report, "auth-nextjs", "claude-cli").flaky).toBeTrue();
    expect(pairOf(report, "auth-nextjs", "claude-docs").flaky).toBeFalse();
    store.close();
  });

  test("compared groups render raw per-arm counts; withheld groups render the diff and NO counts", () => {
    const { store, resultsDir, runId } = seeded();
    const report = buildReport({ store, runId, resultsDir });

    expect(report.groups.map((group) => [group.group, group.comparison])).toEqual([
      ["claude", "compared"],
      ["codex", "withheld"],
    ]);

    const claude = report.groups[0]!;
    expect(claude.arms.map((arm) => arm.experiment_id)).toEqual(["claude-cli", "claude-docs", "claude-mcp"]);
    const docsArm = claude.arms.find((arm) => arm.experiment_id === "claude-docs")!;
    expect(docsArm.treatment).toBe("docs");
    expect(docsArm.evals.map((entry) => entry.display)).toEqual(["3/3", "3/3", "3/3"]);
    const mcpArm = claude.arms.find((arm) => arm.experiment_id === "claude-mcp")!;
    expect(mcpArm.evals.map((entry) => entry.display)).toEqual(["0/3", "0/3", "0/3"]);

    const codex = report.groups[1]!;
    expect(codex.arms).toEqual([]);
    expect(codex.details.length).toBeGreaterThan(0);
    expect(codex.details.some((detail) => detail.includes("model"))).toBeTrue();
    store.close();
  });

  test("telemetry is unavailable — never 0 — when no attempt reported it", () => {
    const root = mkdtempSync(join(tmpdir(), "qs-report-null-"));
    const store = new ResultsStore(join(root, "results.db"));
    const manifest: RunManifest = {
      manifestVersion: "v3",
      harness: { version: "t", revision: "t", dirty: false, source: { sha256: "0".repeat(64) } },
      evals: {},
      experiments: {},
      images: {},
      hash: "1".repeat(64),
    };
    store.insertRun({
      id: "01RUN",
      startedAt: 1_754_000_000_000,
      config: { trials: 1, evalIds: ["e"], experimentIds: ["x"] },
      manifest,
    });
    store.insertAttempt({
      id: "01A",
      runId: "01RUN",
      evalId: "e",
      experimentId: "x",
      suite: "benchmark",
      trialIndex: 0,
      attemptIdentityHash: "2".repeat(64),
      status: "completed",
      result: { passed: true, checks: [] },
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    });
    store.finishRun("01RUN", 1_754_000_060_000);

    const report = buildReport({ store, runId: "01RUN", resultsDir: root });
    expect(report.telemetry.cost_usd).toBeNull();
    expect(report.telemetry.tokens_in).toBeNull();
    expect(report.telemetry.cost_attempts).toBe(0);
    expect(renderReportText(report)).toContain("cost:    unavailable");
    store.close();
  });

  test("an unfinished run is flagged incomplete and the renderer says so loudly", () => {
    const { store, resultsDir, runId } = seeded({ unfinished: true });
    const report = buildReport({ store, runId, resultsDir });
    expect(report.incomplete).toBeTrue();
    expect(renderReportText(report)).toContain("INCOMPLETE");
    store.close();
  });

  test("unknown run id raises a ReportError naming recent runs", () => {
    const { store, resultsDir } = seeded();
    expect(() => buildReport({ store, runId: "nope", resultsDir })).toThrow(ReportError);
    expect(() => buildReport({ store, runId: "nope", resultsDir })).toThrow(/most recent runs/);
    store.close();
  });
});

describe("language guard", () => {
  test("findBannedLanguage catches the banned fragments (incl. 'because' via 'caus')", () => {
    expect(findBannedLanguage("this difference is significant")).toEqual(["significant"]);
    expect(findBannedLanguage("failed because the server was down")).toEqual(["caus"]);
    expect(findBannedLanguage("the effect of the treatment")).toEqual(["effect of"]);
    expect(findBannedLanguage("raw counts per arm")).toEqual([]);
  });

  test("the generated report prose (methodology + rendered text) is guard-clean", () => {
    const { store, resultsDir, runId } = seeded();
    const report = buildReport({ store, runId, resultsDir });
    expect(findBannedLanguage(report.methodology)).toEqual([]);
    expect(findBannedLanguage(renderReportText(report))).toEqual([]);
    store.close();
  });
});

describe("report.json plumbing", () => {
  test("write + read round-trips at schema 3; other schemas are refused", () => {
    const { store, resultsDir, runId } = seeded();
    const report = buildReport({ store, runId, resultsDir, generatedAt: "2026-07-20T02:00:00.000Z" });
    expect(report.schema_version).toBe(REPORT_SCHEMA_VERSION);
    writeReportJson(report, resultsDir);
    expect(readReportJson(resultsDir, runId)).toEqual(report);

    writeFileSync(
      join(resultsDir, runId, "report.json"),
      JSON.stringify({ ...report, schema_version: 2 }),
      "utf8",
    );
    expect(() => readReportJson(resultsDir, runId)).toThrow(/unsupported report schema 2/);
    store.close();
  });
});

// The contract's jq assertions run VERBATIM against the written report.json.
// Requires the jq binary.
const hasJq = Bun.which("jq") !== null;

describe.skipIf(!hasJq)("contract jq assertions", () => {
  function jqCheck(filter: string, path: string): boolean {
    const result = Bun.spawnSync(["jq", "-e", filter, path]);
    return result.exitCode === 0;
  }

  test("pair, group, and telemetry shapes pass against a seeded run's report.json", () => {
    const { store, resultsDir, runId } = seeded();
    const report = buildReport({ store, runId, resultsDir });
    const path = writeReportJson(report, resultsDir);

    expect(jqCheck('(.schema_version == 3)', path)).toBeTrue();
    expect(jqCheck('(.pairs | length == 18) and all(.pairs[]; has("pass_rate") and has("checks") and (.scored == .passed + .failed))', path)).toBeTrue();
    expect(
      jqCheck(
        '(.groups | length == 2) and (.groups[0].comparison == "compared") and (.groups[1].comparison == "withheld") and (.groups[1].arms | length == 0) and (.groups[1].details | length > 0)',
        path,
      ),
    ).toBeTrue();
    expect(jqCheck('all(.groups[] | select(.comparison == "compared") | .arms[].evals[]; .display | test("^[0-9]+/[0-9]+$"))', path)).toBeTrue();
    expect(jqCheck('(.usage | length == 6) and all(.usage[]; has("telemetry_unavailable"))', path)).toBeTrue();
    store.close();
  });
});

describe("CLI report command", () => {
  const CLI = join(import.meta.dir, "../src/cli.ts");

  function runCli(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(["bun", CLI, ...args], { cwd, env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  test("report --json prints valid schema-3 JSON and writes report.json", () => {
    const { root, dbPath, resultsDir, runId, store } = seeded();
    store.close();

    const reportRun = runCli(["report", runId, "--json", "--db", dbPath, "--results", resultsDir], root);
    expect(reportRun.exitCode).toBe(0);
    const parsed = JSON.parse(reportRun.stdout) as ReportJson;
    expect(parsed.schema_version).toBe(3);
    expect(parsed.pairs).toHaveLength(18);
    expect(reportRun.stderr).toContain("report written");
    expect(readReportJson(resultsDir, runId).run.id).toBe(runId);
  });

  test("--latest picks the newest run; an empty database renders the zero-state and exits 0", () => {
    const { root, dbPath, resultsDir, runId, store } = seeded();
    store.close();
    const latest = runCli(["report", "--latest", "--db", dbPath, "--results", resultsDir], root);
    expect(latest.exitCode).toBe(0);
    expect(latest.stdout).toContain(`run ${runId}`);

    const emptyRoot = mkdtempSync(join(tmpdir(), "qs-report-empty-"));
    const empty = runCli(["report", "--latest", "--db", join(emptyRoot, "empty.db"), "--results", emptyRoot], emptyRoot);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("no runs yet");
  });

  test("--strict exits non-zero when the run contains attempt errors", () => {
    const { root, dbPath, resultsDir, runId, store } = seeded();
    store.close();
    const strict = runCli(["report", runId, "--strict", "--db", dbPath, "--results", resultsDir], root);
    expect(strict.exitCode).not.toBe(0);
    expect(strict.stderr).toContain("not publishable");
    // Without --strict the same report exits 0.
    const loose = runCli(["report", runId, "--db", dbPath, "--results", resultsDir], root);
    expect(loose.exitCode).toBe(0);
  });

  test("--strict exits non-zero for an unfinished run", () => {
    const { root, dbPath, resultsDir, runId, store } = seeded({ unfinished: true });
    store.close();
    const strict = runCli(["report", runId, "--strict", "--db", dbPath, "--results", resultsDir], root);
    expect(strict.exitCode).not.toBe(0);
    expect(strict.stderr).toContain("incomplete");
    const loose = runCli(["report", runId, "--db", dbPath, "--results", resultsDir], root);
    expect(loose.exitCode).toBe(0);
    expect(loose.stdout).toContain("INCOMPLETE");
  });
});
