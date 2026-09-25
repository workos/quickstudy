/**
 * Per-experiment leaderboard: aggregate math over benchmark-suite attempts
 * (pass rates, discriminating subset, median agent time, token means, cost
 * with reported/estimated counts), the stale-schema rebuild at export, and
 * the text renderer's table.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedRun } from "../scripts/seed-run.ts";
import { exportSite } from "../src/export.ts";
import { attemptIdentityHash, type RunManifest } from "../src/manifest.ts";
import { collectExperimentAggregate, median } from "../src/report/aggregate.ts";
import { parsePricing, type Pricing } from "../src/report/costs.ts";
import {
  buildReport,
  collectPairs,
  compareLeaderboard,
  renderReportText,
  REPORT_SCHEMA_VERSION,
  type ReportExperiment,
  type ReportJson,
} from "../src/report/report.ts";
import { collectBands } from "../src/report/scorer-health.ts";
import { ResultsStore, type AttemptRecord } from "../src/store/db.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qs-leaderboard-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function seeded(withRegression = false) {
  const root = tempRoot();
  const dbPath = join(root, "results.db");
  const resultsDir = join(root, "results");
  const { runId } = seedRun({ dbPath, resultsDir, withRegression });
  return { root, resultsDir, runId, store: new ResultsStore(dbPath) };
}

function seededReport(withRegression = false): ReportJson {
  const { store, runId, resultsDir } = seeded(withRegression);
  const report = buildReport({ store, runId, resultsDir, generatedAt: "2026-01-01T00:00:00.000Z" });
  store.close();
  return report;
}

let seq = 0;
function attempt(evalId: string, experimentId: string, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  seq += 1;
  const status = overrides.status ?? "completed";
  return {
    id: `a${String(seq).padStart(4, "0")}`,
    runId: "run",
    evalId,
    experimentId,
    suite: "benchmark",
    trialIndex: seq,
    attemptIdentityHash: "h",
    status,
    result: status === "completed" ? { passed: true, checks: [] } : null,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    ...overrides,
  } as AttemptRecord;
}
const pass = (evalId: string, exp: string, o: Partial<AttemptRecord> = {}) => attempt(evalId, exp, { result: { passed: true, checks: [] }, ...o });
const fail = (evalId: string, exp: string, o: Partial<AttemptRecord> = {}) => attempt(evalId, exp, { result: { passed: false, checks: [] }, ...o });
const stamped = (ms: number): Partial<AttemptRecord> => ({ agentStartedAt: 1_000, agentFinishedAt: 1_000 + ms });

/** Pairs banded the way buildReport does it. */
function aggregateOf(attempts: AttemptRecord[], experimentId: string) {
  const pairs = collectPairs(attempts);
  const bands = collectBands(pairs);
  for (const pair of pairs) pair.band = bands.get(pair.eval_id) ?? null;
  return collectExperimentAggregate(attempts, pairs, experimentId);
}

describe("aggregate", () => {
  test("seeded pass rates are exact, discriminating equals all, and the sort follows them", () => {
    const report = seededReport();
    const byId = new Map((report.experiments ?? []).map((e) => [e.experiment_id, e.aggregate!]));
    const rates = Object.fromEntries([...byId].map(([id, agg]) => [id, [agg.passed, agg.passed + agg.failed]]));
    expect(rates).toEqual({
      "claude-cli": [6, 9],
      "claude-docs": [9, 9],
      "claude-mcp": [0, 9],
      "codex-cli": [6, 8],
      "codex-docs": [6, 9],
      "codex-mcp": [3, 8],
    });
    for (const agg of byId.values()) {
      expect(agg.pass_rate_discriminating).toBe(agg.pass_rate_all);
      expect(agg.discriminating_evals).toBe(3);
    }
    expect(byId.get("codex-cli")!.pass_rate_all).toBe(0.75);
    expect(byId.get("codex-cli")!.incomplete).toBe(1);
    expect(byId.get("codex-mcp")!.errors).toBe(1);
    expect(byId.get("codex-mcp")!.attempts).toBe(9);
    const docs = byId.get("claude-docs")!;
    // Sequences 1-3, 19-21, 37-39; duration 82_000 + seq*100; tokensIn 200 + seq.
    expect(docs.median_agent_ms).toBe(84_000);
    expect(docs.agent_time_attempts).toBe(9);
    expect(docs.mean_tokens_in).toBe(220);
    expect(docs.token_attempts).toBe(9);
    expect(docs.cost_usd).toBeCloseTo(0.99, 10);
    expect(docs.cost_attempts).toBe(9);
    expect("estimated_cost_usd" in docs).toBeFalse();
    expect("estimated_attempts" in docs).toBeFalse();
    const order = [...(report.experiments ?? [])].sort(compareLeaderboard).map((e) => e.experiment_id);
    expect(order).toEqual(["claude-docs", "codex-cli", "claude-cli", "codex-docs", "codex-mcp", "claude-mcp"]);
  });

  test("regression-suite attempts never move any aggregate", () => {
    const plain = seededReport(false);
    const withRegression = seededReport(true);
    const aggregates = (report: ReportJson) => (report.experiments ?? []).map((e) => [e.experiment_id, e.aggregate]);
    expect(aggregates(withRegression)).toEqual(aggregates(plain));
    // The run-wide telemetry does include the regression attempts.
    expect(withRegression.telemetry.cost_attempts).toBeGreaterThan(plain.telemetry.cost_attempts);
  });

  test("a solved-by-all eval is excluded from the discriminating subset", () => {
    const attempts = [
      pass("solved", "x"), pass("solved", "x"), pass("solved", "y"),
      pass("split", "x"), fail("split", "x"), fail("split", "y"),
    ];
    const x = aggregateOf(attempts, "x");
    expect(x.pass_rate_all).toBe(3 / 4);
    expect(x.pass_rate_discriminating).toBe(1 / 2);
    expect(x.discriminating_evals).toBe(1);
    expect([x.discriminating_passed, x.discriminating_scored]).toEqual([1, 2]);
  });

  test("an eval with one scored arm (band null) is not discriminating; the rate is null and sorts last", () => {
    const x = aggregateOf([pass("only", "x"), fail("only", "x")], "x");
    expect(x.pass_rate_all).toBe(0.5);
    expect(x.discriminating_evals).toBe(0);
    expect(x.pass_rate_discriminating).toBeNull();
    const row = (id: string, disc: number | null, all: number | null) =>
      ({ experiment_id: id, aggregate: { pass_rate_discriminating: disc, pass_rate_all: all } }) as unknown as ReportExperiment;
    const sorted = [row("b", null, 0.9), row("a", null, 0.9), row("c", 0, 0), row("d", null, null)].sort(compareLeaderboard);
    expect(sorted.map((e) => e.experiment_id)).toEqual(["c", "a", "b", "d"]);
  });

  test("median over odd, even and zero stamps; unstamped attempts are skipped", () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
    expect(median([])).toBeNull();
    const four = aggregateOf([pass("e", "x", stamped(10)), pass("e", "x", stamped(40)), fail("e", "x", stamped(20)), fail("e", "x", stamped(30)), pass("e", "x")], "x");
    expect(four.median_agent_ms).toBe(25);
    expect(four.agent_time_attempts).toBe(4);
    const none = aggregateOf([pass("e", "x"), fail("e", "x")], "x");
    expect(none.median_agent_ms).toBeNull();
    expect(none.agent_time_attempts).toBe(0);
  });

  test("unreported telemetry is null, never 0; means divide by the reporting count", () => {
    const silent = aggregateOf([pass("e", "x"), fail("e", "x")], "x");
    expect(silent.cost_usd).toBeNull();
    expect(silent.cost_attempts).toBe(0);
    expect(silent.mean_tokens_in).toBeNull();
    expect(silent.mean_tokens_out).toBeNull();
    expect(silent.token_attempts).toBe(0);
    const partial = aggregateOf([pass("e", "x", { costUsd: 0.5, tokensIn: 100, tokensOut: 10 }), pass("e", "x", { tokensIn: 300 }), fail("e", "x")], "x");
    expect(partial.cost_usd).toBe(0.5);
    expect(partial.cost_attempts).toBe(1);
    expect(partial.mean_tokens_in).toBe(200);
    expect(partial.mean_tokens_out).toBe(10);
    expect(partial.token_attempts).toBe(2);
  });

  test("error and incomplete attempts count in attempts but not scored; timeouts and zero-attempt experiments", () => {
    const agg = aggregateOf([
      pass("e", "x", { limitHit: "timeout" }),
      attempt("e", "x", { status: "error" }),
      attempt("e", "x", { status: "incomplete", limitHit: "timeout" }),
      fail("e", "y"),
    ], "x");
    expect([agg.attempts, agg.completed, agg.passed, agg.failed, agg.incomplete, agg.errors, agg.timeouts]).toEqual([3, 1, 1, 0, 1, 1, 1]);
    expect(agg.pass_rate_all).toBe(1);
    const empty = aggregateOf([fail("e", "y")], "absent");
    expect(empty).toEqual({
      attempts: 0, completed: 0, passed: 0, failed: 0, incomplete: 0, errors: 0, timeouts: 0,
      pass_rate_all: null, pass_rate_discriminating: null, discriminating_evals: 0,
      discriminating_passed: 0, discriminating_scored: 0,
      median_agent_ms: null, agent_time_attempts: 0,
      mean_tokens_in: null, mean_tokens_out: null, token_attempts: 0,
      cost_usd: null, cost_attempts: 0,
    });
  });

  test("estimated fields are absent without pricing and present with it", () => {
    const START = Date.parse("2026-09-16T00:00:00Z");
    const PRICING: Pricing = {
      version: "test-rates-v1", currency: "USD",
      rates: [{
        provider: "openai", model: "test-codex", effective_from: "2026-09-01T00:00:00Z",
        source: "https://example.com/pricing", input_usd_per_million: 2,
        cached_input_usd_per_million: 0.5, output_usd_per_million: 8,
      }],
    };
    const root = tempRoot();
    const store = new ResultsStore(join(root, "results.db"));
    const manifest: RunManifest = {
      manifestVersion: "v4", hash: "manifest",
      harness: { version: "test", revision: "test", dirty: false, source: { sha256: "source" } },
      evals: { eval: { id: "eval", hash: "eval", metadata: { id: "eval", suite: "benchmark" },
        components: { promptSource: "prompt", effectivePrompt: "prompt", local: null, scorer: "scorer", metadata: "metadata" }, solution: null } },
      images: {}, experiments: {
        codex: { id: "codex", hash: "experiment", components: {
          source: "source", runtime: "runtime", image: null, treatment: null, harness: "source",
          agent: { adapter: "codex", provider: "openai", model: "test-codex", reasoning: "high", cliVersion: "test" },
        } },
      },
    };
    store.insertRun({ id: "run", startedAt: START, manifest, config: { trials: 2, evalIds: ["eval"], experimentIds: ["codex"] } });
    store.finishRun("run", START + 60_000);
    const transcript = readFileSync(join(import.meta.dir, "__fixtures__/streams/codex-turns.jsonl"), "utf8");
    for (const [index, id] of ["a1", "a2"].entries()) {
      const dir = join(root, "run", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "transcript.jsonl"), transcript);
      store.insertAttempt({
        id, runId: "run", evalId: "eval", experimentId: "codex", trialIndex: index,
        suite: "benchmark", status: "completed", result: { passed: true, checks: [] },
        attemptIdentityHash: attemptIdentityHash({ evalId: "eval", experimentId: "codex", trialIndex: index }, manifest),
        startedAt: START, finishedAt: START + 10_000, transcriptRef: join(dir, "transcript.jsonl"),
        costUsd: index === 0 ? 0.25 : null,
      });
    }
    const without = buildReport({ store, runId: "run", resultsDir: root }).experiments![0]!.aggregate!;
    expect("estimated_cost_usd" in without).toBeFalse();
    expect(without.cost_usd).toBe(0.25);
    expect(without.cost_attempts).toBe(1);
    const priced = buildReport({ store, runId: "run", resultsDir: root, pricing: parsePricing(PRICING) }).experiments![0]!.aggregate!;
    expect(priced.estimated_attempts).toBe(1);
    expect(priced.estimated_cost_usd).toBeCloseTo(0.00545, 10);
    store.close();
  });
});

describe("control experiments on the leaderboard", () => {
  const experiment = (id: string, disc: number | null, role?: ReportExperiment["role"]): ReportExperiment =>
    ({
      experiment_id: id,
      treatment: null,
      agent: { adapter: "x", provider: "p", model: "m", reasoning: "r", cli_version: "v" },
      ...(role ? { role } : {}),
      aggregate: { pass_rate_discriminating: disc, pass_rate_all: disc } as ReportExperiment["aggregate"],
    }) as ReportExperiment;

  test("controls sort after every agent arm, whatever their rate; absent role is an agent", () => {
    const sorted = [
      experiment("oracle", 1, "positive-control"),
      experiment("nop", 0, "negative-control"),
      experiment("weak", 0.2, "agent"),
      experiment("legacy", 0.5),
    ].sort(compareLeaderboard);
    expect(sorted.map((e) => e.experiment_id)).toEqual(["legacy", "weak", "oracle", "nop"]);
  });

  test("buildReport marks the controls, bands over the agents alone and says so in the methodology", () => {
    const agentsFail = (id: string, experimentId: string, passed: boolean): AttemptRecord =>
      attempt(id, experimentId, { result: { passed, checks: [] }, surfaceUsage: null });
    const attempts = [
      agentsFail("e1", "agent-a", false),
      agentsFail("e1", "agent-b", false),
      agentsFail("e1", "oracle", true),
      agentsFail("e1", "nop", false),
    ];
    const agent = (adapter: string) => ({ components: { treatment: null, agent: { adapter, provider: "p", model: "m", reasoning: "r", cliVersion: "v" } } });
    const run = {
      id: "run",
      startedAt: 0,
      finishedAt: 1,
      config: {
        trials: 1,
        evalIds: ["e1"],
        experimentIds: ["agent-a", "agent-b", "nop", "oracle"],
        roles: { "agent-a": "agent", "agent-b": "agent", nop: "negative-control", oracle: "positive-control" },
      },
      manifest: {
        hash: "h",
        experiments: { "agent-a": agent("claude"), "agent-b": agent("codex"), nop: agent("echo"), oracle: agent("oracle") },
      },
      manifestHash: "h",
    };
    const store = { getRun: () => run, listRuns: () => [run], listAttempts: () => attempts };
    const report = buildReport({ store: store as never, runId: "run", resultsDir: tempRoot() });
    expect(report.schema_version).toBe(REPORT_SCHEMA_VERSION);
    expect(Object.fromEntries((report.experiments ?? []).map((e) => [e.experiment_id, e.role]))).toEqual({
      "agent-a": "agent",
      "agent-b": "agent",
      nop: "negative-control",
      oracle: "positive-control",
    });
    // Every agent failed: the controls no longer make the eval look discriminating.
    expect(new Set(report.pairs.map((pair) => pair.band))).toEqual(new Set(["failed-by-all"]));
    expect(report.methodology).toContain("bands and scorer health are decided over the agent experiments only");
    const text = renderReportText(report);
    expect(text).toContain("oracle (control)");
    expect(text).toContain("nop (control)");
    expect(text).not.toContain("agent-a (control)");
    expect(text).toContain("controls last");
  });

  test("a run that recorded no roles reads every experiment as an agent, whatever its adapter is called", () => {
    const attempts = [
      attempt("e1", "agent-a", { result: { passed: false, checks: [] }, surfaceUsage: null }),
      attempt("e1", "echo", { result: { passed: false, checks: [] }, surfaceUsage: null }),
    ];
    const agent = (adapter: string) => ({ components: { treatment: null, agent: { adapter, provider: "p", model: "m", reasoning: "r", cliVersion: "v" } } });
    const run = {
      id: "run",
      startedAt: 0,
      finishedAt: 1,
      config: { trials: 1, evalIds: ["e1"], experimentIds: ["agent-a", "echo"] },
      manifest: { hash: "h", experiments: { "agent-a": agent("claude"), echo: agent("echo") } },
      manifestHash: "h",
    };
    const store = { getRun: () => run, listRuns: () => [run], listAttempts: () => attempts };
    const report = buildReport({ store: store as never, runId: "run", resultsDir: tempRoot() });
    expect((report.experiments ?? []).map((e) => e.role)).toEqual(["agent", "agent"]);
    expect(report.pairs.every((pair) => pair.band === "failed-by-all")).toBeTrue();
  });
});

describe("stale schema rebuild", () => {
  test("export rebuilds a schema 6 report.json into one carrying aggregates", async () => {
    const { store, resultsDir, runId, root } = seeded();
    const stale = { ...buildReport({ store, runId, resultsDir }), schema_version: 6 } as ReportJson;
    for (const experiment of stale.experiments ?? []) delete experiment.aggregate;
    mkdirSync(join(resultsDir, runId), { recursive: true });
    writeFileSync(join(resultsDir, runId, "report.json"), JSON.stringify(stale), "utf8");
    const outDir = join(root, "site");
    await exportSite({ store, resultsDir, runIds: [runId], outDir, log: () => {} });
    const exported = JSON.parse(readFileSync(join(outDir, "data", "runs", runId, "report.json"), "utf8")) as ReportJson;
    expect(exported.schema_version).toBe(REPORT_SCHEMA_VERSION);
    expect(exported.experiments?.[0]?.aggregate).toBeDefined();
    store.close();
  });
});

describe("renderer", () => {
  test("prints the leaderboard table sorted by discriminating pass rate, and omits it for old reports", () => {
    const report = seededReport();
    const text = renderReportText(report);
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.startsWith("leaderboard"));
    expect(start).toBeGreaterThan(-1);
    expect(lines[start + 1]).toContain("experiment");
    expect(lines[start + 1]).toContain("pass (all/disc)");
    expect(lines[start + 2]!.trim().startsWith("claude-docs")).toBeTrue();
    expect(lines[start + 2]).toContain("9/9 · 9/9");
    expect(lines[start + 2]).toContain("9/9 reported");
    expect(lines[start + 7]!.trim().startsWith("claude-mcp")).toBeTrue();
    const legacy = { ...report, experiments: (report.experiments ?? []).map(({ aggregate: _drop, ...rest }) => rest) };
    expect(renderReportText(legacy)).not.toContain("leaderboard");
  });
});
