import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexCostUsage } from "../src/adapters/parse.ts";
import { exportSite } from "../src/export.ts";
import { attemptIdentityHash, type RunManifest } from "../src/manifest.ts";
import { parsePricing, readPricing, type Pricing } from "../src/report/costs.ts";
import { buildReport, renderReportText, writeReportJson, type ReportJson } from "../src/report/report.ts";
import { ResultsStore, type NewAttempt } from "../src/store/db.ts";

const START = Date.parse("2026-09-16T00:00:00Z");
const PRICING: Pricing = {
  version: "test-rates-v1", currency: "USD",
  rates: [{
    provider: "openai", model: "test-codex", effective_from: "2026-09-01T00:00:00Z",
    source: "https://example.com/pricing", input_usd_per_million: 2,
    cached_input_usd_per_million: 0.5, output_usd_per_million: 8,
  }],
};
const STREAMS = join(import.meta.dir, "__fixtures__/streams");
const modern = readFileSync(join(STREAMS, "codex-turns.jsonl"), "utf8");
const legacy = readFileSync(join(STREAMS, "codex-legacy.jsonl"), "utf8");

let root: string;
let store: ResultsStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qs-costs-"));
  store = new ResultsStore(join(root, "results.db"));
  const manifest: RunManifest = {
    manifestVersion: "v4", hash: "manifest",
    harness: { version: "test", revision: "test", dirty: false, source: { sha256: "source" } },
    evals: { eval: { id: "eval", hash: "eval", metadata: { id: "eval", suite: "benchmark" },
      components: { promptSource: "prompt", effectivePrompt: "prompt", local: null, scorer: "scorer", metadata: "metadata" } } },
    images: {}, experiments: {
      codex: { id: "codex", hash: "experiment", components: {
        source: "source", runtime: "runtime", image: null, treatment: null, harness: "source",
        agent: { adapter: "codex", provider: "openai", model: "test-codex", reasoning: "high", cliVersion: "test" },
      } },
    },
  };
  store.insertRun({ id: "run", startedAt: START, manifest, config: { trials: 1, evalIds: ["eval"], experimentIds: ["codex"] } });
  store.finishRun("run", START + 60_000);
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

function attempt(id: string, raw: string | null = modern, overrides: Partial<NewAttempt> = {}) {
  const dir = join(root, "run", id);
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, "transcript.jsonl");
  if (raw !== null) writeFileSync(transcript, raw);
  store.insertAttempt({
    id, runId: "run", evalId: "eval", experimentId: "codex", trialIndex: 0,
    suite: "benchmark", status: "completed", result: { passed: true, checks: [] },
    attemptIdentityHash: attemptIdentityHash({ evalId: "eval", experimentId: "codex", trialIndex: 0 }, store.getRun("run")!.manifest),
    startedAt: START, finishedAt: START + 10_000,
    transcriptRef: transcript, ...overrides,
  });
}
function report(pricing = PRICING) {
  return buildReport({ store, runId: "run", resultsDir: root, pricing: parsePricing(pricing) });
}

describe("Codex cost usage", () => {
  test("retains cache counts; sums thread turns but takes the last legacy cumulative count", () => {
    expect(parseCodexCostUsage(modern)).toEqual({ input_tokens: 2400, cached_input_tokens: 100, output_tokens: 100 });
    const earlier = legacy.replace('"input_tokens":3000', '"input_tokens":2000');
    expect(parseCodexCostUsage(earlier + legacy)).toEqual({ input_tokens: 3000, cached_input_tokens: 500, output_tokens: 150 });
  });
  test("missing, malformed and truncated streams are unknown, not free or partial totals", () => {
    for (const raw of ["", "garbage", modern + '{"type":', modern + '{"type":"turn.started"}',
      modern + '{"type":"turn.failed"}', legacy.replace(/.*task_complete.*\n?/, ""),
      modern.replace('"cached_input_tokens":100', '"cached_input_tokens":null'),
      modern.replace('"cached_input_tokens":100', '"cached_input_tokens":1000'),
      modern.replace('"cached_input_tokens":100', '"cached_input_tokens":-1'),
      modern.replace('"cached_input_tokens":100', '"cached_input_tokens":0.5'),
      modern.replace('"cached_input_tokens":100', '"cached_input_tokens":100,"cache_write_input_tokens":50'),
    ]) expect(parseCodexCostUsage(raw)).toBeNull();
  });
  test("does not add reasoning tokens on top of output and preserves genuine zero", () => {
    const event = (usage: object) => JSON.stringify({ type: "turn.completed", usage });
    expect(parseCodexCostUsage(event({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 8 })))
      .toEqual({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 10 });
    expect(parseCodexCostUsage(event({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 })))
      .toEqual({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 });
  });
});

describe("runtime pricing", () => {
  test("validates the file, including intervals, finite non-negative rates and ambiguous matches", () => {
    expect(parsePricing(PRICING)).toEqual(PRICING);
    for (const rate of [
      { input_usd_per_million: -1 }, { output_usd_per_million: Infinity },
      { effective_from: "yesterday" }, { effective_until: "2026-08-01T00:00:00Z" },
      { cached_input_usd_per_million: undefined },
    ]) expect(() => parsePricing({ ...PRICING, rates: [{ ...PRICING.rates[0], ...rate }] })).toThrow();
    expect(() => parsePricing({ ...PRICING, rates: [...PRICING.rates, ...PRICING.rates] })).toThrow(/overlap/);
    expect(() => parsePricing({ ...PRICING, currency: "EUR" })).toThrow();
    expect(() => readPricing(join(root, "missing.json"))).toThrow(/pricing/);
    writeFileSync(join(root, "bad.json"), "{");
    expect(() => readPricing(join(root, "bad.json"))).toThrow(/pricing/);
  });
  test("prices the run's date, not today's date; unknown models and dates remain unpriced", () => {
    attempt("a");
    const expired = { ...PRICING.rates[0]!, effective_until: "2026-09-16T00:00:00Z" };
    const current = { ...PRICING.rates[0]!, effective_from: "2026-09-16T00:00:00Z" };
    expect(report({ ...PRICING, rates: [expired, current] }).cost_estimate?.cost_usd).toBeCloseTo(0.00545, 10);
    for (const rate of [{ ...current, effective_from: "2026-09-17T00:00:00Z" }, expired, { ...current, model: "unknown" }]) {
      expect(report({ ...PRICING, rates: [rate] }).cost_estimate).toMatchObject({ cost_usd: null, cost_attempts: 0, unpriced_attempts: 1 });
    }
  });
});

describe("report and export", () => {
  test("keeps reported dollars separate, records provenance, and backfills without mutating the store", () => {
    attempt("a"); attempt("reported", modern, { costUsd: 1.25 }); attempt("missing", null);
    const before = store.listAttempts("run");
    const value = report();
    expect(value.telemetry.cost_usd).toBe(1.25);
    expect(value.telemetry.cost_attempts).toBe(1);
    expect(value.cost_estimate).toMatchObject({
      cost_usd: 0.00545, cost_attempts: 1, unpriced_attempts: 1, pricing: PRICING,
    });
    expect(value.cost_estimate?.attempts[0]).toMatchObject({ attempt_id: "a", usage: { cached_input_tokens: 100 } });
    expect(renderReportText(value)).toContain("estimated token cost:");
    expect(store.listAttempts("run")).toEqual(before);
    expect(report().cost_estimate).toEqual(value.cost_estimate);
    expect(buildReport({ store, runId: "run", resultsDir: root }).cost_estimate).toBeUndefined();
  });
  test("explicit retries do not double-count the superseded attempt", () => {
    attempt("a", modern, { status: "error", result: null });
    attempt("b", modern, { retryOf: "a" });
    expect(report().cost_estimate).toMatchObject({ cost_attempts: 1, unpriced_attempts: 0 });
  });
  test("rechecks changed transcripts and preserves the saved pricing through export", async () => {
    attempt("a"); writeReportJson(report(), root);
    const options = { store, resultsDir: root, runIds: ["run"], outDir: join(root, "site"), log: () => {} };
    const readExport = () => JSON.parse(readFileSync(join(options.outDir, "data/runs/run/report.json"), "utf8")) as ReportJson;
    await exportSite(options);
    expect(readExport().cost_estimate).toEqual(report().cost_estimate);
    writeFileSync(join(root, "run/a/transcript.jsonl"), "truncated");
    await exportSite(options);
    expect(readExport().cost_estimate).toMatchObject({ cost_usd: null, unpriced_attempts: 1 });
    writeFileSync(join(root, "run/a/transcript.jsonl"), modern);
    await exportSite({ ...options, pricing: parsePricing({ ...PRICING, rates: [{ ...PRICING.rates[0], input_usd_per_million: 4 }] }) });
    expect(readExport().cost_estimate?.cost_usd).toBeCloseTo(0.01005, 10);
  });
  test("publication exports keep the saved pricing for both selected and source reports", async () => {
    attempt("a"); writeReportJson(report(), root);
    const outDir = join(root, "publication");
    await exportSite({ store, resultsDir: root, runIds: ["run"], outDir, expectedTrials: 1, log: () => {} });
    for (const name of ["report.json", "source-report.json"]) {
      const exported = JSON.parse(readFileSync(join(outDir, "data/runs/run", name), "utf8")) as ReportJson;
      expect(exported.cost_estimate).toEqual(report().cost_estimate);
    }
  });
  test("restored canonical transcripts work even when the original absolute reference is gone", () => {
    attempt("a", modern, { transcriptRef: "/no-longer-mounted/run/a/transcript.jsonl" });
    expect(report().cost_estimate?.cost_attempts).toBe(1);
  });
  test("report --pricing works offline; report/export validate pricing before any other work", () => {
    attempt("a"); const prices = join(root, "pricing.json"); writeFileSync(prices, JSON.stringify(PRICING));
    const cli = (args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), ...args,
      "--db", join(root, "results.db"), "--results", root], { env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" } });
    const built = cli(["report", "run", "--json", "--pricing", prices]);
    expect(built.exitCode).toBe(0);
    expect(JSON.parse(built.stdout.toString()).cost_estimate.cost_usd).toBeCloseTo(0.00545, 10);
    for (const command of ["report", "export"]) {
      const bad = cli([command, "run", "--pricing", join(root, "missing.json")]);
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr.toString()).toContain("pricing");
      expect(bad.stderr.toString()).not.toContain(" at ");
    }
  });
});
