/**
 * Outcome taxonomy: graded timeouts (limit), error-kind classification per
 * stage, agent-phase timestamps, the additive column repair, and the export
 * mapping onto run.json attempts.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/adapters/types.ts";
import { discoverEvals } from "../src/evals/discovery.ts";
import type { LoadedEval } from "../src/evals/types.ts";
import type { LoadedExperiment } from "../src/experiments/types.ts";
import type { DataRun } from "../src/export-types.ts";
import { exportSite } from "../src/export.ts";
import type { RunManifest } from "../src/manifest.ts";
import { planRun } from "../src/plan.ts";
import { errorKindOf, executeRunV3, StageFailure } from "../src/runner/execute.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore, type NewAttempt } from "../src/store/db.ts";
import { SCHEMA_SQL } from "../src/store/schema.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const silent = (): void => {};
const NEW_COLUMNS = ["limit_hit", "error_kind", "agent_started_at", "agent_finished_at"];

function syntheticManifest(): RunManifest {
  return {
    manifestVersion: "v3",
    harness: { version: "test", revision: "test", dirty: false, source: { sha256: "0".repeat(64) } },
    evals: {},
    experiments: {},
    images: {},
    hash: "1".repeat(64),
  };
}

const CONFIG = { trials: 1, evalIds: ["hello-local"], experimentIds: ["echo-local"] };

function baseAttempt(id: string, overrides: Partial<NewAttempt> = {}): NewAttempt {
  return {
    id,
    runId: "01RUN",
    evalId: "hello-local",
    experimentId: "echo-local",
    suite: "benchmark",
    trialIndex: 0,
    attemptIdentityHash: "2".repeat(64),
    status: "completed",
    result: { passed: true, checks: [] },
    ...overrides,
  };
}

function makeStores(): { root: string; store: ResultsStore; artifacts: ArtifactsStore } {
  const root = mkdtempSync(join(tmpdir(), "qs-outcome-"));
  return { root, store: new ResultsStore(join(root, "results.db")), artifacts: new ArtifactsStore(join(root, "results")) };
}

function writeTmpEval(root: string, id: string, evalTs: string): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PROMPT.md"), `---\nid: ${id}\nsuite: benchmark\n---\n\nDo the ${id} task.\n`);
  writeFileSync(join(dir, "EVAL.ts"), evalTs);
}

function hostExperiment(id: string, adapter: string): LoadedExperiment {
  const dir = mkdtempSync(join(tmpdir(), "qs-exp-"));
  const path = join(dir, `${id}.ts`);
  writeFileSync(path, `export default { id: "${id}", agent: { adapter: "${adapter}" }, runtime: { kind: "host" } };\n`);
  return { experiment: { id, agent: { adapter }, runtime: { kind: "host" } }, path };
}

function helloLocal(): LoadedEval[] {
  return discoverEvals(join(FIXTURES, "evals")).filter((entry) => entry.metadata.id === "hello-local");
}

async function runOne(evals: LoadedEval[], adapter: AgentAdapter, extra: { attemptTimeoutMs?: number } = {}) {
  const experiment = hostExperiment(`${adapter.name}-x`, adapter.name);
  const { store, artifacts, root } = makeStores();
  const summary = await executeRunV3({
    evals,
    experiments: [experiment],
    plan: planRun(evals, [experiment.experiment], 1),
    store,
    artifacts,
    hostAdapters: { [adapter.name]: adapter },
    log: silent,
    ...extra,
  });
  const attempt = store.listAttempts(summary.runId)[0]!;
  return { summary, attempt, store, artifacts, root };
}

const OK_OUTCOME = { transcript: [], diff: "", metrics: { tokensIn: null, tokensOut: null, turns: 0 } };

describe("store", () => {
  test("all four fields round-trip", () => {
    const store = new ResultsStore(":memory:");
    store.insertRun({ id: "01RUN", startedAt: 1, config: CONFIG, manifest: syntheticManifest() });
    store.insertAttempt(baseAttempt("01A", { status: "error", result: null, error: "boom", limitHit: "timeout", errorKind: "scorer", agentStartedAt: 1_000, agentFinishedAt: 2_000 }));
    const row = store.listAttempts("01RUN")[0]!;
    expect(row).toMatchObject({ limitHit: "timeout", errorKind: "scorer", agentStartedAt: 1_000, agentFinishedAt: 2_000 });
    store.close();
  });

  test("omitted fields read back null", () => {
    const store = new ResultsStore(":memory:");
    store.insertRun({ id: "01RUN", startedAt: 1, config: CONFIG, manifest: syntheticManifest() });
    store.insertAttempt(baseAttempt("01A"));
    const row = store.listAttempts("01RUN")[0]!;
    expect(row).toMatchObject({ limitHit: null, errorKind: null, agentStartedAt: null, agentFinishedAt: null });
    store.close();
  });

  test("unknown error_kind / limit_hit values read as null", () => {
    const path = join(mkdtempSync(join(tmpdir(), "qs-outcome-store-")), "results.db");
    const store = new ResultsStore(path);
    store.insertRun({ id: "01RUN", startedAt: 1, config: CONFIG, manifest: syntheticManifest() });
    store.insertAttempt(baseAttempt("01A", { status: "error", result: null }));
    store.close();
    const raw = new Database(path);
    raw.exec("UPDATE attempts SET error_kind = 'cosmic-ray', limit_hit = 'tokens'");
    raw.close();
    const reopened = new ResultsStore(path);
    expect(reopened.listAttempts("01RUN")[0]).toMatchObject({ errorKind: null, limitHit: null });
    reopened.close();
  });

  test("a v3 database without the columns opens and gains them (rows keep NULL)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "qs-outcome-store-")), "legacy.db");
    const legacy = new Database(path, { create: true });
    let stripped = SCHEMA_SQL;
    for (const column of NEW_COLUMNS) stripped = stripped.replace(new RegExp(`\\n\\s*${column} [A-Z]+,?[^\\n]*`), "");
    stripped = stripped.replace("error TEXT,", "error TEXT");
    legacy.exec(stripped);
    const before = legacy.query<{ name: string }, []>("SELECT name FROM pragma_table_info('attempts')").all().map((c) => c.name);
    for (const column of NEW_COLUMNS) expect(before).not.toContain(column);
    legacy.exec("INSERT INTO runs (id, started_at, config_json, manifest_json, manifest_hash) VALUES ('01RUN', 1, '{}', '{}', 'h')");
    legacy.exec(
      "INSERT INTO attempts (id, run_id, eval_id, experiment_id, trial_index, attempt_identity_hash, status) VALUES ('01OLD', '01RUN', 'e', 'x', 0, 'h', 'completed')",
    );
    legacy.exec("PRAGMA user_version = 3;");
    legacy.close();

    const store = new ResultsStore(path);
    store.close();
    const check = new Database(path, { readonly: true });
    const after = check.query<{ name: string }, []>("SELECT name FROM pragma_table_info('attempts')").all().map((c) => c.name);
    check.close();
    for (const column of NEW_COLUMNS) expect(after).toContain(column);
    const reopened = new ResultsStore(path);
    expect(reopened.listAttempts("01RUN")[0]).toMatchObject({ limitHit: null, errorKind: null, agentStartedAt: null, agentFinishedAt: null });
    reopened.close();
  });
});

describe("error kinds", () => {
  test("an adapter that throws → agent", async () => {
    const thrower: AgentAdapter = { name: "thrower", runAttempt: async () => { throw new Error("agent crashed"); } };
    const { attempt, store } = await runOne(helloLocal(), thrower);
    expect(attempt.status).toBe("error");
    expect(attempt.errorKind).toBe("agent");
    expect(attempt.error).toContain("agent crashed");
    store.close();
  });

  test("a scorer that throws → scorer", async () => {
    const root = mkdtempSync(join(tmpdir(), "qs-outcome-evals-"));
    writeTmpEval(root, "boom", `export default async () => { throw new Error("scorer exploded"); };\n`);
    const ok: AgentAdapter = { name: "ok", runAttempt: async () => OK_OUTCOME };
    const { attempt, store } = await runOne(discoverEvals(root), ok);
    expect(attempt.status).toBe("error");
    expect(attempt.errorKind).toBe("scorer");
    expect(attempt.error).toContain("scorer exploded");
    store.close();
  });

  // An unreadable directory the identity hash skips (node_modules) but the
  // workspace copy must read: the starting state cannot be prepared. Root
  // ignores permissions, so the case only holds for an unprivileged user.
  test.skipIf(process.getuid?.() === 0)("an unpreparable local/ starting state → environment", async () => {
    const localDir = mkdtempSync(join(tmpdir(), "qs-outcome-local-"));
    writeFileSync(join(localDir, "README.md"), "hello-local starting state\n");
    const locked = join(localDir, "node_modules");
    mkdirSync(locked);
    writeFileSync(join(locked, "dep.js"), "x\n");
    chmodSync(locked, 0o000);
    try {
      const evals = helloLocal().map((entry) => ({ ...entry, localDir }));
      const ok: AgentAdapter = { name: "ok", runAttempt: async () => OK_OUTCOME };
      const { attempt, store } = await runOne(evals, ok);
      expect(attempt.status).toBe("error");
      expect(attempt.errorKind).toBe("environment");
      store.close();
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("a bare error reaching a catch-all → harness; a StageFailure keeps its stage", () => {
    expect(errorKindOf(new Error("bug"))).toBe("harness");
    expect(errorKindOf("not even an error")).toBe("harness");
    const failure = new StageFailure("environment", new Error("docker create failed"));
    expect(errorKindOf(failure)).toBe("environment");
    expect(failure.message).toBe("docker create failed");
  });

  test("a completed attempt has error_kind null and agent timestamps", async () => {
    const ok: AgentAdapter = {
      name: "writer",
      runAttempt: async (ctx) => {
        cpSync(ctx.fixtureDir, ctx.workspaceDir, { recursive: true });
        writeFileSync(join(ctx.workspaceDir, "NOTES.md"), "Notes\n");
        return OK_OUTCOME;
      },
    };
    const { attempt, store } = await runOne(helloLocal(), ok);
    expect(attempt.status).toBe("completed");
    expect(attempt.errorKind).toBeNull();
    expect(attempt.limitHit).toBeNull();
    expect(attempt.agentStartedAt).not.toBeNull();
    expect(attempt.agentFinishedAt!).toBeGreaterThanOrEqual(attempt.agentStartedAt!);
    expect(attempt.agentStartedAt!).toBeGreaterThanOrEqual(attempt.startedAt!);
    expect(attempt.agentFinishedAt!).toBeLessThanOrEqual(attempt.finishedAt!);
    store.close();
  });
});

describe("graded timeout", () => {
  test("a timed-out agent's written tree is scored: completed, passed, limit timeout", async () => {
    const stall: AgentAdapter = {
      name: "stall-writer",
      runAttempt: async (ctx) => {
        cpSync(ctx.fixtureDir, ctx.workspaceDir, { recursive: true });
        writeFileSync(join(ctx.workspaceDir, "NOTES.md"), "Notes\n");
        return new Promise(() => {});
      },
    };
    const { summary, attempt, store } = await runOne(helloLocal(), stall, { attemptTimeoutMs: 50 });
    expect(summary).toMatchObject({ passed: 1, incomplete: 0, errors: 0 });
    expect(attempt.status).toBe("completed");
    expect(attempt.limitHit).toBe("timeout");
    expect(attempt.errorKind).toBeNull();
    expect(attempt.result?.passed).toBe(true);
    expect(attempt.result?.checks.every((check) => check.passed)).toBe(true);
    expect(attempt.agentStartedAt).not.toBeNull();
    expect(attempt.agentFinishedAt!).toBeGreaterThanOrEqual(attempt.agentStartedAt!);
    expect(attempt.transcriptRef).toBeNull();
    expect(attempt.diffRef).toBeNull();
    store.close();
  });

  test("a timed-out agent that wrote nothing is scored on the empty tree: completed, failed", async () => {
    const stall: AgentAdapter = { name: "stall-idle", runAttempt: () => new Promise(() => {}) };
    const { summary, attempt, store } = await runOne(helloLocal(), stall, { attemptTimeoutMs: 50 });
    expect(summary).toMatchObject({ failed: 1, incomplete: 0, errors: 0 });
    expect(attempt.status).toBe("completed");
    expect(attempt.limitHit).toBe("timeout");
    expect(attempt.result?.passed).toBe(false);
    expect(attempt.result?.checks.length).toBeGreaterThan(0);
    store.close();
  });
});

describe("export mapping", () => {
  test("run.json attempts carry limit, error_kind and ISO agent timestamps; null when absent", async () => {
    const { root, store } = makeStores();
    store.insertRun({ id: "01RUN", startedAt: 1, config: CONFIG, manifest: syntheticManifest() });
    const agentStartedAt = Date.parse("2026-07-01T00:00:05.000Z");
    const agentFinishedAt = Date.parse("2026-07-01T00:01:00.000Z");
    store.insertAttempt(baseAttempt("01A", { result: { passed: false, checks: [] }, limitHit: "timeout", agentStartedAt, agentFinishedAt }));
    store.insertAttempt(baseAttempt("01B", { status: "error", result: null, error: "scorer threw: x", errorKind: "scorer", trialIndex: 1 }));
    store.insertAttempt(baseAttempt("01C", { trialIndex: 2 }));
    store.finishRun("01RUN", 2);

    const outDir = join(root, "site");
    await exportSite({ store, resultsDir: join(root, "results"), runIds: ["01RUN"], outDir, log: silent });
    const run = JSON.parse(readFileSync(join(outDir, "data", "runs", "01RUN", "run.json"), "utf8")) as DataRun & { attempts: Array<Record<string, unknown>> };
    const byId = new Map(run.attempts.map((attempt) => [attempt["id"], attempt]));
    expect(byId.get("01A")).toMatchObject({ limit: "timeout", error_kind: null, agent_started_at: "2026-07-01T00:00:05.000Z", agent_finished_at: "2026-07-01T00:01:00.000Z" });
    expect(byId.get("01B")).toMatchObject({ limit: null, error_kind: "scorer", agent_started_at: null, agent_finished_at: null });
    expect(byId.get("01C")).toMatchObject({ limit: null, error_kind: null, agent_started_at: null, agent_finished_at: null });
    store.close();
  });
});
