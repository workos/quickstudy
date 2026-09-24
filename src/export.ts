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
 *   - Historical reports are preserved verbatim. Modern reports are reused
 *     only when their source fingerprint matches the current attempt records.
 *   - diagnosis.json rides along VERBATIM only when the artifact exists on
 *     disk. Unlike report.json it is NEVER rebuilt: diagnosis is key-gated
 *     and token-spending, and export must not spend tokens or require a key.
 *   - Workspace trees are NOT exported (size); diff + transcript are the
 *     reviewable artifacts.
 *   - Offline mode embeds the meta/run/report index for file:// use.
 *     Hosted mode embeds only meta and fetches immutable run snapshots.
 *     Transcripts/diffs remain lazy assets in both modes.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
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
import { trialCoverage } from "./completeness.ts";
import { hashString } from "./hash.ts";
import { buildReport, renderReportText, type ReportJson } from "./report/report.ts";
import { parsePricing, type Pricing } from "./report/costs.ts";
import { activeAttempts, type AttemptRecord, type ResultsStore, type RunRecord } from "./store/db.ts";

/** Loud, CLI-friendly failures (unknown run, missing bundle, ...). */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

export interface ExportOptions {
  /** Recalculate token-cost estimates from saved transcripts using this runtime snapshot. */
  pricing?: Pricing;
  /** Offline embeds JSON; hosted fetches immutable per-run snapshots lazily. */
  mode?: "offline" | "hosted";
  /** Explicit publication gate; omits incompletely sampled pairs with reasons. */
  expectedTrials?: number;
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
  const target = join(targetDir, fileName);
  const sourceStat = statSync(sourcePath);
  if (!existsSync(target) || statSync(target).size !== sourceStat.size || statSync(target).mtimeMs < sourceStat.mtimeMs) {
    const temporary = `${target}.tmp`; copyFileSync(sourcePath, temporary); renameSync(temporary, target);
  }
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
    ...((attempt.result?.judgments ?? attempt.judgeRecords) ? { judgments: attempt.result?.judgments ?? attempt.judgeRecords } : {}),
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
    limit: attempt.limitHit ?? null,
    error_kind: attempt.errorKind ?? null,
    agent_started_at: iso(attempt.agentStartedAt ?? null),
    agent_finished_at: iso(attempt.agentFinishedAt ?? null),
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
  pricing?: Pricing,
): ReportJson {
  if (pricing !== undefined) return buildReport({ store, runId, resultsDir, generatedAt, pricing });
  const path = join(resultsDir, runId, "report.json");
  if (existsSync(path)) {
    try {
      // Export is an artifact copier, not report validation. Preserve the
      // stored JSON byte-for-byte in meaning, including forward-compatible
      // fields a newer report producer may add.
      const stored = JSON.parse(readFileSync(path, "utf8")) as ReportJson;
      const run = store.getRun(runId)!;
      // Historical reports retain their methodology. New reports are reused
      // only when the entire source record still matches (including retries).
      if (run.manifest.manifestVersion === "v3" && stored.cost_estimate === undefined) return stored;
      const current = buildReport({ store, runId, resultsDir, generatedAt: generatedAt ?? iso(run.finishedAt) ?? iso(run.startedAt)!,
        ...(stored.cost_estimate ? { pricing: parsePricing(stored.cost_estimate.pricing) } : {}) });
      return stored.source_fingerprint === current.source_fingerprint ? stored : current;
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
    generatedAt: generatedAt ?? iso(store.getRun(runId)!.finishedAt) ?? iso(store.getRun(runId)!.startedAt)!,
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

function publicationReport(options: ExportOptions, run: RunRecord, log: (message: string) => void): ReportJson | undefined {
  if (options.expectedTrials === undefined) return undefined;
  const pricing = options.pricing ?? resolveReport(options.store, options.resultsDir, run.id, log, options.generatedAt).cost_estimate?.pricing;
  return buildReport({ store: options.store, runId: run.id, resultsDir: options.resultsDir,
    expectedTrials: options.expectedTrials, pricing,
    generatedAt: options.generatedAt ?? iso(run.finishedAt) ?? iso(run.startedAt)! });
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

  const publications = new Map(runs.map((run) => [run.id, publicationReport(options, run, log)]));
  const dataDir = join(outDir, "data");
  mkdirSync(dataDir, { recursive: true });

  const inlineRuns: Record<string, DataRun> = {};
  const inlineReports: Record<string, ReportJson> = {};
  const inlineDiagnoses: Record<string, DiagnosisJson> = {};
  const summaries: DataRunSummary[] = [];
  const runPaths: Record<string, string> = {};
  let attemptTotal = 0;
  let missingAssets = 0;

  for (const run of runs) {
    const history = store.listAttempts(run.id);
    const current = activeAttempts(history);
    const publication = publications.get(run.id)?.publication;
    const attempts = publication ? current.filter((a) => publication.eligible.some((p) => p.eval_id === a.evalId && p.experiment_id === a.experimentId)) : current;
    const groupOf = groupsByExperiment(run);
    const runDir = join(dataDir, "runs", run.id);
    const attemptsDir = join(runDir, "attempts");
    mkdirSync(attemptsDir, { recursive: true });

    const dataAttempts: DataAttempt[] = [];
    const historyAttempts: DataAttempt[] = [];
    for (const attempt of history) {
      const transcript = copyAsset(attempt.transcriptRef, attemptsDir, `${attempt.id}.transcript.txt`);
      const diff = copyAsset(attempt.diffRef, attemptsDir, `${attempt.id}.diff.patch`);
      for (const asset of [transcript, diff]) {
        if (asset.missing) {
          missingAssets += 1;
          log(`attempt ${attempt.id}: artifact referenced in SQLite is missing on disk — exported without it`);
        }
      }
      const dataAttempt = toDataAttempt(run, groupOf, attempt, transcript.relativePath, diff.relativePath);
      if (attempts.includes(attempt)) dataAttempts.push(dataAttempt);
      else historyAttempts.push(dataAttempt);
      atomicWrite(join(attemptsDir, `${attempt.id}.json`), `${JSON.stringify(dataAttempt, null, 2)}\n`, "utf8");
    }

    const summary = toRunSummary(run, attempts.length);
    summary.incomplete = publication ? false : run.finishedAt === null || trialCoverage(run, current).some((p) => !p.complete);
    const dataRun: DataRun = {
      schemaVersion: DATA_SCHEMA_VERSION,
      run: summary,
      manifest: run.manifest,
      groups: run.config.groups ?? [],
      attempts: dataAttempts,
      ...(historyAttempts.length ? { excluded_attempts: historyAttempts } : {}),
      ...(publication ? { publication } : {}),
    };
    atomicWrite(join(runDir, "run.json"), `${JSON.stringify(dataRun, null, 2)}\n`, "utf8");

    const report = publications.get(run.id) ?? resolveReport(store, resultsDir, run.id, log, options.generatedAt, options.pricing);
    if (publication) {
      atomicWrite(join(runDir, "omissions.json"), JSON.stringify(publication, null, 2));
      atomicWrite(join(runDir, "omissions.txt"), renderReportText(report));
      atomicWrite(join(runDir, "source-report.json"), JSON.stringify(buildReport({ store, runId: run.id, resultsDir, pricing: report.cost_estimate?.pricing }), null, 2));
      log(`${run.id}: complete-sample publication includes ${publication.eligible.length} pair(s), omits ${publication.omitted.length}; see data/runs/${run.id}/omissions.json and omissions.txt`);
    }
    atomicWrite(join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const diagnosis = resolveDiagnosis(resultsDir, run.id, runDir, log);
    if (diagnosis !== null) inlineDiagnoses[run.id] = diagnosis;
    const snapshot = hashString(JSON.stringify({ dataRun, report, diagnosis })).slice(0, 24);
    const snapshotPath = `runs/${run.id}/snapshots/${snapshot}`;
    const snapshotDir = join(dataDir, snapshotPath); mkdirSync(snapshotDir, { recursive: true });
    atomicWrite(join(snapshotDir, "run.json"), JSON.stringify(dataRun));
    atomicWrite(join(snapshotDir, "report.json"), JSON.stringify(report));
    atomicWrite(join(snapshotDir, "diagnosis.json"), JSON.stringify(diagnosis));
    runPaths[run.id] = snapshotPath;

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
    run_paths: runPaths,
  };
  atomicWrite(join(dataDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  if (options.bundleDir !== undefined) {
    cpSync(options.bundleDir, outDir, { recursive: true, filter: (path) => path === options.bundleDir || !path.endsWith("/index.html") });
    const indexPath = join(outDir, "index.html");
    const html = readFileSync(join(options.bundleDir, "index.html"), "utf8");
    // The `diagnoses` key is omitted entirely when no exported run has one.
    const inline: InlineData = {
      meta,
      runs: options.mode === "hosted" ? {} : inlineRuns,
      reports: options.mode === "hosted" ? {} : inlineReports,
      ...(options.mode !== "hosted" && Object.keys(inlineDiagnoses).length > 0 ? { diagnoses: inlineDiagnoses } : {}),
    };
    atomicWrite(indexPath, inlineDataIntoHtml(html, inline), "utf8");
  }

  return { outDir, dataDir, runs: runs.length, attempts: attemptTotal, missingAssets };
}

/** Write complete bytes before exposing a new snapshot/pointer; reuse identical files. */
function atomicWrite(path: string, value: string, _encoding?: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === value) return;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value, "utf8"); renameSync(temporary, path);
}
