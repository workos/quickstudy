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
import { collectExperimentAggregate, median, type ExperimentAggregate } from "../src/report/aggregate.ts";
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

  test("regression-suite attempts count toward the aggregate; smoke-suite attempts never do", () => {
    const plain = seededReport(false);
    const withRegression = seededReport(true);
    const regressionPairs = (withRegression.pairs ?? []).filter((p) => p.suite === "regression");
    expect(regressionPairs.length).toBeGreaterThan(0);
    const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);
    // Every arm's row grows by exactly its regression pairs: attempts, scored,
    // passes, and the discriminating subset, so both filters moved together.
    for (const experiment of withRegression.experiments ?? []) {
      const agg = experiment.aggregate!;
      const before = (plain.experiments ?? []).find((e) => e.experiment_id === experiment.experiment_id)?.aggregate;
      if (before === undefined) throw new Error(`no plain aggregate for ${experiment.experiment_id}`);
      const mine = regressionPairs.filter((p) => p.experiment_id === experiment.experiment_id);
      const scored = sum(mine.map((p) => p.scored));
      const passed = sum(mine.map((p) => p.passed));
      expect(agg.attempts - before.attempts).toBe(sum(mine.map((p) => p.total)));
      expect(agg.passed + agg.failed).toBe(before.passed + before.failed + scored);
      expect(agg.passed).toBe(before.passed + passed);
      expect(agg.pass_rate_all).toBeCloseTo((before.passed + passed) / (before.passed + before.failed + scored), 10);
      const discriminating = mine.filter((p) => p.band === "discriminating");
      expect(agg.discriminating_scored).toBe(before.discriminating_scored + sum(discriminating.map((p) => p.scored)));
      expect(agg.discriminating_passed).toBe(before.discriminating_passed + sum(discriminating.map((p) => p.passed)));
    }
    expect((withRegression.pairs ?? []).some((p) => p.suite === "regression" && p.band === "discriminating")).toBe(true);
    // Smoke stays outside the headline: the row ignores it entirely.
    const x = aggregateOf(
      [pass("split", "x"), fail("split", "x"), pass("saturated", "x", { suite: "smoke" }), pass("saturated", "x", { suite: "smoke" })],
      "x",
    );
    expect(x.attempts).toBe(2);
    expect(x.pass_rate_all).toBe(0.5);
  });

  test("discovery-suite attempts never count toward the aggregate", () => {
    // A passing discovery pair moves nothing: not attempts, not the pass rate,
    // not the discriminating subset.
    const base = aggregateOf([pass("split", "x"), fail("split", "x"), fail("split", "y")], "x");
    const withDiscovery = aggregateOf(
      [
        pass("split", "x"), fail("split", "x"), fail("split", "y"),
        pass("which-vendor", "x", { suite: "discovery" }), pass("which-vendor", "x", { suite: "discovery" }),
      ],
      "x",
    );
    expect(withDiscovery).toEqual(base);
    expect(withDiscovery.attempts).toBe(2);
    expect(withDiscovery.pass_rate_all).toBe(0.5);
    // A discovery-only run yields the empty headline aggregate (null, never NaN).
    const only = aggregateOf([pass("which-vendor", "x", { suite: "discovery" })], "x");
    expect(only.attempts).toBe(0);
    expect(only.pass_rate_all).toBeNull();
    expect(only.pass_rate_discriminating).toBeNull();
    expect(only.cost_per_pass_usd).toBeNull();
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
      cost_per_pass_usd: null, agent_ms_per_pass: null, clears_gate: null,
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
    expect("estimated_cost_per_pass_usd" in without).toBeFalse();
    expect(without.cost_usd).toBe(0.25);
    // Reported cost over the one priced attempt, which passed: the ratio is the cost itself.
    expect(without.cost_per_pass_usd).toBe(0.25);
    expect(without.cost_attempts).toBe(1);
    const priced = buildReport({ store, runId: "run", resultsDir: root, pricing: parsePricing(PRICING) }).experiments![0]!.aggregate!;
    expect(priced.estimated_attempts).toBe(1);
    expect(priced.estimated_cost_usd).toBeCloseTo(0.00545, 10);
    // One estimated attempt, and it passed: the estimate per pass equals the estimate.
    expect(priced.estimated_cost_per_pass_usd).toBeCloseTo(0.00545, 10);
    store.close();
  });
});

describe("cost-to-pass, time-to-pass and the gate", () => {
  const costed = (evalId: string, exp: string, passed: boolean, costUsd: number | null, ms: number | null) =>
    attempt(evalId, exp, {
      result: { passed, checks: [] },
      costUsd,
      ...(ms === null ? {} : stamped(ms)),
    });

  test("each ratio divides its own total by the passes among the attempts that reported it", () => {
    const x = aggregateOf(
      [
        costed("e1", "x", true, 1.0, 100_000), // priced and stamped, passed
        costed("e2", "x", false, 0.5, 50_000), // priced and stamped, failed — still spent
        costed("e3", "x", true, null, null), // passed with no telemetry: not in either ratio
        costed("e1", "y", false, 2, 10_000),
      ],
      "x",
    );
    expect(x.cost_usd).toBe(1.5);
    expect(x.cost_per_pass_usd).toBe(1.5); // $1.50 over the one priced pass
    expect(x.agent_ms_per_pass).toBe(150_000); // 150 s over the one stamped pass
    expect(x.pass_rate_all).toBeCloseTo(2 / 3, 10);
    expect(x.clears_gate).toBe(false);
  });

  test("the ratios are null, never zero, when nothing reported or nothing that reported passed", () => {
    const silent = aggregateOf([pass("e", "x"), fail("e", "x")], "x");
    expect(silent.cost_per_pass_usd).toBeNull();
    expect(silent.agent_ms_per_pass).toBeNull();
    const spentAndFailed = aggregateOf([costed("e", "x", false, 3, 30_000), pass("e", "x")], "x");
    expect(spentAndFailed.cost_usd).toBe(3);
    expect(spentAndFailed.cost_per_pass_usd).toBeNull();
    expect(spentAndFailed.agent_ms_per_pass).toBeNull();
  });

  test("the gate is pass_rate_all at or above 80%, null with nothing scored", () => {
    const four = aggregateOf([pass("a", "x"), pass("b", "x"), pass("c", "x"), pass("d", "x"), fail("e", "x")], "x");
    expect(four.pass_rate_all).toBe(0.8);
    expect(four.clears_gate).toBe(true);
    const three = aggregateOf([pass("a", "x"), pass("b", "x"), pass("c", "x"), fail("d", "x"), fail("e", "x")], "x");
    expect(three.clears_gate).toBe(false);
    expect(aggregateOf([attempt("a", "x", { status: "error" })], "x").clears_gate).toBeNull();
    const strict = collectExperimentAggregate([pass("a", "x"), fail("b", "x")], collectPairs([pass("a", "x"), fail("b", "x")]), "x", undefined, 0.5);
    expect(strict.clears_gate).toBe(true);
  });

  test("the order: gate first, then time-to-pass, then cost-to-pass, with pass rate only as a tie-break", () => {
    const row = (id: string, agg: Partial<ExperimentAggregate>, role?: string) =>
      ({ experiment_id: id, ...(role ? { role } : {}), aggregate: { pass_rate_all: 1, pass_rate_discriminating: 1, ...agg } }) as unknown as ReportExperiment;
    const rows = [
      row("slow-cheap", { clears_gate: true, agent_ms_per_pass: 200_000, cost_per_pass_usd: 1, pass_rate_discriminating: 0.9 }),
      row("perfect-but-below", { clears_gate: false, agent_ms_per_pass: 10_000, cost_per_pass_usd: 0.1, pass_rate_discriminating: 1, pass_rate_all: 0.5 }),
      row("fast-pricey", { clears_gate: true, agent_ms_per_pass: 100_000, cost_per_pass_usd: 5, pass_rate_discriminating: 0.8 }),
      row("fast-unpriced", { clears_gate: true, agent_ms_per_pass: 100_000, cost_per_pass_usd: null, pass_rate_discriminating: 1 }),
      row("untimed", { clears_gate: true, agent_ms_per_pass: null, cost_per_pass_usd: 0.01, pass_rate_discriminating: 1 }),
      row("oracle", { clears_gate: true, agent_ms_per_pass: 1, cost_per_pass_usd: 0 }, "positive-control"),
    ];
    expect([...rows].sort(compareLeaderboard).map((e) => e.experiment_id)).toEqual([
      "fast-pricey", // clears; fastest; priced before the unpriced tie
      "fast-unpriced", // same time, no dollars: after the priced arm
      "slow-cheap", // clears; slower
      "untimed", // clears; no time recorded sorts after every timed arm
      "perfect-but-below", // the best discriminating rate, but below the gate
      "oracle", // controls last whatever their figures
    ]);
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

  test("a run that recorded no roles reads every experiment as an agent — even the built-ins' exact identities", () => {
    const attempts = [
      attempt("e1", "agent-a", { result: { passed: false, checks: [] }, surfaceUsage: null }),
      attempt("e1", "agent-b", { result: { passed: false, checks: [] }, surfaceUsage: null }),
      attempt("e1", "oracle", { result: { passed: true, checks: [] }, surfaceUsage: null, turns: 0, costUsd: 0, tokensIn: null }),
      attempt("e1", "nop", { result: { passed: false, checks: [] }, surfaceUsage: null, turns: 1, costUsd: 0, tokensIn: 800 }),
    ];
    const identity = (adapter: string, model: string, image: unknown = null) => ({
      components: { treatment: null, image, agent: { adapter, provider: "local", model, reasoning: "none", cliVersion: "built-in" } },
    });
    const claude = { components: { treatment: null, image: null, agent: { adapter: "claude", provider: "p", model: "m", reasoning: "r", cliVersion: "v" } } };
    const run = {
      id: "run",
      startedAt: 0,
      finishedAt: 1,
      config: { trials: 1, evalIds: ["e1"], experimentIds: ["agent-a", "agent-b", "nop", "oracle"] },
      manifest: {
        hash: "h",
        experiments: {
          "agent-a": claude,
          "agent-b": claude,
          nop: identity("echo", "echo-v1"),
          // The oracle runs in a container in real sweeps; its image does not matter.
          oracle: identity("oracle", "oracle-v1", { tag: "img", digest: "d" }),
        },
      },
      manifestHash: "h",
    };
    const store = { getRun: () => run, listRuns: () => [run], listAttempts: () => attempts };
    const report = buildReport({ store: store as never, runId: "run", resultsDir: tempRoot() });
    // No record of which adapter ran: nothing is guessed, exactly as before roles existed.
    expect((report.experiments ?? []).map((e) => e.role)).toEqual(["agent", "agent", "agent", "agent"]);
    // So the oracle's pass keeps e1 discriminating, as it did at schema 9.
    expect(report.pairs.every((pair) => pair.band === "discriminating")).toBeTrue();
  });

  test("a run that recorded no roles reads a real agent under a control's name as an agent", () => {
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
