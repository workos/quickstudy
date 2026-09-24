#!/usr/bin/env bun
/**
 * Seed a two-run fixture DB + artifacts tailored for UI work, layered on
 * the seed-run playground:
 *
 *   - run A: the full seeded sweep (arm skews, a timeout error, an
 *     incomplete trial, a withheld codex group, regression suite), with ONE
 *     transcript replaced by a 600-turn monster (viewer responsiveness +
 *     windowed anchor navigation), a stored report.json written through
 *     the REAL report builder, and a deterministic diagnosis.json built
 *     from the real diagnosis types (findings across three targets,
 *     evidence deep links, one unanalyzable pair).
 *   - run B ("cell states"): a run crafted so the matrix shows a 0% cell,
 *     a 100% cell, a flaky cell, and an incomplete cell — the four states
 *     the heatmap must render distinctly. Run B stays diagnosis-LESS, so
 *     dev data and e2e exercise the Diagnosis view's empty state too.
 *
 * Used by `bun run ui:dev-data` (committed ui/dev-data) and the Playwright
 * fixture server, so dev and e2e look at the same shapes.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeDiagnosisJson } from "../src/diagnose/run.ts";
import {
  DIAGNOSIS_DISCLAIMER,
  DIAGNOSIS_PROMPT_VERSION,
  DIAGNOSIS_SCHEMA_VERSION,
  type DiagnosisJson,
} from "../src/diagnose/types.ts";
import { hashString } from "../src/hash.ts";
import { buildReport, writeReportJson } from "../src/report/report.ts";
import { ResultsStore, type AttemptStatus } from "../src/store/db.ts";
import type { CheckResult } from "../src/evals/types.ts";
import {
  buildSeedGroups,
  buildSeedManifest,
  SEED_EVALS,
  SEED_EXPERIMENTS,
  SEED_GENERATED_AT,
  seededIds,
  seedRun,
  type SeedExperimentSpec,
} from "./seed-run.ts";

const FIXTURES_DIR = join(import.meta.dir, "../tests/__fixtures__/transcripts");

export const LONG_TRANSCRIPT_TURNS = 600;
/** The tool-use error line the deep-link tests anchor on (1-indexed). */
export const LONG_TRANSCRIPT_ERROR_LINE = LONG_TRANSCRIPT_TURNS - 58;

/** 600 turns with a tool-use error deep in the tail — anchors land in the window. */
function longTranscript(): string {
  const lines: string[] = [];
  for (let turn = 1; turn <= LONG_TRANSCRIPT_TURNS; turn += 1) {
    if (turn === LONG_TRANSCRIPT_ERROR_LINE) {
      lines.push(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: `toolu_${turn}`,
                is_error: true,
                content: "Error: MCP server demanded interactive OAuth — no browser available in the container",
              },
            ],
          },
        }),
      );
      continue;
    }
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          id: `msg_${turn}`,
          role: "assistant",
          content: [{ type: "text", text: `step ${turn}: continuing the auth integration, checking configuration` }],
        },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Run B uses the claude docs/mcp experiments only. */
const CELL_STATE_EXPERIMENTS: readonly SeedExperimentSpec[] = SEED_EXPERIMENTS.filter(
  (spec) => spec.group === "claude" && spec.treatment !== "cli",
);

interface CellStateSpec {
  evalId: string;
  experimentId: string;
  passes: boolean[];
  /** Every trial hit its time limit; the tree each left was graded. */
  limitHit?: "timeout";
}

/** The heatmap states, unambiguous. */
const CELL_STATES: readonly CellStateSpec[] = [
  { evalId: "auth-nextjs", experimentId: "claude-docs", passes: [false, false, false] }, // 0%
  { evalId: "auth-rails", experimentId: "claude-docs", passes: [true, true, true] }, // 100%
  { evalId: "auth-django", experimentId: "claude-docs", passes: [true, false, true] }, // flaky
  { evalId: "auth-nextjs", experimentId: "claude-mcp", passes: [true] }, // incomplete (1/3)
  { evalId: "auth-rails", experimentId: "claude-mcp", passes: [false, false, false], limitHit: "timeout" }, // graded timeouts
];

/**
 * Deterministic diagnosis.json for the sweep run, built from the REAL
 * diagnosis types (compile error on shape drift). Findings span three
 * targets; the mcp finding's evidence cites the 600-turn transcript's
 * tool-error window — the proven e2e deep-link anchor — so the Diagnosis
 * view's evidence links land on an in-bounds highlighted range.
 */
function buildSeedDiagnosis(options: {
  runId: string;
  longTranscriptAttemptId: string;
  cliFailingAttemptId: string;
  diffAttemptId: string;
}): DiagnosisJson {
  return {
    schema_version: DIAGNOSIS_SCHEMA_VERSION,
    run_id: options.runId,
    generated_at: SEED_GENERATED_AT,
    model: { requested: "model-a-analyst", resolved: "model-a-analyst-20260601" },
    prompt_version: DIAGNOSIS_PROMPT_VERSION,
    disclaimer: DIAGNOSIS_DISCLAIMER,
    pairs_diagnosed: 3,
    pairs_skipped: 15,
    findings: [
      {
        eval_id: "auth-nextjs",
        experiment_id: "claude-mcp",
        target: "mcp",
        claim: "The MCP server demanded an interactive OAuth flow mid-run, which a headless container cannot complete.",
        suggested_change: "Offer a device-code or pre-provisioned token flow so headless MCP clients can authenticate.",
        confidence: "high",
        evidence: [
          {
            attempt_id: options.longTranscriptAttemptId,
            artifact: "transcript",
            lines: [LONG_TRANSCRIPT_ERROR_LINE, LONG_TRANSCRIPT_ERROR_LINE + 3],
          },
        ],
      },
      {
        eval_id: "auth-nextjs",
        experiment_id: "claude-cli",
        target: "cli",
        claim: "The failing CLI trial abandoned the scaffold output and fell back to web docs for the callback route.",
        suggested_change: "Include the framework-specific callback route in the CLI scaffold output.",
        confidence: "medium",
        evidence: [{ attempt_id: options.cliFailingAttemptId, artifact: "transcript", lines: [2, 6] }],
      },
      {
        eval_id: "auth-rails",
        experiment_id: "claude-mcp",
        target: "sdk",
        claim: "The generated change wires the session callback through a deprecated helper signature.",
        suggested_change: "Update the SDK helper example the integration guide embeds to the current signature.",
        confidence: "low",
        evidence: [{ attempt_id: options.diffAttemptId, artifact: "diff", lines: [1, 3] }],
      },
    ],
    errors: [
      {
        eval_id: "auth-django",
        experiment_id: "codex-mcp",
        error: "analyst response failed schema validation after one re-ask",
      },
    ],
  };
}

function cellStateChecks(passed: boolean): CheckResult[] {
  return [
    { name: "flow-wired", passed },
    { name: "build-passes", passed: true },
  ];
}

function seedCellStatesRun(store: ResultsStore, resultsDir: string): string {
  const startedAt = "2026-07-19T00:00:00.000Z";
  const startedAtMs = Date.parse(startedAt);
  const nextId = seededIds(startedAtMs);
  const runId = nextId();
  const manifest = buildSeedManifest(SEED_EVALS, CELL_STATE_EXPERIMENTS, "seed-site-cell-states");
  store.insertRun({
    id: runId,
    startedAt: startedAtMs,
    manifest,
    config: {
      trials: 3,
      evalIds: SEED_EVALS.map((spec) => spec.id),
      experimentIds: CELL_STATE_EXPERIMENTS.map((spec) => spec.id),
      egress: { proxy: false, allowlist: [] },
      groups: buildSeedGroups(CELL_STATE_EXPERIMENTS, manifest),
    },
  });

  let sequence = 0;
  for (const spec of CELL_STATES) {
    spec.passes.forEach((passed, trialIndex) => {
      sequence += 1;
      const attemptId = nextId();
      const attemptDir = join(resultsDir, runId, attemptId);
      mkdirSync(attemptDir, { recursive: true });

      const transcriptPath = join(attemptDir, "transcript.jsonl");
      copyFileSync(join(FIXTURES_DIR, passed ? "passing.jsonl" : "failing-cli.jsonl"), transcriptPath);
      const diffPath = join(attemptDir, "diff.patch");
      writeFileSync(
        diffPath,
        `--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -0,0 +1,1 @@\n+// ${spec.evalId} ${spec.experimentId} trial ${trialIndex}\n`,
        "utf8",
      );

      const status: AttemptStatus = "completed";
      const attemptStartedAt = startedAtMs + sequence * 60_000;
      const attemptFinishedAt = attemptStartedAt + 60_000 + sequence * 50;
      store.insertAttempt({
        id: attemptId,
        runId,
        evalId: spec.evalId,
        experimentId: spec.experimentId,
        suite: "benchmark",
        trialIndex,
        attemptIdentityHash: hashString(
          ["seed-site-attempt", manifest.evals[spec.evalId]?.hash ?? "", manifest.experiments[spec.experimentId]?.hash ?? ""].join("|"),
        ),
        status,
        result: { passed, checks: cellStateChecks(passed) },
        surfaceUsage: null,
        transcriptRef: transcriptPath,
        diffRef: diffPath,
        costUsd: 0.07,
        tokensIn: 100 + sequence,
        tokensOut: 900 + sequence,
        turns: 3 + (sequence % 4),
        startedAt: attemptStartedAt,
        finishedAt: attemptFinishedAt,
        agentStartedAt: attemptStartedAt + 5_000,
        agentFinishedAt: attemptFinishedAt - 3_000,
        ...(spec.limitHit !== undefined ? { limitHit: spec.limitHit } : {}),
      });
    });
  }
  store.finishRun(runId, Date.parse("2026-07-19T01:00:00.000Z"));
  return runId;
}

/** The trials-1 run's start: older than the cell-states run (2026-07-19). */
const N1_STARTED_AT = "2026-07-18T00:00:00.000Z";

export interface SeedSiteResult {
  dbPath: string;
  resultsDir: string;
  /**
   * [full sweep run, cell-states run, trials-1 run] — meta lists them in
   * that order (newest first), so the sweep stays the default run.
   */
  runIds: [string, string, string];
  /** The 600-turn transcript's attempt (transcript deep-link target). */
  longTranscriptAttemptId: string;
  /** An attempt with a diff artifact (diff deep-link target). */
  diffAttemptId: string;
}

/** Seed the fixture DB + artifacts + stored reports into `root`. */
export function seedSite(root: string): SeedSiteResult {
  const dbPath = join(root, "results.db");
  const resultsDir = join(root, "results");
  // Regression suite included: the dev/e2e data must exercise the suite
  // toggle and the tagged pair rows.
  const seeded = seedRun({ dbPath, resultsDir, withRegression: true });
  // A one-trial run (each pair's first outcome) so Compare's not-comparable
  // notice ships in dev data and e2e. Started before the cell-states run so
  // it sorts oldest and never becomes the default run.
  const n1 = seedRun({ dbPath, resultsDir, trials: 1, idSalt: "n1", startedAt: N1_STARTED_AT });

  const store = new ResultsStore(dbPath);
  try {
    const cellStatesRunId = seedCellStatesRun(store, resultsDir);

    // Swap in the long transcript on a failing claude/mcp attempt.
    const attempts = store.listAttempts(seeded.runId);
    const longAttempt = attempts.find(
      (attempt) =>
        attempt.experimentId === "claude-mcp" && attempt.evalId === "auth-nextjs" && attempt.trialIndex === 0,
    );
    if (!longAttempt?.transcriptRef) throw new Error("seed invariant broken: no claude-mcp/auth-nextjs trial 0 attempt");
    writeFileSync(longAttempt.transcriptRef, longTranscript(), "utf8");

    const diffAttempt = attempts.find(
      (attempt) =>
        attempt.experimentId === "claude-mcp" && attempt.evalId === "auth-rails" && attempt.trialIndex === 0,
    );
    if (!diffAttempt?.diffRef) throw new Error("seed invariant broken: no claude-mcp/auth-rails trial 0 diff");

    // The flaky cli arm's failing trial (its 10-line fixture transcript keeps
    // the cited evidence window in-bounds).
    const cliFailingAttempt = attempts.find(
      (attempt) =>
        attempt.experimentId === "claude-cli" && attempt.evalId === "auth-nextjs" && attempt.result?.passed === false,
    );
    if (!cliFailingAttempt?.transcriptRef) {
      throw new Error("seed invariant broken: no failing claude-cli/auth-nextjs attempt");
    }

    // Stored reports through the REAL builder — the export embeds them
    // verbatim, so dev/e2e exercise the exact artifact `quickstudy report`
    // writes.
    writeReportJson(buildReport({ store, runId: seeded.runId, resultsDir, generatedAt: SEED_GENERATED_AT }), resultsDir);
    writeReportJson(buildReport({ store, runId: cellStatesRunId, resultsDir, generatedAt: SEED_GENERATED_AT }), resultsDir);
    writeReportJson(buildReport({ store, runId: n1.runId, resultsDir, generatedAt: SEED_GENERATED_AT }), resultsDir);

    // Diagnosis fixture on the sweep run ONLY — the cell-states run stays
    // diagnosis-less so both view states ship in dev data and e2e.
    writeDiagnosisJson(
      buildSeedDiagnosis({
        runId: seeded.runId,
        longTranscriptAttemptId: longAttempt.id,
        cliFailingAttemptId: cliFailingAttempt.id,
        diffAttemptId: diffAttempt.id,
      }),
      resultsDir,
    );

    return {
      dbPath,
      resultsDir,
      runIds: [seeded.runId, cellStatesRunId, n1.runId],
      longTranscriptAttemptId: longAttempt.id,
      diffAttemptId: diffAttempt.id,
    };
  } finally {
    store.close();
  }
}
