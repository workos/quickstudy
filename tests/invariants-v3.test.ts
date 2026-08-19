/**
 * Cross-cutting v3 invariants: named-check determinism (same store → same
 * report; fresh identical seeds → identical reports), trial repetition
 * integrity, telemetry null-never-zero, and artifact refs resolving for
 * every completed attempt.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedRun } from "../scripts/seed-run.ts";
import { buildReport } from "../src/report/report.ts";
import { ResultsStore } from "../src/store/db.ts";

const GENERATED_AT = "2026-07-20T02:00:00.000Z";

function seeded() {
  const root = mkdtempSync(join(tmpdir(), "qs-invariants-"));
  const dbPath = join(root, "results.db");
  const resultsDir = join(root, "results");
  const { runId } = seedRun({ dbPath, resultsDir });
  return { root, dbPath, resultsDir, runId, store: new ResultsStore(dbPath) };
}

describe("determinism", () => {
  test("building the report twice from one store is byte-identical", () => {
    const { store, resultsDir, runId } = seeded();
    const first = buildReport({ store, runId, resultsDir, generatedAt: GENERATED_AT });
    const second = buildReport({ store, runId, resultsDir, generatedAt: GENERATED_AT });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    store.close();
  });

  test("two fresh seeds produce byte-identical reports (seeded ids + fixed clock)", () => {
    const a = seeded();
    const b = seeded();
    // The deterministic id stream is per-database, so fresh seeds mint
    // identical run ids — the regenerate-dev-data-twice property.
    expect(b.runId).toBe(a.runId);
    const reportA = buildReport({ store: a.store, runId: a.runId, resultsDir: a.resultsDir, generatedAt: GENERATED_AT });
    const reportB = buildReport({ store: b.store, runId: b.runId, resultsDir: b.resultsDir, generatedAt: GENERATED_AT });
    expect(JSON.stringify(reportB)).toBe(JSON.stringify(reportA));
    a.store.close();
    b.store.close();
  });
});

describe("trial repetition integrity", () => {
  test("every pair holds exactly trials attempts with trial indexes 0..n-1, each once", () => {
    const { store, runId } = seeded();
    const attempts = store.listAttempts(runId);
    const byPair = new Map<string, number[]>();
    for (const attempt of attempts) {
      const key = `${attempt.evalId}|${attempt.experimentId}`;
      const trials = byPair.get(key) ?? [];
      trials.push(attempt.trialIndex);
      byPair.set(key, trials);
    }
    expect(byPair.size).toBe(18);
    for (const trials of byPair.values()) {
      expect(trials.sort((x, y) => x - y)).toEqual([0, 1, 2]);
    }
    // Trials of one pair share the attempt identity hash by design.
    const hashesByPair = new Map<string, Set<string>>();
    for (const attempt of attempts) {
      const key = `${attempt.evalId}|${attempt.experimentId}`;
      const hashes = hashesByPair.get(key) ?? new Set<string>();
      hashes.add(attempt.attemptIdentityHash);
      hashesByPair.set(key, hashes);
    }
    for (const hashes of hashesByPair.values()) expect(hashes.size).toBe(1);
    store.close();
  });
});

describe("telemetry null-never-zero", () => {
  test("non-completed attempts carry NULL telemetry and the report sums only reporters", () => {
    const { store, resultsDir, runId } = seeded();
    const attempts = store.listAttempts(runId);
    const completed = attempts.filter((attempt) => attempt.status === "completed");
    for (const attempt of attempts) {
      if (attempt.status === "completed") continue;
      expect(attempt.costUsd).toBeNull();
      expect(attempt.tokensIn).toBeNull();
      expect(attempt.tokensOut).toBeNull();
      expect(attempt.surfaceUsage).toBeNull();
    }
    const report = buildReport({ store, runId, resultsDir });
    expect(report.telemetry.cost_attempts).toBe(completed.length);
    expect(report.telemetry.cost_usd).toBeCloseTo(completed.length * 0.11, 6);
    store.close();
  });
});

describe("artifact refs", () => {
  test("transcript and diff refs resolve on disk for every completed attempt", () => {
    const { store, runId } = seeded();
    const attempts = store.listAttempts(runId);
    for (const attempt of attempts.filter((candidate) => candidate.status === "completed")) {
      expect(attempt.transcriptRef).not.toBeNull();
      expect(existsSync(attempt.transcriptRef as string)).toBeTrue();
      expect(attempt.diffRef).not.toBeNull();
      expect(existsSync(attempt.diffRef as string)).toBeTrue();
    }
    store.close();
  });
});
