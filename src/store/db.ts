/**
 * bun:sqlite results store for the eval × experiment schema (v3, THE schema —
 * the legacy five-axis store was deleted with the authoring stack).
 * Concurrency contract: single writer, WAL so readers never block on the
 * writer.
 *
 * Schema versioning is enforced by refusal: a database whose tables exist at
 * any other user_version is refused with archive/export instructions, never
 * migrated.
 */

import { Database } from "bun:sqlite";
import type { EvalResult, EvalSuite } from "../evals/types.ts";
import type { ComparisonGroup } from "../experiments/groups.ts";
import type { RunManifest } from "../manifest.ts";
import type { SurfaceUsage, SurfaceUsageConfig } from "../surface-usage.ts";
import { SCHEMA_SQL } from "./schema.ts";

export type AttemptStatus = "completed" | "incomplete" | "error";

/** Which stage failed when an attempt's status is "error". */
export const ERROR_KINDS = ["environment", "agent", "scorer", "harness"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];
/** Which limit an attempt hit; the tree it left behind was still graded. */
export type LimitKind = "timeout";

function toErrorKind(value: string | null): ErrorKind | null {
  return value !== null && (ERROR_KINDS as readonly string[]).includes(value) ? (value as ErrorKind) : null;
}

function toLimitKind(value: string | null): LimitKind | null {
  return value === "timeout" ? value : null;
}

/** The run-level configuration recorded in `runs.config_json`. */
export interface RunConfig {
  scheduler?: { concurrency: number; seed: string; policy: "seeded-hash-v1"; order: import("../plan.ts").AttemptPlan[] };
  trials: number;
  evalIds: string[];
  experimentIds: string[];
  evalsRoot?: string;
  experimentsRoot?: string;
  /** Egress policy the run enforced — what it could reach is part of its record. */
  egress?: { proxy: boolean; allowlist: string[] };
  /**
   * The comparison groups computed at run time (withhold-and-diff state
   * included). Recorded here — NOT in the manifest — so reading them back
   * never perturbs run identity; the report and the Compare view render
   * exactly what the run saw.
   */
  groups?: ComparisonGroup[];
  /**
   * Offered surfaces per experiment id (docs hosts, CLI commands, MCP server
   * names), recorded at run time like `egress` — what a run offered is part
   * of its record. Absent on older runs and when nothing was declared
   * (absent ≠ empty-offered).
   */
  surfaces?: Record<string, SurfaceUsageConfig>;
}

export interface RunRecord {
  id: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** NULL means the run is incomplete; reporting warns loudly. */
  finishedAt: number | null;
  config: RunConfig;
  manifest: RunManifest;
  manifestHash: string;
}

/** Everything the runner persists for one attempt. */
export interface NewAttempt {
  /** Explicit retry of a non-completed trial; original evidence is retained. */
  retryOf?: string | null;
  judgeRecords?: import("../evals/types.ts").JudgeRecord[];
  id: string;
  runId: string;
  evalId: string;
  experimentId: string;
  suite: EvalSuite;
  trialIndex: number;
  attemptIdentityHash: string;
  status: AttemptStatus;
  result?: EvalResult | null;
  /** Omitted or null = no supported raw stream — stored as NULL, never as an all-zero object. */
  surfaceUsage?: SurfaceUsage | null;
  transcriptRef?: string | null;
  diffRef?: string | null;
  /** Omitted or null = telemetry unavailable — stored as NULL, never as 0. */
  costUsd?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Agent steps (adapter-counted); omitted or null = no parseable stream. */
  turns?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  error?: string | null;
  /** "timeout" = the agent hit its wall-clock limit and the tree it left was graded (column limit_hit). */
  limitHit?: LimitKind | null;
  /** Which stage failed; set only when status = "error". */
  errorKind?: ErrorKind | null;
  /** Agent phase only, epoch ms; null = not recorded. */
  agentStartedAt?: number | null;
  agentFinishedAt?: number | null;
}

export interface AttemptRecord {
  retryOf?: string | null;
  judgeRecords?: import("../evals/types.ts").JudgeRecord[];
  id: string;
  runId: string;
  evalId: string;
  experimentId: string;
  suite: EvalSuite;
  trialIndex: number;
  attemptIdentityHash: string;
  status: AttemptStatus;
  result: EvalResult | null;
  surfaceUsage: SurfaceUsage | null;
  transcriptRef: string | null;
  diffRef: string | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  turns: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  /** "timeout" = the agent hit its wall-clock limit and the tree it left was graded (column limit_hit). */
  limitHit?: LimitKind | null;
  /** Which stage failed; set only when status = "error". */
  errorKind?: ErrorKind | null;
  /** Agent phase only, epoch ms; null = not recorded. */
  agentStartedAt?: number | null;
  agentFinishedAt?: number | null;
}

interface RunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  config_json: string;
  manifest_json: string;
  manifest_hash: string;
}

interface AttemptRow {
  retry_of: string | null;
  judge_usage_json: string | null;
  id: string;
  run_id: string;
  eval_id: string;
  experiment_id: string;
  suite: string;
  trial_index: number;
  attempt_identity_hash: string;
  status: string;
  result_json: string | null;
  surface_usage_json: string | null;
  transcript_ref: string | null;
  diff_ref: string | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  turns: number | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  limit_hit: string | null;
  error_kind: string | null;
  agent_started_at: number | null;
  agent_finished_at: number | null;
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    config: JSON.parse(row.config_json) as RunConfig,
    manifest: JSON.parse(row.manifest_json) as RunManifest,
    manifestHash: row.manifest_hash,
  };
}

function toAttemptRecord(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    ...(row.judge_usage_json ? { judgeRecords: JSON.parse(row.judge_usage_json) } : {}),
    ...(row.retry_of ? { retryOf: row.retry_of } : {}),
    runId: row.run_id,
    evalId: row.eval_id,
    experimentId: row.experiment_id,
    suite: row.suite as EvalSuite,
    trialIndex: row.trial_index,
    attemptIdentityHash: row.attempt_identity_hash,
    status: row.status as AttemptStatus,
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as EvalResult),
    surfaceUsage: row.surface_usage_json === null ? null : (JSON.parse(row.surface_usage_json) as SurfaceUsage),
    transcriptRef: row.transcript_ref,
    diffRef: row.diff_ref,
    costUsd: row.cost_usd,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    turns: row.turns,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    limitHit: toLimitKind(row.limit_hit ?? null),
    errorKind: toErrorKind(row.error_kind ?? null),
    agentStartedAt: row.agent_started_at ?? null,
    agentFinishedAt: row.agent_finished_at ?? null,
  };
}

/** Read a database file's schema version without creating or migrating it. */
export function storeSchemaVersion(path: string): number | null {
  try {
    const db = new Database(path, { readonly: true });
    try {
      return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export class ResultsStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    const existing = this.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('runs', 'attempts')")
      .all();
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (existing.length > 0 && version !== 3) {
      this.db.close();
      throw new Error(
        `results database at ${path} uses schema v${version || "legacy"}; this command requires schema v3.\n` +
          `Old results are never migrated. Either archive the database and keep your previous quickstudy\n` +
          `binary to read it, or run \`quickstudy export\` with that binary first — then point --db at a\n` +
          `fresh file for v3 runs.`,
      );
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
    // Additive column repair within v3: `turns` joined the schema after v3
    // shipped. Adding a nullable column rewrites nothing — existing rows read
    // NULL, the standard "telemetry unavailable" value — so this is not the
    // cross-version migration the refusal above exists to prevent.
    const attemptColumns = this.db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('attempts')")
      .all()
      .map((column) => column.name);
    if (!attemptColumns.includes("turns")) {
      this.db.exec("ALTER TABLE attempts ADD COLUMN turns INTEGER;");
    }
    if (!attemptColumns.includes("judge_usage_json")) this.db.exec("ALTER TABLE attempts ADD COLUMN judge_usage_json TEXT;");
    if (!attemptColumns.includes("retry_of")) this.db.exec("ALTER TABLE attempts ADD COLUMN retry_of TEXT;");
    // Outcome taxonomy + agent-phase timing (nullable; NULL = unavailable).
    for (const [name, type] of [
      ["limit_hit", "TEXT"],
      ["error_kind", "TEXT"],
      ["agent_started_at", "INTEGER"],
      ["agent_finished_at", "INTEGER"],
    ] as const) {
      if (attemptColumns.includes(name)) continue;
      try {
        this.db.exec(`ALTER TABLE attempts ADD COLUMN ${name} ${type};`);
      } catch (err) {
        // A concurrent opener may have added it between the read and the ALTER.
        if (!/duplicate column/i.test(err instanceof Error ? err.message : String(err))) throw err;
      }
    }
    this.db.exec("PRAGMA user_version = 3;");
  }

  insertRun(run: { id: string; startedAt: number; config: RunConfig; manifest: RunManifest }): void {
    this.db
      .query("INSERT INTO runs (id, started_at, finished_at, config_json, manifest_json, manifest_hash) VALUES (?, ?, NULL, ?, ?, ?)")
      .run(run.id, run.startedAt, JSON.stringify(run.config), JSON.stringify(run.manifest), run.manifest.hash);
  }

  reopenRun(id: string): void { this.db.query("UPDATE runs SET finished_at = NULL WHERE id = ?").run(id); }

  finishRun(id: string, finishedAt: number): void {
    const changed = this.db.query("UPDATE runs SET finished_at = ? WHERE id = ?").run(finishedAt, id);
    if (changed.changes === 0) throw new Error(`cannot finish run "${id}": no such run`);
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRunRecord(row) : null;
  }

  /** All runs, newest first. */
  listRuns(): RunRecord[] {
    return this.db.query<RunRow, []>("SELECT * FROM runs ORDER BY started_at DESC, id DESC").all().map(toRunRecord);
  }

  /** Most recent run, or null on an empty database (`report --latest`). */
  latestRun(): RunRecord | null {
    const row = this.db.query<RunRow, []>("SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT 1").get();
    return row ? toRunRecord(row) : null;
  }

  insertAttempt(attempt: NewAttempt): void {
    this.db
      .query(
        `INSERT INTO attempts (
           id, run_id, eval_id, experiment_id, suite, trial_index, attempt_identity_hash, status,
           result_json, surface_usage_json, transcript_ref, diff_ref, cost_usd, tokens_in, tokens_out,
           turns, started_at, finished_at, error, retry_of, judge_usage_json,
           limit_hit, error_kind, agent_started_at, agent_finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.runId,
        attempt.evalId,
        attempt.experimentId,
        attempt.suite,
        attempt.trialIndex,
        attempt.attemptIdentityHash,
        attempt.status,
        attempt.result === undefined || attempt.result === null ? null : JSON.stringify(attempt.result),
        attempt.surfaceUsage === undefined || attempt.surfaceUsage === null ? null : JSON.stringify(attempt.surfaceUsage),
        attempt.transcriptRef ?? null,
        attempt.diffRef ?? null,
        attempt.costUsd ?? null,
        attempt.tokensIn ?? null,
        attempt.tokensOut ?? null,
        attempt.turns ?? null,
        attempt.startedAt ?? null,
        attempt.finishedAt ?? null,
        attempt.error ?? null,
        attempt.retryOf ?? null,
        attempt.judgeRecords ? JSON.stringify(attempt.judgeRecords) : null,
        attempt.limitHit ?? null,
        attempt.errorKind ?? null,
        attempt.agentStartedAt ?? null,
        attempt.agentFinishedAt ?? null,
      );
  }

  listAttempts(runId: string): AttemptRecord[] {
    return this.db
      .query<AttemptRow, [string]>("SELECT * FROM attempts WHERE run_id = ? ORDER BY id")
      .all(runId)
      .map(toAttemptRecord);
  }

  close(): void {
    this.db.close();
  }
}

/** Only explicit, valid retry links supersede a row. Accidental duplicates remain visible. */
export function activeAttempts(attempts: AttemptRecord[]): AttemptRecord[] {
  const superseded = new Set<string>();
  for (const row of attempts) if (row.retryOf) {
    const previous = attempts.find((a) => a.id === row.retryOf);
    if (!previous || previous.status === "completed" || previous.runId !== row.runId || previous.evalId !== row.evalId || previous.experimentId !== row.experimentId || previous.trialIndex !== row.trialIndex || previous.attemptIdentityHash !== row.attemptIdentityHash || superseded.has(previous.id)) {
      throw new Error(`invalid retry lineage for attempt ${row.id}`);
    }
    superseded.add(previous.id);
  }
  return attempts.filter((a) => !superseded.has(a.id));
}
