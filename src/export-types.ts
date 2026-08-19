/**
 * The data-directory contract: the stable interface between the harness and
 * the static UI. `src/export.ts` writes it; `ui/src/data.ts` reads it. This
 * module is PURE (types + constants only, no bun/node imports) so the browser
 * bundle can import it directly — shared types make schema drift a compile
 * error rather than a blank page.
 *
 * Layout, relative to the exported site root:
 *
 *   index.html                     UI bundle (window.__QS_DATA__ inlined)
 *   assets/…                       UI bundle
 *   data/meta.json                 DataMeta — schemaVersion + run index
 *   data/runs/<run>/run.json       DataRun — run summary + attempt rows
 *   data/runs/<run>/report.json    ReportJson, embedded VERBATIM
 *   data/runs/<run>/diagnosis.json DiagnosisJson, embedded VERBATIM — only
 *                                  when the artifact exists (never rebuilt)
 *   data/runs/<run>/attempts/<id>.json            standalone DataAttempt
 *   data/runs/<run>/attempts/<id>.transcript.txt  lazy transcript asset
 *   data/runs/<run>/attempts/<id>.diff.patch      lazy diff asset
 *
 * Workspace trees are deliberately NOT exported (size); the diff and
 * transcript are the reviewable artifacts.
 */

// Type-only imports — erased at compile time, so this module stays pure for
// the browser bundle (report.ts itself imports node:fs and must never load).
import type { DiagnosisJson } from "./diagnose/types.ts";
import type { CheckResult } from "./evals/types.ts";
import type { ComparisonGroup } from "./experiments/groups.ts";
import type { RunManifest } from "./manifest.ts";
import type { ReportJson } from "./report/report.ts";
import type { SurfaceUsage } from "./surface-usage.ts";

/**
 * Bumped on any breaking change to this file's shapes. The UI refuses data
 * from a different version with an explicit banner, never a blank page.
 */
export const DATA_SCHEMA_VERSION = 3;

/** One run in the `meta.json` index (and the header of its `run.json`). */
export interface DataRunSummary {
  id: string;
  /** ISO timestamps on the wire (the store keeps epoch milliseconds). */
  started_at: string;
  /** NULL = the run never finished; the UI banners incompleteness. */
  finished_at: string | null;
  trials: number;
  eval_ids: string[];
  experiment_ids: string[];
  manifest_hash: string;
  attempts: number;
}

/** `data/meta.json` — the index the UI boots from. */
export interface DataMeta {
  schemaVersion: number;
  generated_at: string;
  runs: DataRunSummary[];
}

/** One attempt row as exported (artifact paths are data-dir-relative). */
export interface DataAttempt {
  id: string;
  run_id: string;
  eval_id: string;
  experiment_id: string;
  suite: string;
  trial_index: number;
  status: "completed" | "incomplete" | "error";
  /** The scorer's verdict; null unless the attempt completed. */
  passed: boolean | null;
  /** Named check results; null unless the attempt completed. */
  checks: CheckResult[] | null;
  /** Experiment metadata joined at export time (manifest + run config). */
  treatment: string | null;
  comparison_group: string | null;
  /** null = telemetry unavailable for this attempt (never a zero-filled object). */
  surface_usage: SurfaceUsage | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  /** Agent steps (adapter-counted); null = no parseable stream. */
  turns: number | null;
  started_at: string | null;
  finished_at: string | null;
  /** Present when status = "error" (and for recorded teardown notes). */
  error: string | null;
  /** Relative to the run's data dir (e.g. `attempts/<id>.transcript.txt`); null = artifact missing. */
  transcript: string | null;
  diff: string | null;
}

/** `data/runs/<run>/run.json`. */
export interface DataRun {
  schemaVersion: number;
  run: DataRunSummary;
  manifest: RunManifest;
  /** The comparison groups recorded at run time (withhold-and-diff state included). */
  groups: ComparisonGroup[];
  attempts: DataAttempt[];
}

/**
 * The index inlined into the exported `index.html` as `window.__QS_DATA__`.
 * Browsers restrict `fetch` from `file://` pages, so everything the views
 * need up-front rides inside the document; only bulky text assets
 * (transcripts, diffs) stay lazy and degrade gracefully offline.
 */
export interface InlineData {
  meta: DataMeta;
  /** runId -> run.json payload. */
  runs: Record<string, DataRun>;
  /** runId -> report.json payload (verbatim ReportJson shape). */
  reports: Record<string, ReportJson>;
  /**
   * runId -> diagnosis.json payload (verbatim DiagnosisJson shape). Present
   * only when at least one exported run has a stored diagnosis — absence is
   * a legitimate state (the UI renders how to produce one), never an error.
   */
  diagnoses?: Record<string, DiagnosisJson>;
}
