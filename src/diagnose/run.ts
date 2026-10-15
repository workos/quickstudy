/**
 * Diagnosis orchestration: load one run's persisted evidence, select the
 * diagnosable pairs, bundle harness-selected excerpts, ask the analyst per
 * pair, map index-based findings back to attempt ids, derive confidence from
 * rules, and write `results/<runId>/diagnosis.json` beside report.json.
 *
 * Everything reads the STORE (rows + artifacts) — never consumer experiment
 * modules, never `src/report/` output. The model client is injected; the
 * Anthropic-backed client is constructed only in the CLI command. Per-pair
 * model failures land in `errors[]` and the artifact is still written —
 * evidence of a failure is never lost.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestValidated, type StructuredModelClient } from "../llm.ts";
import type { AttemptRecord, ResultsStore, RunRecord } from "../store/db.ts";
import {
  excerptDiff,
  excerptTranscript,
  readArtifact,
} from "./excerpt.ts";
import {
  DIAGNOSE_JSON_SCHEMA,
  DIAGNOSE_MAX_TOKENS,
  DIAGNOSE_SYSTEM,
  diagnoseResponseSchema,
  renderPairPrompt,
  type BundleAttempt,
  type PairBundle,
} from "./prompt.ts";
import { selectDiagnosablePairs, type DiagnosablePair } from "./select.ts";
import { controlExperiments } from "../report/report.ts";
import {
  DIAGNOSIS_DISCLAIMER,
  DIAGNOSIS_PROMPT_VERSION,
  DIAGNOSIS_SCHEMA_VERSION,
  DiagnoseError,
  type DiagnosisConfidence,
  type DiagnosisEvidence,
  type DiagnosisFinding,
  type DiagnosisJson,
  type PairDiagnosisError,
} from "./types.ts";

/** Analyst model default; overridable via QUICKSTUDY_ANALYST_MODEL (deprecation resilience). */
export const DEFAULT_ANALYST_MODEL = "claude-sonnet-5";

export function analystModelFromEnv(env: Record<string, string | undefined> = process.env): string {
  const model = env["QUICKSTUDY_ANALYST_MODEL"];
  return model !== undefined && model !== "" ? model : DEFAULT_ANALYST_MODEL;
}

/** Canonical location of a run's diagnosis.json (mirrors reportJsonPath). */
export function diagnosisJsonPath(resultsDir: string, runId: string): string {
  return join(resultsDir, runId, "diagnosis.json");
}

/** Write diagnosis.json into the run's results dir. Returns the path. */
export function writeDiagnosisJson(diagnosis: DiagnosisJson, resultsDir: string): string {
  const dir = join(resultsDir, diagnosis.run_id);
  mkdirSync(dir, { recursive: true });
  const path = diagnosisJsonPath(resultsDir, diagnosis.run_id);
  writeFileSync(path, `${JSON.stringify(diagnosis, null, 2)}\n`, "utf8");
  return path;
}

function mustResolveRun(store: ResultsStore, runId: string | undefined): RunRecord {
  if (runId === undefined) {
    const latest = store.latestRun();
    if (latest === null) {
      throw new DiagnoseError(
        "this results database has no runs yet — run `quickstudy run --eval <id> --experiment <id>` first",
      );
    }
    return latest;
  }
  const run = store.getRun(runId);
  if (run) return run;
  const known = store
    .listRuns()
    .slice(0, 5)
    .map((candidate) => `  ${candidate.id} (started ${new Date(candidate.startedAt).toISOString()})`);
  throw new DiagnoseError(
    `no run "${runId}" in this results database${known.length > 0 ? `; most recent runs:\n${known.join("\n")}` : ""}`,
  );
}

function attemptLabel(cls: "failed" | "error" | "incomplete" | "passed", contrast: boolean): string {
  if (contrast) return "passing contrast";
  if (cls === "error") return "errored";
  return cls;
}

/**
 * Read a bundle attempt's artifacts and excerpt them. Paths derive from the
 * results dir layout (the report's egress-denials precedent) with the stored
 * ref as fallback, and only refs the runner actually recorded are read.
 */
function bundleAttemptFor(
  resultsDir: string,
  runId: string,
  selection: { attempt: AttemptRecord; class: "failed" | "error" | "incomplete" | "passed"; contrast: boolean },
  index: number,
): BundleAttempt {
  const { attempt } = selection;
  const bundleAttempt: BundleAttempt = {
    index,
    attemptId: attempt.id,
    label: attemptLabel(selection.class, selection.contrast),
  };
  if (attempt.transcriptRef !== null) {
    const raw =
      readArtifact(join(resultsDir, runId, attempt.id, "transcript.jsonl")) ?? readArtifact(attempt.transcriptRef);
    if (raw !== undefined && raw !== "") bundleAttempt.transcript = excerptTranscript(raw);
  }
  if (attempt.diffRef !== null) {
    const raw = readArtifact(join(resultsDir, runId, attempt.id, "diff.patch")) ?? readArtifact(attempt.diffRef);
    if (raw !== undefined && raw !== "") bundleAttempt.diff = excerptDiff(raw);
  }
  return bundleAttempt;
}

/** Assemble one pair's prompt bundle. Exported for tests. */
export function buildPairBundle(options: {
  run: RunRecord;
  resultsDir: string;
  pair: DiagnosablePair;
}): PairBundle {
  const { run, resultsDir, pair } = options;
  const treatment = run.manifest.experiments[pair.experimentId]?.components.treatment ?? null;
  const surfaces = run.config.surfaces?.[pair.experimentId];
  return {
    evalId: pair.evalId,
    experimentId: pair.experimentId,
    treatment,
    tallies: pair.tallies,
    failedChecks: pair.failedChecks,
    ...(surfaces !== undefined ? { surfaces } : {}),
    attempts: pair.bundle.map((selection, position) => bundleAttemptFor(resultsDir, run.id, selection, position + 1)),
  };
}

/**
 * Map the model's index-only references back to attempt ids + the excerpt
 * windows the model was actually shown. Out-of-range indexes are dropped; a
 * finding whose indexes all fail to map falls back to the bundle's first
 * failing attempt's excerpt — degrade, never fabricate.
 */
export function mapEvidence(bundle: PairBundle, attemptIndexes: number[]): DiagnosisEvidence[] {
  const mapped: DiagnosisEvidence[] = [];
  const seen = new Set<string>();
  for (const index of attemptIndexes) {
    const attempt = bundle.attempts.find((candidate) => candidate.index === index);
    if (!attempt) continue;
    const excerpt = attempt.transcript ?? attempt.diff;
    if (!excerpt) continue;
    if (seen.has(attempt.attemptId)) continue;
    seen.add(attempt.attemptId);
    mapped.push({
      attempt_id: attempt.attemptId,
      artifact: attempt.transcript ? "transcript" : "diff",
      lines: excerpt.lines,
    });
  }
  if (mapped.length === 0) {
    const first = bundle.attempts.find((attempt) => attempt.label !== "passing contrast" && (attempt.transcript ?? attempt.diff));
    const excerpt = first?.transcript ?? first?.diff;
    if (first && excerpt) {
      mapped.push({
        attempt_id: first.attemptId,
        artifact: first.transcript ? "transcript" : "diff",
        lines: excerpt.lines,
      });
    }
  }
  return mapped;
}

/**
 * Rule-derived confidence — never asked of the model:
 *   high   = pair has zero passes and >= 2 bundled attempts mapped as evidence;
 *   medium = zero passes with 1 mapped attempt, or flaky with >= 2;
 *   low    = otherwise.
 */
export function deriveConfidence(pair: DiagnosablePair, evidence: DiagnosisEvidence[]): DiagnosisConfidence {
  const mappedAttempts = new Set(evidence.map((entry) => entry.attempt_id)).size;
  const zeroPasses = pair.tallies.passed === 0;
  if (zeroPasses && mappedAttempts >= 2) return "high";
  if ((zeroPasses && mappedAttempts === 1) || (pair.flaky && mappedAttempts >= 2)) return "medium";
  return "low";
}

export interface RunDiagnoseOptions {
  store: ResultsStore;
  /** Artifacts root (the harness `--results` dir) — transcripts and diffs live here. */
  resultsDir: string;
  /** Omit to diagnose the most recent run (`--latest`). */
  runId?: string;
  /** Injected model client — the CLI is the only place the Anthropic client is constructed. */
  client: StructuredModelClient;
  /** Overrides the analyst model (default: QUICKSTUDY_ANALYST_MODEL or the pinned default). */
  model?: string;
  /** Overrides the `generated_at` stamp — fixture seeding only. */
  generatedAt?: string;
  /** Progress lines (pair counts) — the CLI passes console.error. */
  log?: (line: string) => void;
}

/**
 * Diagnose one run and write diagnosis.json. Throws DiagnoseError only when
 * the run cannot be resolved; per-pair failures are recorded in `errors[]`
 * and the artifact is still written.
 */
export async function runDiagnose(options: RunDiagnoseOptions): Promise<DiagnosisJson> {
  const { store, resultsDir, client } = options;
  const log = options.log ?? ((): void => {});
  const model = options.model ?? analystModelFromEnv();

  const run = mustResolveRun(store, options.runId);
  const attempts = store.listAttempts(run.id);
  // Controls check the instrument, not an agent: the oracle passes and the
  // no-op fails by construction, so their pairs carry no diagnosable cause.
  const controls = controlExperiments(run);
  const selection = selectDiagnosablePairs(attempts, { controls });
  log(
    `diagnose: run ${run.id} — ${selection.pairs.length} diagnosable pair(s), ` +
      `${selection.skipped} passing pair(s) skipped, ${selection.controls} control pair(s) excluded`,
  );

  const findings: DiagnosisFinding[] = [];
  const errors: PairDiagnosisError[] = [];

  // Sequential by design: a sweep is at most a handful of requests and the
  // SDK owns transport retries — no concurrency machinery.
  for (const pair of selection.pairs) {
    const bundle = buildPairBundle({ run, resultsDir, pair });
    if (bundle.attempts.every((attempt) => attempt.transcript === undefined && attempt.diff === undefined)) {
      errors.push({
        eval_id: pair.evalId,
        experiment_id: pair.experimentId,
        error: "no readable transcript or diff artifacts for any bundled attempt",
      });
      continue;
    }
    try {
      const response = await requestValidated(
        client,
        {
          model,
          system: DIAGNOSE_SYSTEM,
          user: renderPairPrompt(bundle),
          maxTokens: DIAGNOSE_MAX_TOKENS,
          schema: DIAGNOSE_JSON_SCHEMA,
        },
        diagnoseResponseSchema,
      );
      for (const draft of response.findings) {
        const evidence = mapEvidence(bundle, draft.attempt_indexes);
        if (evidence.length === 0) continue; // nothing mappable at all — unusable
        findings.push({
          eval_id: pair.evalId,
          experiment_id: pair.experimentId,
          target: draft.target,
          claim: draft.claim,
          suggested_change: draft.suggested_change,
          confidence: deriveConfidence(pair, evidence),
          evidence,
        });
      }
    } catch (err) {
      errors.push({
        eval_id: pair.evalId,
        experiment_id: pair.experimentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const diagnosis: DiagnosisJson = {
    schema_version: DIAGNOSIS_SCHEMA_VERSION,
    run_id: run.id,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    model: { requested: model, resolved: client.resolvedModel?.() ?? null },
    prompt_version: DIAGNOSIS_PROMPT_VERSION,
    disclaimer: DIAGNOSIS_DISCLAIMER,
    pairs_diagnosed: selection.pairs.length - errors.length,
    pairs_skipped: selection.skipped + selection.controls,
    findings,
    errors,
  };
  writeDiagnosisJson(diagnosis, resultsDir);
  return diagnosis;
}
