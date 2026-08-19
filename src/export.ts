/**
 * `quickstudy export`: materialize the data directory (see export-types.ts)
 * from SQLite + the artifacts dir, and copy the prebuilt UI bundle next to
 * it. One renderer, two delivery modes — `quickstudy ui` runs this exact
 * export into a temp dir and serves it, so if it works from file:// it works
 * served.
 *
 * Key decisions (from the spec):
 *   - Transcripts/diffs are sliced into per-attempt text assets, lazy-loaded
 *     by the viewer — never one giant JSON.
 *   - report.json is embedded VERBATIM (the stored report artifact when it
 *     exists; a freshly built one otherwise) — no reshaping, so report and
 *     UI can never disagree.
 *   - diagnosis.json rides along VERBATIM only when the artifact exists on
 *     disk. Unlike report.json it is NEVER rebuilt: diagnosis is key-gated
 *     and token-spending, and export must not spend tokens or require a key.
 *   - Workspace trees are NOT exported (size); diff + transcript are the
 *     reviewable artifacts.
 *   - The meta/run/report index is inlined into index.html
 *     (`window.__QS_DATA__`) because browsers block fetch() from file://
 *     pages; lazy text assets degrade gracefully there.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiagnosisJson } from "./diagnose/types.ts";
import {
  DATA_SCHEMA_VERSION,
  type DataAttempt,
  type DataMeta,
  type DataRun,
  type DataRunSummary,
  type InlineData,
} from "./export-types.ts";
import { buildReport, type ReportJson } from "./report/report.ts";
import type { AttemptRecord, ResultsStore, RunRecord } from "./store/db.ts";

/** Loud, CLI-friendly failures (unknown run, missing bundle, ...). */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

export interface ExportOptions {
  store: ResultsStore;
  /** Artifacts root (the harness `--results` dir). */
  resultsDir: string;
  /** Runs to export. May be empty — the UI renders its empty state. */
  runIds: string[];
  /** Site output directory (created if needed). */
  outDir: string;
  /**
   * The prebuilt UI bundle (ui/dist). Omit to export the data directory
   * only — used by dev-data generation and shape tests.
   */
  bundleDir?: string;
  /** Overrides `generated_at` stamps (meta.json and export-time-built reports) — fixture seeding only. */
  generatedAt?: string;
  /** Warning sink for non-fatal notes (missing artifacts, rebuilt reports). */
  log?: (message: string) => void;
}

export interface ExportSummary {
  outDir: string;
  dataDir: string;
  runs: number;
  attempts: number;
  /** Attempt artifacts referenced in SQLite but unreadable on disk. */
  missingAssets: number;
}

function iso(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

function mustGetRun(store: ResultsStore, runId: string): RunRecord {
  const run = store.getRun(runId);
  if (run) return run;
  const known = store
    .listRuns()
    .slice(0, 5)
    .map((r) => `  ${r.id} (started ${new Date(r.startedAt).toISOString()})`);
  throw new ExportError(
    `no run "${runId}" in this results database${known.length > 0 ? `; most recent runs:\n${known.join("\n")}` : ""}`,
  );
}

function toRunSummary(run: RunRecord, attemptCount: number): DataRunSummary {
  return {
    id: run.id,
    started_at: new Date(run.startedAt).toISOString(),
    finished_at: iso(run.finishedAt),
    trials: run.config.trials,
    eval_ids: [...run.config.evalIds],
    experiment_ids: [...run.config.experimentIds],
    manifest_hash: run.manifest.hash,
    attempts: attemptCount,
  };
}

interface AssetCopyResult {
  relativePath: string | null;
  missing: boolean;
}

/** Copy one artifact into the run's attempts/ dir; missing files degrade to null. */
function copyAsset(sourcePath: string | null, targetDir: string, fileName: string): AssetCopyResult {
  if (sourcePath === null) return { relativePath: null, missing: false };
  if (!existsSync(sourcePath)) return { relativePath: null, missing: true };
  copyFileSync(sourcePath, join(targetDir, fileName));
  return { relativePath: `attempts/${fileName}`, missing: false };
}

/** Experiment id -> declared comparison group, from the run's recorded groups. */
function groupsByExperiment(run: RunRecord): Map<string, string> {
  const byExperiment = new Map<string, string>();
  for (const group of run.config.groups ?? []) {
    for (const experimentId of group.experimentIds) byExperiment.set(experimentId, group.group);
  }
  return byExperiment;
}

function toDataAttempt(
  run: RunRecord,
  groupOf: Map<string, string>,
  attempt: AttemptRecord,
  transcript: string | null,
  diff: string | null,
): DataAttempt {
  return {
    id: attempt.id,
    run_id: attempt.runId,
    eval_id: attempt.evalId,
    experiment_id: attempt.experimentId,
    suite: attempt.suite,
    trial_index: attempt.trialIndex,
    status: attempt.status,
    passed: attempt.status === "completed" ? (attempt.result?.passed ?? false) : null,
    checks: attempt.result?.checks ?? null,
    treatment: run.manifest.experiments[attempt.experimentId]?.components.treatment ?? null,
    comparison_group: groupOf.get(attempt.experimentId) ?? null,
    surface_usage: attempt.surfaceUsage,
    tokens_in: attempt.tokensIn,
    tokens_out: attempt.tokensOut,
    cost_usd: attempt.costUsd,
    turns: attempt.turns,
    started_at: iso(attempt.startedAt),
    finished_at: iso(attempt.finishedAt),
    error: attempt.error,
    transcript,
    diff,
  };
}

/**
 * The stored report.json is the artifact consumers already trust — embed it
 * verbatim. When absent, build it fresh (deterministic and offline; export
 * must not spend tokens or require a key).
 */
function resolveReport(
  store: ResultsStore,
  resultsDir: string,
  runId: string,
  log: (message: string) => void,
  generatedAt?: string,
): ReportJson {
  const path = join(resultsDir, runId, "report.json");
  if (existsSync(path)) {
    try {
      // Export is an artifact copier, not report validation. Preserve the
      // stored JSON byte-for-byte in meaning, including forward-compatible
      // fields a newer report producer may add.
      return JSON.parse(readFileSync(path, "utf8")) as ReportJson;
    } catch (err) {
      log(`stored report.json for ${runId} is unreadable (${err instanceof Error ? err.message : String(err)}) — rebuilding`);
    }
  } else {
    log(`no stored report.json for ${runId} — building it at export time (identical to \`quickstudy report ${runId}\`)`);
  }
  return buildReport({
    store,
    runId,
    resultsDir,
    ...(generatedAt !== undefined ? { generatedAt } : {}),
  });
}

/**
 * diagnosis.json rides along ONLY when the artifact already exists on disk.
 * Unlike {@link resolveReport} there is NO rebuild fallback: diagnosis is
 * key-gated and token-spending, and export must not spend tokens or require
 * a key. Absent is a legitimate state (the UI renders how to produce one),
 * so it skips silently; only an unreadable artifact earns a warning.
 */
function resolveDiagnosis(
  resultsDir: string,
  runId: string,
  runDir: string,
  log: (message: string) => void,
): DiagnosisJson | null {
  const path = join(resultsDir, runId, "diagnosis.json");
  if (!existsSync(path)) return null;
  let diagnosis: DiagnosisJson;
  try {
    // Export is an artifact copier, not diagnosis validation. Preserve the
    // stored JSON byte-for-byte in meaning, including forward-compatible
    // fields a newer diagnosis producer may add.
    diagnosis = JSON.parse(readFileSync(path, "utf8")) as DiagnosisJson;
  } catch (err) {
    log(
      `stored diagnosis.json for ${runId} is unreadable (${err instanceof Error ? err.message : String(err)}) — exported without it (export never rebuilds a diagnosis)`,
    );
    return null;
  }
  copyFileSync(path, join(runDir, "diagnosis.json"));
  return diagnosis;
}

const QS_DATA_SLOT = /<script id="qs-data">[\s\S]*?<\/script>/;

/**
 * Inline the data index into the bundle's index.html. `<` is escaped so a
 * `</script>` (or `<!--`) inside transcript-derived JSON can never truncate
 * the document; U+2028/9 are escaped for pre-ES2019 parsers.
 */
export function inlineDataIntoHtml(html: string, data: InlineData): string {
  if (!QS_DATA_SLOT.test(html)) {
    throw new ExportError(
      'the UI bundle\'s index.html has no `<script id="qs-data">` slot — rebuild it with `bun run ui:build`',
    );
  }
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  // Function replacement: a string replacement would interpret `$&`/`$'`
  // sequences inside transcript-derived JSON as replacement patterns.
  return html.replace(QS_DATA_SLOT, () => `<script id="qs-data">window.__QS_DATA__ = ${json};</script>`);
}

/** Export one or more runs into a self-contained static site directory. */
export async function exportSite(options: ExportOptions): Promise<ExportSummary> {
  const log = options.log ?? ((message: string) => console.warn(message));
  const { store, resultsDir, outDir } = options;

  // Validate everything up-front: nothing is written until all runs resolve.
  const runs = options.runIds.map((runId) => mustGetRun(store, runId));
  if (options.bundleDir !== undefined && !existsSync(join(options.bundleDir, "index.html"))) {
    throw new ExportError(
      `no UI bundle at ${options.bundleDir} — build it first with \`bun run ui:build\``,
    );
  }

  const dataDir = join(outDir, "data");
  mkdirSync(dataDir, { recursive: true });

  const inlineRuns: Record<string, DataRun> = {};
  const inlineReports: Record<string, ReportJson> = {};
  const inlineDiagnoses: Record<string, DiagnosisJson> = {};
  const summaries: DataRunSummary[] = [];
  let attemptTotal = 0;
  let missingAssets = 0;

  for (const run of runs) {
    const attempts = store.listAttempts(run.id);
    const groupOf = groupsByExperiment(run);
    const runDir = join(dataDir, "runs", run.id);
    const attemptsDir = join(runDir, "attempts");
    mkdirSync(attemptsDir, { recursive: true });

    const dataAttempts: DataAttempt[] = [];
    for (const attempt of attempts) {
      const transcript = copyAsset(attempt.transcriptRef, attemptsDir, `${attempt.id}.transcript.txt`);
      const diff = copyAsset(attempt.diffRef, attemptsDir, `${attempt.id}.diff.patch`);
      for (const asset of [transcript, diff]) {
        if (asset.missing) {
          missingAssets += 1;
          log(`attempt ${attempt.id}: artifact referenced in SQLite is missing on disk — exported without it`);
        }
      }
      const dataAttempt = toDataAttempt(run, groupOf, attempt, transcript.relativePath, diff.relativePath);
      dataAttempts.push(dataAttempt);
      writeFileSync(join(attemptsDir, `${attempt.id}.json`), `${JSON.stringify(dataAttempt, null, 2)}\n`, "utf8");
    }

    const summary = toRunSummary(run, attempts.length);
    const dataRun: DataRun = {
      schemaVersion: DATA_SCHEMA_VERSION,
      run: summary,
      manifest: run.manifest,
      groups: run.config.groups ?? [],
      attempts: dataAttempts,
    };
    writeFileSync(join(runDir, "run.json"), `${JSON.stringify(dataRun, null, 2)}\n`, "utf8");

    const report = resolveReport(store, resultsDir, run.id, log, options.generatedAt);
    writeFileSync(join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const diagnosis = resolveDiagnosis(resultsDir, run.id, runDir, log);
    if (diagnosis !== null) inlineDiagnoses[run.id] = diagnosis;

    summaries.push(summary);
    inlineRuns[run.id] = dataRun;
    inlineReports[run.id] = report;
    attemptTotal += attempts.length;
  }

  // Newest first, matching ResultsStore.listRuns ordering (ISO strings sort).
  summaries.sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id));
  const meta: DataMeta = {
    schemaVersion: DATA_SCHEMA_VERSION,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    runs: summaries,
  };
  writeFileSync(join(dataDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  if (options.bundleDir !== undefined) {
    cpSync(options.bundleDir, outDir, { recursive: true });
    const indexPath = join(outDir, "index.html");
    const html = readFileSync(indexPath, "utf8");
    // The `diagnoses` key is omitted entirely when no exported run has one.
    const inline: InlineData = {
      meta,
      runs: inlineRuns,
      reports: inlineReports,
      ...(Object.keys(inlineDiagnoses).length > 0 ? { diagnoses: inlineDiagnoses } : {}),
    };
    writeFileSync(indexPath, inlineDataIntoHtml(html, inline), "utf8");
  }

  return { outDir, dataDir, runs: runs.length, attempts: attemptTotal, missingAssets };
}
