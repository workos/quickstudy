import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunManifest } from "../src/manifest.ts";
import { ResultsStore, storeSchemaVersion } from "../src/store/db.ts";

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

describe("v3 results store", () => {
  test("run + attempt round-trip, null telemetry stays null (never 0)", () => {
    const store = new ResultsStore(":memory:");
    const manifest = syntheticManifest();
    store.insertRun({ id: "01RUN", startedAt: 1_754_000_000_000, config: CONFIG, manifest });
    store.insertAttempt({
      id: "01ATTEMPT",
      runId: "01RUN",
      evalId: "hello-local",
      experimentId: "echo-local",
      suite: "benchmark",
      trialIndex: 0,
      attemptIdentityHash: "2".repeat(64),
      status: "completed",
      result: { passed: true, checks: [{ name: "notes-written", passed: true }] },
      transcriptRef: "/tmp/transcript.jsonl",
      tokensIn: null,
      tokensOut: null,
      turns: null,
      costUsd: null,
    });
    store.finishRun("01RUN", 1_754_000_060_000);

    const run = store.getRun("01RUN");
    expect(run?.startedAt).toBe(1_754_000_000_000);
    expect(run?.finishedAt).toBe(1_754_000_060_000);
    expect(run?.config).toEqual(CONFIG);
    expect(run?.manifest.hash).toBe(manifest.hash);
    expect(run?.manifestHash).toBe(manifest.hash);

    const attempts = store.listAttempts("01RUN");
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt.status).toBe("completed");
    expect(attempt.result?.passed).toBe(true);
    expect(attempt.result?.checks[0]?.name).toBe("notes-written");
    expect(attempt.tokensIn).toBeNull();
    expect(attempt.tokensOut).toBeNull();
    expect(attempt.turns).toBeNull();
    expect(attempt.costUsd).toBeNull();
    expect(attempt.error).toBeNull();
    store.close();
  });

  test("turns round-trip as a number and stay NULL when omitted", () => {
    const store = new ResultsStore(":memory:");
    store.insertRun({ id: "01RUN", startedAt: 1, config: CONFIG, manifest: syntheticManifest() });
    const base = {
      runId: "01RUN",
      evalId: "hello-local",
      experimentId: "echo-local",
      suite: "benchmark" as const,
      attemptIdentityHash: "2".repeat(64),
      status: "completed" as const,
      result: { passed: true, checks: [] },
    };
    store.insertAttempt({ ...base, id: "01STEPPED", trialIndex: 0, turns: 7 });
    store.insertAttempt({ ...base, id: "01SCRIPTED", trialIndex: 1 });
    const attempts = store.listAttempts("01RUN");
    expect(attempts.find((attempt) => attempt.id === "01STEPPED")?.turns).toBe(7);
    expect(attempts.find((attempt) => attempt.id === "01SCRIPTED")?.turns).toBeNull();
    store.close();
  });

  test("a v3 database created before the turns column gains it additively (rows keep NULL)", () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-store-v3-"));
    const path = join(dir, "pre-turns.db");
    const legacy = new Database(path, { create: true });
    // The v3 attempts shape as shipped before `turns` existed.
    legacy.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER,
      config_json TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_hash TEXT NOT NULL
    );
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), eval_id TEXT NOT NULL,
      experiment_id TEXT NOT NULL, suite TEXT NOT NULL DEFAULT 'benchmark', trial_index INTEGER NOT NULL,
      attempt_identity_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, surface_usage_json TEXT,
      transcript_ref TEXT, diff_ref TEXT, cost_usd REAL, tokens_in INTEGER, tokens_out INTEGER,
      started_at INTEGER, finished_at INTEGER, error TEXT
    );`);
    legacy.exec("PRAGMA user_version = 3;");
    legacy.close();

    const store = new ResultsStore(path);
    store.insertRun({ id: "01RUN", startedAt: 1, config: CONFIG, manifest: syntheticManifest() });
    store.insertAttempt({
      id: "01NEW",
      runId: "01RUN",
      evalId: "hello-local",
      experimentId: "echo-local",
      suite: "benchmark",
      trialIndex: 0,
      attemptIdentityHash: "2".repeat(64),
      status: "completed",
      result: { passed: true, checks: [] },
      turns: 3,
    });
    expect(store.listAttempts("01RUN")[0]?.turns).toBe(3);
    store.close();
    expect(storeSchemaVersion(path)).toBe(3);
  });

  test("surface usage round-trips; omitted usage stays NULL (never zero-filled)", () => {
    const store = new ResultsStore(":memory:");
    store.insertRun({ id: "01RUN", startedAt: 1, config: CONFIG, manifest: syntheticManifest() });
    const base = {
      runId: "01RUN",
      evalId: "hello-local",
      experimentId: "echo-local",
      suite: "benchmark" as const,
      attemptIdentityHash: "2".repeat(64),
      status: "completed" as const,
      result: { passed: true, checks: [] },
    };
    store.insertAttempt({
      ...base,
      id: "01USED",
      trialIndex: 0,
      surfaceUsage: { docs: { count: 1, urls: ["https://docs.example.test/x"] }, mcp: { count: 0, tools: [] }, cli: { count: 0, commands: [] } },
    });
    store.insertAttempt({ ...base, id: "01NONE", trialIndex: 1 });
    const attempts = store.listAttempts("01RUN");
    expect(attempts.find((attempt) => attempt.id === "01USED")?.surfaceUsage?.docs.count).toBe(1);
    expect(attempts.find((attempt) => attempt.id === "01NONE")?.surfaceUsage).toBeNull();
    store.close();
  });

  test("run-config comparison groups (withhold-and-diff state) round-trip", () => {
    const store = new ResultsStore(":memory:");
    const groups = [
      {
        group: "alpha",
        experimentIds: ["a-docs", "a-mcp"],
        comparison: "withheld" as const,
        mismatches: [{ path: "identity.agent.model", a: "m1", b: "m2" }],
        details: ['alpha: a-docs vs a-mcp: identity.agent.model changed ("m1" -> "m2")'],
      },
    ];
    store.insertRun({ id: "01RUN", startedAt: 1, config: { ...CONFIG, groups }, manifest: syntheticManifest() });
    expect(store.getRun("01RUN")?.config.groups).toEqual(groups);
    store.close();
  });

  test("latestRun returns the newest run and null on an empty database", () => {
    const store = new ResultsStore(":memory:");
    expect(store.latestRun()).toBeNull();
    store.insertRun({ id: "01OLD", startedAt: 1, config: CONFIG, manifest: syntheticManifest() });
    store.insertRun({ id: "01NEW", startedAt: 2, config: CONFIG, manifest: syntheticManifest() });
    expect(store.latestRun()?.id).toBe("01NEW");
    expect(store.listRuns().map((run) => run.id)).toEqual(["01NEW", "01OLD"]);
    store.close();
  });

  test("a v2 database is refused with archive/export instructions, never migrated", () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-store-v3-"));
    const path = join(dir, "v2.db");
    const legacy = new Database(path, { create: true });
    legacy.exec("CREATE TABLE runs (id TEXT PRIMARY KEY); CREATE TABLE attempts (id TEXT PRIMARY KEY);");
    legacy.exec("PRAGMA user_version = 2;");
    legacy.close();

    expect(() => new ResultsStore(path)).toThrow(/schema v2/);
    try {
      new ResultsStore(path);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(path);
      expect(message.toLowerCase()).toContain("archive");
      expect(message.toLowerCase()).toContain("export");
      expect(message).not.toMatch(/migrat(e|ing) (the|your) database/);
    }
    // Refusal must not have touched the file.
    expect(storeSchemaVersion(path)).toBe(2);
  });

  test("a fresh file is created at user_version 3 and reopens cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-store-v3-"));
    const path = join(dir, "fresh.db");
    const store = new ResultsStore(path);
    store.insertRun({ id: "01RUN", startedAt: 1, config: CONFIG, manifest: syntheticManifest() });
    store.close();

    expect(storeSchemaVersion(path)).toBe(3);
    const reopened = new ResultsStore(path);
    expect(reopened.getRun("01RUN")?.id).toBe("01RUN");
    reopened.close();
  });
});
