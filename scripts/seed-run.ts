#!/usr/bin/env bun
/**
 * Seed a synthetic-but-realistic COMPLETED v3 run into a scratch SQLite +
 * results dir, so report/UI development iterates in seconds without any
 * agent spend. (UI dev-data and the e2e fixture server use the same seeder.)
 *
 *   bun scripts/seed-run.ts                # seed-results.db + seed-results/
 *   bun scripts/seed-run.ts --db x.db --results x/
 *
 * The seeded grid is 2 comparison groups (claude/codex) × 3 treatments
 * (docs/mcp/cli) × 3 evals × 3 trials = 54 attempts / 18 pairs, with
 * DELIBERATE arm skews:
 *   - claude's docs arm passes 3/3 everywhere while its mcp arm fails 0/3
 *     (clustered on the flow-wired check) → a clean raw-count contrast;
 *   - claude's cli arm is flaky (2/3) and its failing trial reads docs — the
 *     offered≠used surface-usage case;
 *   - codex's mcp arm passes 1/3 with one timeout error on django, and
 *     codex-cli has one incomplete (timed-out) django trial;
 *   - the codex group pins a DIFFERENT model on its mcp member, so the group
 *     comparison is WITHHELD with a diff naming `model`.
 * Transcripts come from checked-in fixtures (tests/__fixtures__/transcripts/).
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { hashString } from "../src/hash.ts";
import { ulid } from "../src/ids.ts";
import { compareGroups, type ComparisonGroup } from "../src/experiments/groups.ts";
import type { Experiment } from "../src/experiments/types.ts";
import type { EvalIdentity, ExperimentIdentity, RunManifest } from "../src/manifest.ts";
import { ResultsStore, type AttemptStatus } from "../src/store/db.ts";
import type { CheckResult, EvalResult, EvalSuite } from "../src/evals/types.ts";
import type { SurfaceUsage } from "../src/surface-usage.ts";

const FIXTURES_DIR = join(import.meta.dir, "../tests/__fixtures__/transcripts");

/** Fixed `generated_at` for seeded reports/exports — regenerated dev data must be byte-identical. */
export const SEED_GENERATED_AT = "2026-07-20T02:00:00.000Z";
export const SEED_STARTED_AT = "2026-07-20T00:00:00.000Z";
export const SEED_FINISHED_AT = "2026-07-20T01:00:00.000Z";
const SEED_RUN_DURATION_MS = Date.parse(SEED_FINISHED_AT) - Date.parse(SEED_STARTED_AT);

/**
 * Deterministic ulid stream for seeded fixtures: the time part advances a
 * fixed base by an incrementing counter and the entropy bytes encode the
 * counter, so regenerating committed dev data only diffs when the seed
 * content (or export shape) actually changes. An optional `salt` fills the
 * leading entropy bytes (a pure hash, so still deterministic) — the counter
 * lives in the trailing bytes, so salted and unsalted streams never collide.
 */
export function seededIds(baseTimeMs: number, salt?: string): () => string {
  let counter = 0;
  const saltHash = salt === undefined ? 0 : fnv1a32(salt);
  return () => {
    counter += 1;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 4; i += 1) bytes[i] = (saltHash >>> (24 - i * 8)) & 0xff;
    let value = counter;
    for (let i = 15; i >= 0 && value > 0; i -= 1) {
      bytes[i] = value % 256;
      value = Math.floor(value / 256);
    }
    return ulid(baseTimeMs + counter, bytes);
  };
}

/** 32-bit FNV-1a — a pure, dependency-free string hash for id salts. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Seeding the same database twice (comparison fixtures do) must mint distinct
 * ids, while re-running the generator against a fresh database must mint
 * identical ones — so the deterministic stream advances per target db, never
 * globally. The stride dwarfs any per-seed counter, so streams cannot overlap.
 */
const seedInvocationsByDb = new Map<string, number>();
const SEED_INVOCATION_STRIDE_MS = 1_000_000;

function seedIdBase(dbPath: string, baseTimeMs: number): number {
  const invocation = seedInvocationsByDb.get(dbPath) ?? 0;
  seedInvocationsByDb.set(dbPath, invocation + 1);
  return baseTimeMs + invocation * SEED_INVOCATION_STRIDE_MS;
}

// ---------------------------------------------------------------------------
// The seeded grid
// ---------------------------------------------------------------------------

export interface SeedEvalSpec {
  id: string;
  framework: string;
  suite: EvalSuite;
}

export interface SeedExperimentSpec {
  id: string;
  group: string;
  treatment: "docs" | "mcp" | "cli";
  adapter: string;
  provider: string;
  model: string;
}

export const SEED_PRODUCT = "identity";
export const SEED_TRIALS = 3;

export const SEED_EVALS: readonly SeedEvalSpec[] = [
  { id: "auth-nextjs", framework: "nextjs", suite: "benchmark" },
  { id: "auth-rails", framework: "rails", suite: "benchmark" },
  { id: "auth-django", framework: "django", suite: "benchmark" },
];

export const SEED_REGRESSION_EVAL: SeedEvalSpec = {
  id: "callback-redirect-loop",
  framework: "nextjs",
  suite: "regression",
};

/** The codex group deliberately mismatches `model` on its mcp member → withheld. */
export const SEED_EXPERIMENTS: readonly SeedExperimentSpec[] = [
  { id: "claude-docs", group: "claude", treatment: "docs", adapter: "claude", provider: "anthropic", model: "model-a-1" },
  { id: "claude-mcp", group: "claude", treatment: "mcp", adapter: "claude", provider: "anthropic", model: "model-a-1" },
  { id: "claude-cli", group: "claude", treatment: "cli", adapter: "claude", provider: "anthropic", model: "model-a-1" },
  { id: "codex-docs", group: "codex", treatment: "docs", adapter: "codex", provider: "openai", model: "model-b-1" },
  { id: "codex-mcp", group: "codex", treatment: "mcp", adapter: "codex", provider: "openai", model: "model-b-2" },
  { id: "codex-cli", group: "codex", treatment: "cli", adapter: "codex", provider: "openai", model: "model-b-1" },
];

/** Treatment → the runtime config the offered-surface derivation reads. */
function treatmentConfig(treatment: SeedExperimentSpec["treatment"]): Record<string, unknown> {
  if (treatment === "docs") return { docs: { hosts: ["docs.acme.test"] } };
  if (treatment === "mcp") return { mcp: { servers: ["acme"] } };
  return { cli: { commands: ["acme"] } };
}

/** Minimal Experiment objects — what `compareGroups` compares. */
export function seedExperimentObjects(specs: readonly SeedExperimentSpec[]): Experiment[] {
  return specs.map((spec) => ({
    id: spec.id,
    agent: { adapter: spec.adapter, provider: spec.provider, model: spec.model, reasoning: "high" },
    runtime: { kind: "host" as const, config: treatmentConfig(spec.treatment) },
    comparisonGroup: spec.group,
    treatment: spec.treatment,
  }));
}

/**
 * A synthetic v3 RunManifest: every component hash is a deterministic
 * hash of the seed content + salt, so regenerating dev data is stable and
 * two salts never collide.
 */
export function buildSeedManifest(
  evals: readonly SeedEvalSpec[],
  experiments: readonly SeedExperimentSpec[],
  salt: string,
): RunManifest {
  const h = (parts: string[]): string => hashString(["seed", salt, ...parts].join("|"));

  const evalEntries: Record<string, EvalIdentity> = {};
  for (const spec of evals) {
    evalEntries[spec.id] = {
      id: spec.id,
      metadata: {
        id: spec.id,
        suite: spec.suite,
        product: SEED_PRODUCT,
        framework: spec.framework,
        topics: ["auth", spec.framework],
      },
      components: {
        promptSource: h(["prompt-source", spec.id]),
        effectivePrompt: h(["effective-prompt", spec.id]),
        local: null,
        scorer: h(["scorer", spec.id]),
        metadata: h(["metadata", spec.id]),
      },
      hash: h(["eval", spec.id]),
      solution: null,
    };
  }

  const experimentEntries: Record<string, ExperimentIdentity> = {};
  for (const spec of experiments) {
    experimentEntries[spec.id] = {
      id: spec.id,
      components: {
        source: h(["source", spec.id]),
        agent: {
          adapter: spec.adapter,
          provider: spec.provider,
          model: spec.model,
          reasoning: "high",
          cliVersion: "1.0.0",
        },
        runtime: h(["runtime", spec.treatment]),
        image: null,
        treatment: spec.treatment,
        harness: h(["harness"]),
      },
      hash: h(["experiment", spec.id, spec.model]),
    };
  }

  return {
    manifestVersion: "v3",
    harness: { version: "seed", revision: "seed", dirty: false, source: { sha256: h(["harness-source"]) } },
    evals: evalEntries,
    experiments: experimentEntries,
    images: {},
    hash: h(["manifest"]),
  };
}

/** The groups the runner would record: computed by the REAL comparison path. */
export function buildSeedGroups(
  experiments: readonly SeedExperimentSpec[],
  manifest: RunManifest,
): ComparisonGroup[] {
  return compareGroups(seedExperimentObjects(experiments), manifest);
}

type SeedOutcome = "pass" | "fail" | "error" | "incomplete";

/** Per-pair trial outcomes — the deliberate skews described in the header. */
function pairOutcomes(experimentId: string, framework: string): SeedOutcome[] {
  if (experimentId === "claude-docs") return ["pass", "pass", "pass"];
  if (experimentId === "claude-mcp") return ["fail", "fail", "fail"];
  if (experimentId === "claude-cli") return ["pass", "fail", "pass"];
  if (experimentId === "codex-docs") return ["pass", "pass", "fail"];
  if (experimentId === "codex-mcp") return framework === "django" ? ["fail", "pass", "error"] : ["fail", "pass", "fail"];
  // codex-cli: one timed-out (incomplete) trial on django
  return framework === "django" ? ["pass", "pass", "incomplete"] : ["pass", "pass", "fail"];
}

/**
 * Named check results: mcp failures cluster on flow-wired, cli on build-passes.
 * Every completed attempt also records an ungraded `sdk-wired` check that only
 * the mcp treatment passes — so docs/cli passes are SDK recall misses whose
 * pass/fail outcome is untouched.
 */
function seedChecks(outcome: SeedOutcome, treatment: string): CheckResult[] | undefined {
  if (outcome === "error" || outcome === "incomplete") return undefined;
  if (outcome === "pass") {
    return [
      { name: "flow-wired", passed: true },
      { name: "no-secrets-in-client", passed: true },
      { name: "build-passes", passed: true },
      { name: "sdk-wired", passed: treatment === "mcp", graded: false },
    ];
  }
  return [
    { name: "flow-wired", passed: treatment !== "cli" ? false : true },
    { name: "no-secrets-in-client", passed: true },
    { name: "build-passes", passed: treatment === "cli" ? false : true },
    { name: "sdk-wired", passed: treatment === "mcp", graded: false },
  ];
}

/**
 * Observed surface usage. Completed attempts show their offered channel in
 * use — EXCEPT the flaky claude-cli failure, which reads docs instead (the
 * offered≠used case) — and one codex-docs failure stores NULL (telemetry
 * unavailable on a completed attempt). Errors/incompletes are always NULL.
 */
function seedUsage(outcome: SeedOutcome, spec: SeedExperimentSpec): SurfaceUsage | null {
  if (outcome === "error" || outcome === "incomplete") return null;
  if (spec.id === "codex-docs" && outcome === "fail") return null;
  const usage: SurfaceUsage = {
    docs: { count: 0, urls: [] },
    mcp: { count: 0, tools: [] },
    cli: { count: 0, commands: [] },
  };
  if (spec.id === "claude-cli" && outcome === "fail") {
    usage.docs = { count: 1, urls: ["https://docs.acme.test/auth"] };
    return usage;
  }
  if (spec.treatment === "docs") usage.docs = { count: 2, urls: ["https://docs.acme.test/auth"] };
  else if (spec.treatment === "mcp") usage.mcp = { count: 2, tools: ["acme__list_orgs"] };
  else usage.cli = { count: 2, commands: ["acme auth"] };
  return usage;
}

function transcriptFixture(outcome: SeedOutcome, treatment: string): string {
  if (outcome === "pass") return "passing.jsonl";
  if (treatment === "mcp") return "failing-mcp.jsonl";
  if (treatment === "cli") return "failing-cli.jsonl";
  // A docs-arm failure reads like success in the transcript — the checks
  // disagreed. That mismatch is realistic.
  return "passing.jsonl";
}

function seededDiff(outcome: SeedOutcome, evalId: string, treatment: string): string {
  const body =
    outcome === "pass"
      ? [
          "--- a/src/auth.ts",
          "+++ b/src/auth.ts",
          "@@ -0,0 +1,4 @@",
          `+// ${evalId} auth integration (${treatment} treatment)`,
          "+export function requireSession(req, res, next) {",
          "+  if (!req.session?.userId) return res.redirect('/login');",
          "+  next();",
          "+}",
        ]
      : [
          "--- a/src/auth.ts",
          "+++ b/src/auth.ts",
          "@@ -0,0 +1,3 @@",
          `+// partial ${evalId} auth wiring (${treatment} treatment)`,
          "+export function requireSession(req, res, next) {",
          "+  next(); // TODO: session check — callback contract unverified",
          "+}",
        ];
  return `${body.join("\n")}\n`;
}

export interface SeedOptions {
  dbPath: string;
  resultsDir: string;
  /** Trials per pair (default 3). */
  trials?: number;
  /** Leave the run unfinished (finished_at NULL) — incomplete-run testing. */
  unfinished?: boolean;
  /** Drop the last N attempts — per-pair completeness testing. */
  dropLast?: number;
  /**
   * Also seed a regression-suite eval (a pinned known failure mode) against
   * the two docs experiments. Off by default so the canonical 54-attempt/
   * 18-pair counts hold in tests that expect them.
   */
  withRegression?: boolean;
  /**
   * Mixed into the id stream's entropy bytes so a second seeded run in one
   * database is distinct by construction (the per-db invocation stride
   * already separates streams; the salt makes the intent explicit).
   */
  idSalt?: string;
  /**
   * Run start (ISO, default {@link SEED_STARTED_AT}); the run finishes one
   * hour later. Lets a fixture run sort older than the canonical sweep.
   */
  startedAt?: string;
}

export interface SeedResult {
  runId: string;
  dbPath: string;
  resultsDir: string;
  attempts: number;
}

/** Write the synthetic run. Reusable from tests; the CLI below is a thin wrapper. */
export function seedRun(options: SeedOptions): SeedResult {
  const store = new ResultsStore(options.dbPath);
  try {
    const trials = options.trials ?? SEED_TRIALS;
    if (!Number.isInteger(trials) || trials < 1) {
      throw new Error(`seed trials must be an integer >= 1, got ${trials}`);
    }
    const startedAtMs = Date.parse(options.startedAt ?? SEED_STARTED_AT);
    if (Number.isNaN(startedAtMs)) throw new Error(`seed startedAt must be an ISO timestamp, got ${options.startedAt}`);
    const nextId = seededIds(seedIdBase(options.dbPath, startedAtMs), options.idSalt);
    const runId = nextId();

    const evals: SeedEvalSpec[] = [...SEED_EVALS, ...(options.withRegression ? [SEED_REGRESSION_EVAL] : [])];
    const manifest = buildSeedManifest(evals, SEED_EXPERIMENTS, "seed-run-v3");
    const groups = buildSeedGroups(SEED_EXPERIMENTS, manifest);

    store.insertRun({
      id: runId,
      startedAt: startedAtMs,
      manifest,
      config: {
        trials,
        evalIds: evals.map((spec) => spec.id),
        experimentIds: SEED_EXPERIMENTS.map((spec) => spec.id),
        egress: { proxy: false, allowlist: [] },
        groups,
      },
    });

    // Deterministic plan order: eval, experiment, trial.
    interface PlanEntry {
      evalSpec: SeedEvalSpec;
      experiment: SeedExperimentSpec;
      trialIndex: number;
      outcome: SeedOutcome;
    }
    const plan: PlanEntry[] = [];
    for (const evalSpec of SEED_EVALS) {
      for (const experiment of SEED_EXPERIMENTS) {
        const outcomes = pairOutcomes(experiment.id, evalSpec.framework);
        for (let trialIndex = 0; trialIndex < trials; trialIndex += 1) {
          plan.push({ evalSpec, experiment, trialIndex, outcome: outcomes[trialIndex % outcomes.length] as SeedOutcome });
        }
      }
    }
    if (options.withRegression) {
      for (const experiment of SEED_EXPERIMENTS.filter((spec) => spec.treatment === "docs")) {
        const outcomes: SeedOutcome[] = experiment.group === "claude" ? ["fail", "fail", "fail"] : ["pass", "fail", "fail"];
        for (let trialIndex = 0; trialIndex < trials; trialIndex += 1) {
          plan.push({
            evalSpec: SEED_REGRESSION_EVAL,
            experiment,
            trialIndex,
            outcome: outcomes[trialIndex % outcomes.length] as SeedOutcome,
          });
        }
      }
    }
    const kept = options.dropLast !== undefined && options.dropLast > 0 ? plan.slice(0, -options.dropLast) : plan;

    let sequence = 0;
    for (const entry of kept) {
      sequence += 1;
      const attemptId = nextId();
      const attemptDir = join(options.resultsDir, runId, attemptId);
      mkdirSync(attemptDir, { recursive: true });

      const transcriptPath = join(attemptDir, "transcript.jsonl");
      copyFileSync(join(FIXTURES_DIR, transcriptFixture(entry.outcome, entry.experiment.treatment)), transcriptPath);
      let diffPath: string | null = null;
      if (entry.outcome !== "error" && entry.outcome !== "incomplete") {
        diffPath = join(attemptDir, "diff.patch");
        writeFileSync(diffPath, seededDiff(entry.outcome, entry.evalSpec.id, entry.experiment.treatment), "utf8");
      }
      if (entry.outcome === "error") {
        writeFileSync(join(attemptDir, "error.txt"), "attempt timed out after 1500000ms — container removed\n", "utf8");
      }

      const status: AttemptStatus =
        entry.outcome === "error" ? "error" : entry.outcome === "incomplete" ? "incomplete" : "completed";
      const checks = seedChecks(entry.outcome, entry.experiment.treatment);
      const result: EvalResult | undefined =
        checks === undefined ? undefined : { passed: entry.outcome === "pass", checks };
      const telemetryAvailable = status === "completed";
      const attemptStartedAt = startedAtMs + sequence * 60_000;
      const attemptFinishedAt = attemptStartedAt + 90_000 + sequence * 100;

      store.insertAttempt({
        id: attemptId,
        runId,
        evalId: entry.evalSpec.id,
        experimentId: entry.experiment.id,
        suite: entry.evalSpec.suite,
        trialIndex: entry.trialIndex,
        attemptIdentityHash: hashString(
          ["seed-attempt", manifest.evals[entry.evalSpec.id]?.hash ?? "", manifest.experiments[entry.experiment.id]?.hash ?? ""].join("|"),
        ),
        status,
        ...(result !== undefined ? { result } : {}),
        surfaceUsage: seedUsage(entry.outcome, entry.experiment),
        transcriptRef: transcriptPath,
        diffRef: diffPath,
        costUsd: telemetryAvailable ? 0.11 : null,
        tokensIn: telemetryAvailable ? 200 + sequence : null,
        tokensOut: telemetryAvailable ? 1200 + sequence : null,
        turns: telemetryAvailable ? 4 + (sequence % 5) : null,
        startedAt: attemptStartedAt,
        finishedAt: attemptFinishedAt,
        ...(entry.outcome === "error" ? { error: "attempt timed out after 1500000ms", errorKind: "agent" as const } : {}),
        // Agent phase inside the wall-clock window (provisioning before, export + scoring after).
        ...(status === "completed" ? { agentStartedAt: attemptStartedAt + 5_000, agentFinishedAt: attemptFinishedAt - 3_000 } : {}),
      });
    }

    if (!options.unfinished) {
      const finishedAtMs =
        options.startedAt === undefined ? Date.parse(SEED_FINISHED_AT) : startedAtMs + SEED_RUN_DURATION_MS;
      store.finishRun(runId, finishedAtMs);
    }
    return { runId, dbPath: options.dbPath, resultsDir: options.resultsDir, attempts: kept.length };
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      db: { type: "string", default: "seed-results.db" },
      results: { type: "string", default: "seed-results" },
      unfinished: { type: "boolean", default: false },
      regression: { type: "boolean", default: false },
    },
  });
  const seeded = seedRun({
    dbPath: values.db,
    resultsDir: values.results,
    unfinished: values.unfinished,
    withRegression: values.regression,
  });
  console.log(`seeded run ${seeded.runId}: ${seeded.attempts} attempts -> ${values.db} + ${values.results}/${seeded.runId}/`);
  console.log(`next: bun src/cli.ts report ${seeded.runId} --db ${values.db} --results ${values.results}`);
}
