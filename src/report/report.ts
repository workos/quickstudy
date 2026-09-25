/**
 * The v3 report: honest aggregation over the eval × experiment store, and
 * nothing else. JSON is the source shape (written as `report.json` into the
 * run's results dir); the text renderer renders FROM that JSON; the UI reads
 * the same JSON — one aggregation codepath for all three consumers.
 *
 * What the report states, by design:
 *   - pass rates per eval × experiment pair (scored = passed + failed;
 *     incomplete and errored attempts are counted separately and NEVER enter
 *     the denominator);
 *   - per-pair pass@k / pass^k, restatements of the same scored counts
 *     (see pass-at-k.ts) — within-run only, no wider claim;
 *   - named check outcomes with per-check tallies;
 *   - cost/token telemetry summed only over attempts that reported it
 *     ("unavailable", never 0, when none did);
 *   - raw per-arm counts ("3/3" vs "1/3") for declared comparison groups,
 *     with withheld groups rendering their component diff instead;
 *   - offered-versus-used surface telemetry per experiment;
 *   - egress denials, when the proxied run recorded any.
 *
 * There are deliberately no intervals, no statistical estimates, no analyst layers,
 * and no language stronger than the counts themselves (see BANNED_LANGUAGE).
 * Opt-in token-cost estimates are a separate layer, never provider-reported telemetry.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashString } from "../hash.ts";
import { publicationCoverage, trialCoverage, type PairCoverage, type PublicationCoverage } from "../completeness.ts";
import type { ComparisonGroup } from "../experiments/groups.ts";
import { activeAttempts, type AttemptRecord, type ResultsStore, type RunRecord } from "../store/db.ts";
import type { SurfaceUsage } from "../surface-usage.ts";
import { ECHO_IDENTITY } from "../adapters/echo.ts";
import { ORACLE_IDENTITY } from "../adapters/oracle.ts";
import { collectPassAtK, displayPassAtK, type PassAtKEntry } from "./pass-at-k.ts";
import { estimateRunCosts, type Pricing, type RunCostEstimate } from "./costs.ts";
import {
  collectBands,
  collectScorerHealth,
  type EvalBand,
  type ExperimentRole,
  type ScorerHealth,
} from "./scorer-health.ts";
import { collectExperimentAggregate, compareLeaderboard, type ExperimentAggregate } from "./aggregate.ts";

export type { EvalBand, ExperimentRole, ScorerHealth, ScorerHealthSuspect } from "./scorer-health.ts";
export type { ExperimentAggregate } from "./aggregate.ts";
export { compareLeaderboard } from "./aggregate.ts";

/** Loud, CLI-friendly failures (unknown run, missing report.json, ...). */
export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

export const REPORT_SCHEMA_VERSION = 10;

/**
 * Substrings that must never appear in generated report prose: at n≤5 trials
 * the honest statement is the raw counts, so the report never claims more.
 * (Note "caus" also catches "because" — write around it.)
 */
export const BANNED_LANGUAGE = ["caus", "effect of", "significant"] as const;

/** Return every banned-language fragment present in `text` (case-insensitive). */
export function findBannedLanguage(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_LANGUAGE.filter((banned) => lower.includes(banned));
}

/** Methodology is generated prose — it must itself pass the language guard. */
export function methodologyNote(trials: number): string {
  return (
    `Pass rates are per eval × experiment pair: passed / (passed + failed). Incomplete and errored ` +
    `attempts are counted separately and never enter that denominator. Each pair has ${trials} planned ` +
    `trial${trials === 1 ? "" : "s"} — at these counts the raw counts are the honest statement, so comparison ` +
    `groups render per-arm counts only: no intervals, no estimates, no attribution. A group whose members ` +
    `differ beyond their declared treatment has its comparison withheld and the differing components are ` +
    `listed instead; its raw per-experiment results remain visible. Per-pair pass@k and pass^k restate the ` +
    `same scored counts: pass@k is the fraction of size-k subsets of that pair's scored trials containing at ` +
    `least one pass, and pass^k is (passed/scored)^k, the all-pass rate for k with-replacement draws from ` +
    `those trials. Both describe this run's trials only — no wider claim. Telemetry (cost, tokens, surface ` +
    `usage) is summed only over attempts that reported it and shown as unavailable — never zero — when none did. ` +
    `SDK recall is reported per experiment as recalled / attempts, where attempts are the scored attempts that ` +
    `recorded at least one ungraded check and recalled are those whose ungraded checks all passed. Ungraded ` +
    `checks are recorded and tallied but never enter pass/fail. Scorer health lists checks that failed in every ` +
    `scored attempt of an eval under every arm while another check in the same attempts passed: a statement ` +
    `about the instrument, not about any treatment. Control experiments — an oracle that applies each eval's ` +
    `reference solution, a no-op that changes nothing — are reported alongside the agent experiments and ` +
    `tagged as controls wherever they appear; bands and scorer health are decided over the agent experiments ` +
    `only, and controls are ranked after every agent experiment.`
  );
}

/** Agent identity recorded verbatim in the manifest — never inferred. */
export interface ReportAgentIdentity {
  adapter: string;
  provider: string;
  /** The pinned model id; "unspecified" when the experiment pinned none. */
  model: string;
  /** The pinned reasoning effort; "unspecified" when the experiment pinned none. */
  reasoning: string;
  cli_version: string;
}

/**
 * SDK recall for one experiment, derived from `graded: false` checks. Only
 * scored (completed) attempts count; graded timeouts are completed.
 */
export interface ReportRecall {
  /** Scored attempts of this experiment whose checks include at least one graded:false check. */
  attempts: number;
  /** Of those, attempts where every graded:false check passed. */
  recalled: number;
  /** recalled / attempts; null when attempts = 0. */
  rate: number | null;
}

/** One experiment's identity card: what exactly ran under this id. */
export interface ReportExperiment {
  experiment_id: string;
  treatment: string | null;
  agent: ReportAgentIdentity;
  /**
   * "agent" for an arm; "positive-control" (the oracle) and "negative-control"
   * (the echo no-op) never decide a band or a scorer-health suspect. Optional on
   * the wire: absent in schema_version < 10 artifacts; readers treat absence as
   * "agent".
   */
  role?: ExperimentRole;
  /**
   * Optional on the wire: absent in schema_version < 7 artifacts, which the
   * export may still carry — readers must tolerate absence.
   */
  sdk_recall?: ReportRecall;
  /**
   * Leaderboard row over benchmark-suite attempts. Optional on the wire:
   * absent in schema_version < 9 artifacts; readers must tolerate absence.
   */
  aggregate?: ExperimentAggregate;
}

export interface ReportCheck {
  name: string;
  passed: number;
  total: number;
  /**
   * false when any attempt recorded this check with `graded: false` (a scorer
   * that flips the flag mid-run marks the whole tally ungraded). Absent in
   * schema_version < 7 artifacts; readers treat absence as graded.
   */
  graded: boolean;
}

/** One eval × experiment aggregation. Pairs with zero attempts are ABSENT, never 0%. */
export interface ReportPair {
  eval_id: string;
  experiment_id: string;
  suite: string;
  total: number;
  passed: number;
  failed: number;
  incomplete: number;
  errors: number;
  /** passed + failed — the pass-rate denominator. */
  scored: number;
  /** passed / scored; null when nothing was scored (never 0-by-default). */
  pass_rate: number | null;
  /**
   * pass@k / pass^k for every k from 1 to scored — per-k restatements of the
   * same counts (see pass-at-k.ts), empty when nothing was scored. Optional
   * on the wire: absent in schema_version < 5 artifacts, which the export
   * deliberately copies verbatim — readers must tolerate absence.
   */
  pass_at_k?: PassAtKEntry[];
  /** Completed trials disagreed on the outcome. */
  flaky: boolean;
  checks: ReportCheck[];
  /**
   * The eval's band, denormalised onto each of its pairs (control pairs too):
   * decided over the eval's agent pairs with scored > 0; null when fewer than 2
   * agent arms scored (before schema 10, controls counted as arms). Absent
   * in schema_version < 8 artifacts; readers treat absence as unbanded.
   */
  band: EvalBand | null;
}

export interface ReportGroupArmCount {
  eval_id: string;
  passed: number;
  scored: number;
  /** The honest raw statement, e.g. "3/3". */
  display: string;
}

export interface ReportGroupArm {
  experiment_id: string;
  treatment: string | null;
  evals: ReportGroupArmCount[];
}

/**
 * One declared comparison group. `compared` renders raw per-arm counts;
 * `withheld` renders the component diff and NO counts-as-comparison.
 */
export interface ReportGroup {
  group: string;
  experiment_ids: string[];
  comparison: "compared" | "withheld";
  /** Component-diff lines naming members and values (withheld groups only). */
  details: string[];
  /** Raw per-arm counts (compared groups only). */
  arms: ReportGroupArm[];
}

export interface ReportUsageChannel {
  /** Attempts with at least one observed event on this channel. */
  attempts: number;
  /** Total observed events across those attempts. */
  events: number;
  /** Redacted identifiers (deduplicated, capped). */
  values: string[];
}

/** Offered-versus-used surface telemetry for one experiment. */
export interface ReportExperimentUsage {
  experiment_id: string;
  treatment: string | null;
  /** Attempts whose raw stream supported extraction. */
  telemetry_available: number;
  /** Attempts stored with NULL usage (no supported stream) — never counted as zero use. */
  telemetry_unavailable: number;
  channels: { docs: ReportUsageChannel; mcp: ReportUsageChannel; cli: ReportUsageChannel };
}

export interface EgressDenialSummary {
  attempt_id: string;
  eval_id: string;
  experiment_id: string;
  count: number;
  top_hosts: Array<{ host: string; count: number }>;
}

export interface ReportRunInfo {
  id: string;
  /** ISO timestamps on the wire (the store keeps epoch milliseconds). */
  started_at: string;
  finished_at: string | null;
  trials: number;
  eval_ids: string[];
  experiment_ids: string[];
  manifest_hash: string;
}

export interface ReportTotals {
  attempts: number;
  passed: number;
  failed: number;
  incomplete: number;
  errors: number;
}

export interface ReportTelemetry {
  /** null = no attempt reported cost (unavailable, never 0). */
  cost_usd: number | null;
  cost_attempts: number;
  tokens_in: number | null;
  tokens_out: number | null;
  token_attempts: number;
}

export interface ReportJson {
  schema_version: number;
  generated_at: string;
  run: ReportRunInfo;
  /** Unfinished run or missing/invalid trial coverage. */
  incomplete: boolean;
  /** Added in schema 6; historical reports retain their recorded semantics. */
  coverage?: PairCoverage[];
  source_fingerprint?: string;
  publication?: PublicationCoverage & { source_totals: ReportTotals; source_incomplete: boolean };
  retry_history?: Array<{ attempt_id: string; status: string; error: string | null }>;
  totals: ReportTotals;
  telemetry: ReportTelemetry;
  /** Optional runtime-priced supplement; absent on historical or unpriced reports. */
  cost_estimate?: RunCostEstimate;
  judge_telemetry?: { provenance: "semantic-judge"; calls: number; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null };
  /**
   * Per-experiment identity cards (model, reasoning, adapter, ...). Optional
   * on the wire: absent in schema_version < 4 artifacts, which the export
   * deliberately copies verbatim — readers must tolerate absence.
   */
  experiments?: ReportExperiment[];
  pairs: ReportPair[];
  /**
   * Checks that failed under every arm while another graded check passed in
   * the same attempts. Absent in schema_version < 8 artifacts; readers must
   * tolerate absence.
   */
  scorer_health?: ScorerHealth;
  groups: ReportGroup[];
  usage: ReportExperimentUsage[];
  egress_denials: EgressDenialSummary[];
  /** v6: empty denial logs are observed zero; absent logs are unavailable. */
  egress_observation?: { available: string[]; unavailable: string[] };
  methodology: string;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const USAGE_VALUE_CAP = 20;

export function collectPairs(attempts: AttemptRecord[]): ReportPair[] {
  const pairs = new Map<string, { pair: ReportPair; checks: Map<string, { passed: number; total: number; graded: boolean }>; outcomes: Set<boolean> }>();
  for (const attempt of attempts) {
    const key = `${attempt.evalId}|${attempt.experimentId}`;
    let entry = pairs.get(key);
    if (!entry) {
      entry = {
        pair: {
          eval_id: attempt.evalId,
          experiment_id: attempt.experimentId,
          suite: attempt.suite,
          total: 0,
          passed: 0,
          failed: 0,
          incomplete: 0,
          errors: 0,
          scored: 0,
          pass_rate: null,
          flaky: false,
          checks: [],
          band: null,
        },
        checks: new Map(),
        outcomes: new Set(),
      };
      pairs.set(key, entry);
    }
    entry.pair.total += 1;
    if (attempt.status === "incomplete") entry.pair.incomplete += 1;
    else if (attempt.status === "error") entry.pair.errors += 1;
    else if (attempt.result?.passed) {
      entry.pair.passed += 1;
      entry.outcomes.add(true);
    } else {
      entry.pair.failed += 1;
      entry.outcomes.add(false);
    }
    for (const check of attempt.result?.checks ?? []) {
      const tally = entry.checks.get(check.name) ?? { passed: 0, total: 0, graded: true };
      tally.total += 1;
      if (check.passed) tally.passed += 1;
      if (check.graded === false) tally.graded = false;
      entry.checks.set(check.name, tally);
    }
  }

  const result: ReportPair[] = [];
  for (const { pair, checks, outcomes } of pairs.values()) {
    pair.scored = pair.passed + pair.failed;
    pair.pass_rate = pair.scored > 0 ? pair.passed / pair.scored : null;
    pair.pass_at_k = collectPassAtK(pair.passed, pair.scored);
    pair.flaky = outcomes.size > 1;
    pair.checks = [...checks.entries()]
      .map(([name, tally]) => ({ name, passed: tally.passed, total: tally.total, graded: tally.graded }))
      .sort((a, b) => a.name.localeCompare(b.name));
    result.push(pair);
  }
  return result.sort(
    (a, b) => a.eval_id.localeCompare(b.eval_id) || a.experiment_id.localeCompare(b.experiment_id),
  );
}

function collectTotals(attempts: AttemptRecord[]): ReportTotals {
  const completed = attempts.filter((attempt) => attempt.status === "completed");
  const passed = completed.filter((attempt) => attempt.result?.passed).length;
  return {
    attempts: attempts.length,
    passed,
    failed: completed.length - passed,
    incomplete: attempts.filter((attempt) => attempt.status === "incomplete").length,
    errors: attempts.filter((attempt) => attempt.status === "error").length,
  };
}

function collectTelemetry(attempts: AttemptRecord[]): ReportTelemetry {
  // Telemetry is NULL when unavailable — sums only cover attempts that
  // reported it, and a run with none reports null rather than 0.
  const costs = attempts.map((a) => a.costUsd).filter((v): v is number => v !== null);
  const tokensIn = attempts.map((a) => a.tokensIn).filter((v): v is number => v !== null);
  const tokensOut = attempts.map((a) => a.tokensOut).filter((v): v is number => v !== null);
  const sum = (values: number[]): number => values.reduce((total, v) => total + v, 0);
  return {
    cost_usd: costs.length > 0 ? sum(costs) : null,
    cost_attempts: costs.length,
    tokens_in: tokensIn.length > 0 ? sum(tokensIn) : null,
    tokens_out: tokensOut.length > 0 ? sum(tokensOut) : null,
    token_attempts: Math.max(tokensIn.length, tokensOut.length),
  };
}

function treatmentOf(run: RunRecord, experimentId: string): string | null {
  return run.manifest.experiments[experimentId]?.components.treatment ?? null;
}

/**
 * Identity cards from the manifest, verbatim. The manifest records every
 * experiment; "unspecified" is its own explicit missing-value sentinel, so
 * this never invents a value the run did not pin.
 */
/**
 * SDK recall over one experiment's scored attempts: the denominator is every
 * completed attempt that recorded at least one `graded: false` check; an
 * attempt is recalled when all of those checks passed. Null rate at zero.
 */
export function collectRecall(attempts: AttemptRecord[], experimentId: string): ReportRecall {
  let total = 0;
  let recalled = 0;
  for (const attempt of attempts) {
    if (attempt.experimentId !== experimentId || attempt.status !== "completed") continue;
    const ungraded = (attempt.result?.checks ?? []).filter((check) => check.graded === false);
    if (ungraded.length === 0) continue;
    total += 1;
    if (ungraded.every((check) => check.passed)) recalled += 1;
  }
  return { attempts: total, recalled, rate: total > 0 ? recalled / total : null };
}

/** The manifest's agent components equal a built-in adapter's pinned identity, field for field. */
function isBuiltIn(
  agent: { adapter: string; provider: string; model: string; reasoning: string; cliVersion: string },
  adapter: string,
  identity: { provider: string; model: string; reasoning: string; cliVersion: string },
): boolean {
  return (
    agent.adapter === adapter &&
    agent.provider === identity.provider &&
    agent.model === identity.model &&
    agent.reasoning === identity.reasoning &&
    agent.cliVersion === identity.cliVersion
  );
}

/**
 * An experiment's role as the run recorded it. A run from before roles were
 * recorded (so an export rebuilding its schema-9 report) falls back to the
 * manifest: a control only when the recorded agent is a built-in's exact pinned
 * identity — the oracle's (which refuses a scripted command), or the echo
 * adapter's on a host runtime. A name alone never makes a control.
 */
function roleOf(run: RunRecord, experimentId: string): ExperimentRole {
  const recorded = run.config.roles?.[experimentId];
  if (recorded !== undefined) return recorded;
  const components = run.manifest.experiments[experimentId]?.components;
  const agent = components?.agent;
  if (agent === undefined) return "agent";
  if (isBuiltIn(agent, "oracle", ORACLE_IDENTITY)) return "positive-control";
  if (isBuiltIn(agent, "echo", ECHO_IDENTITY) && (components?.image ?? null) === null) return "negative-control";
  return "agent";
}

/** The run's control experiments, from the roles it recorded. */
function controlExperiments(run: RunRecord): Set<string> {
  return new Set(run.config.experimentIds.filter((id) => roleOf(run, id) !== "agent"));
}

function collectExperiments(
  run: RunRecord,
  attempts: AttemptRecord[],
  pairs: ReportPair[],
  costEstimate: RunCostEstimate | undefined,
): ReportExperiment[] {
  return [...run.config.experimentIds]
    .sort((a, b) => a.localeCompare(b))
    .map((experimentId) => {
      const agent = run.manifest.experiments[experimentId]?.components.agent;
      return {
        experiment_id: experimentId,
        treatment: treatmentOf(run, experimentId),
        role: roleOf(run, experimentId),
        agent: {
          adapter: agent?.adapter ?? "unspecified",
          provider: agent?.provider ?? "unspecified",
          model: agent?.model ?? "unspecified",
          reasoning: agent?.reasoning ?? "unspecified",
          cli_version: agent?.cliVersion ?? "unspecified",
        },
        sdk_recall: collectRecall(attempts, experimentId),
        aggregate: collectExperimentAggregate(attempts, pairs, experimentId, costEstimate),
      };
    });
}

/**
 * Comparison groups come from the run's recorded config (computed at run
 * time by `compareGroups`). Singleton groups have nothing to compare and are
 * omitted — their raw results already render as pairs. A withheld group
 * renders its diff details and never counts-as-comparison.
 */
function collectGroups(run: RunRecord, pairs: ReportPair[]): ReportGroup[] {
  const declared: ComparisonGroup[] = run.config.groups ?? [];
  const groups: ReportGroup[] = [];
  for (const group of declared) {
    if (group.experimentIds.length < 2) continue;
    if (group.comparison === "withheld") {
      groups.push({
        group: group.group,
        experiment_ids: [...group.experimentIds],
        comparison: "withheld",
        details: [...group.details],
        arms: [],
      });
      continue;
    }
    const arms: ReportGroupArm[] = group.experimentIds.map((experimentId) => ({
      experiment_id: experimentId,
      treatment: treatmentOf(run, experimentId),
      evals: pairs
        .filter((pair) => pair.experiment_id === experimentId)
        .map((pair) => ({
          eval_id: pair.eval_id,
          passed: pair.passed,
          scored: pair.scored,
          display: `${pair.passed}/${pair.scored}`,
        })),
    }));
    groups.push({
      group: group.group,
      experiment_ids: [...group.experimentIds],
      comparison: "compared",
      details: [],
      arms,
    });
  }
  return groups.sort((a, b) => a.group.localeCompare(b.group));
}

function emptyChannel(): ReportUsageChannel {
  return { attempts: 0, events: 0, values: [] };
}

function addChannel(channel: ReportUsageChannel, count: number, values: string[]): void {
  if (count === 0) return;
  channel.attempts += 1;
  channel.events += count;
  for (const value of values) {
    if (channel.values.length >= USAGE_VALUE_CAP) break;
    if (!channel.values.includes(value)) channel.values.push(value);
  }
}

function collectUsage(run: RunRecord, attempts: AttemptRecord[]): ReportExperimentUsage[] {
  const byExperiment = new Map<string, ReportExperimentUsage>();
  const experimentIds = [...new Set(attempts.map((attempt) => attempt.experimentId))].sort((a, b) => a.localeCompare(b));
  for (const experimentId of experimentIds) {
    byExperiment.set(experimentId, {
      experiment_id: experimentId,
      treatment: treatmentOf(run, experimentId),
      telemetry_available: 0,
      telemetry_unavailable: 0,
      channels: { docs: emptyChannel(), mcp: emptyChannel(), cli: emptyChannel() },
    });
  }
  for (const attempt of attempts) {
    const usage = byExperiment.get(attempt.experimentId) as ReportExperimentUsage;
    const observed: SurfaceUsage | null = attempt.surfaceUsage;
    if (observed === null) {
      usage.telemetry_unavailable += 1;
      continue;
    }
    usage.telemetry_available += 1;
    addChannel(usage.channels.docs, observed.docs.count, observed.docs.urls);
    addChannel(usage.channels.mcp, observed.mcp.count, observed.mcp.tools);
    addChannel(usage.channels.cli, observed.cli.count, observed.cli.commands);
  }
  return [...byExperiment.values()];
}

/** Denied-host counts, descending — the drill-down summary shape. */
export function summarizeDenialHosts(
  denials: readonly { host: string }[],
  limit: number,
): Array<{ host: string; count: number }> {
  const counts = new Map<string, number>();
  for (const { host } of denials) counts.set(host, (counts.get(host) ?? 0) + 1);
  return [...counts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
    .slice(0, limit);
}

/**
 * Read each attempt's egress-denials.log (written only when the proxied
 * attempt was denied at least once) into the per-attempt rollup. Unreadable
 * or malformed logs are skipped — the rollup is a summary, never a gate.
 */
function collectEgressDenials(resultsDir: string, runId: string, attempts: AttemptRecord[]): EgressDenialSummary[] {
  const summaries: EgressDenialSummary[] = [];
  for (const attempt of attempts) {
    const path = join(resultsDir, runId, attempt.id, "egress-denials.log");
    if (!existsSync(path)) continue;
    let hosts: Array<{ host: string }>;
    try {
      hosts = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { host: string });
    } catch {
      continue;
    }
    if (hosts.length === 0) continue;
    summaries.push({
      attempt_id: attempt.id,
      eval_id: attempt.evalId,
      experiment_id: attempt.experimentId,
      count: hosts.length,
      top_hosts: summarizeDenialHosts(hosts, 3),
    });
  }
  return summaries.sort((a, b) => b.count - a.count || a.attempt_id.localeCompare(b.attempt_id));
}

export interface BuildReportOptions {
  expectedTrials?: number;
  /** Explicit runtime rate snapshot; never changes stored provider-reported costs. */
  pricing?: Pricing;
  store: ResultsStore;
  runId: string;
  /** Artifacts root (the harness `--results` dir) — egress denial logs live here. */
  resultsDir: string;
  /** Overrides the `generated_at` stamp — fixture seeding only. */
  generatedAt?: string;
}

/** Build the report from the store + manifest. Deterministic, offline, synchronous. */
export function buildReport(options: BuildReportOptions): ReportJson {
  const { store, runId } = options;
  const run = store.getRun(runId);
  if (!run) {
    const known = store
      .listRuns()
      .slice(0, 5)
      .map((candidate) => `  ${candidate.id} (started ${new Date(candidate.startedAt).toISOString()})`);
    throw new ReportError(
      `no run "${runId}" in this results database${known.length > 0 ? `; most recent runs:\n${known.join("\n")}` : ""}`,
    );
  }
  const history = store.listAttempts(runId);
  const current = activeAttempts(history);
  const coverage = trialCoverage(run, current);
  const publication = options.expectedTrials === undefined ? undefined : publicationCoverage(run, current, options.expectedTrials);
  if (publication && publication.eligible.length === 0) throw new ReportError(`no eligible complete samples for run ${runId}: ${publication.omitted.map((p) => `${p.eval_id} × ${p.experiment_id}: ${p.reasons.join("; ")}`).join(" | ")}`);
  const attempts = publication ? current.filter((a) => publication.eligible.some((p) => p.eval_id === a.evalId && p.experiment_id === a.experimentId)) : current;
  const pairs = collectPairs(attempts);
  const controls = controlExperiments(run);
  const bands = collectBands(pairs, controls);
  for (const pair of pairs) pair.band = bands.get(pair.eval_id) ?? null;
  const scorerHealth = collectScorerHealth(attempts, pairs, controls);
  const costEstimate = options.pricing === undefined ? undefined : estimateRunCosts(run, attempts, options.resultsDir, options.pricing);

  const methodology = methodologyNote(run.config.trials) + (costEstimate === undefined ? "" :
    " Optional token-cost estimates supplement reported cost using the supplied pricing snapshot. They cover only the selected attempts, not superseded retries, tool fees, diagnosis or infrastructure, and are not billing records.");
  const banned = findBannedLanguage(methodology);
  if (banned.length > 0) {
    throw new ReportError(`report methodology violates the language guard: ${banned.join(", ")}`);
  }
  const bannedSummary = findBannedLanguage(scorerHealth.summary);
  if (bannedSummary.length > 0) {
    throw new ReportError(`report scorer-health summary violates the language guard: ${bannedSummary.join(", ")}`);
  }

  return {
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    run: {
      id: run.id,
      started_at: new Date(run.startedAt).toISOString(),
      finished_at: run.finishedAt === null ? null : new Date(run.finishedAt).toISOString(),
      trials: run.config.trials,
      eval_ids: [...run.config.evalIds],
      experiment_ids: [...run.config.experimentIds],
      manifest_hash: run.manifestHash,
    },
    incomplete: publication ? false : run.finishedAt === null || coverage.length === 0 || coverage.some((pair) => !pair.complete),
    source_fingerprint: hashString(JSON.stringify({ manifest: run.manifestHash, finishedAt: run.finishedAt, trials: run.config.trials, evals: run.config.evalIds, experiments: run.config.experimentIds, history: history.map(({ transcriptRef, diffRef, ...row }) => ({ ...row, transcript: Boolean(transcriptRef), diff: Boolean(diffRef) })), costEstimate })),
    ...(publication ? { publication: { ...publication, source_totals: collectTotals(current), source_incomplete: run.finishedAt === null || coverage.some((p) => !p.complete) } } : {}),
    coverage,
    retry_history: history.filter((a) => !current.includes(a)).map((a) => ({ attempt_id: a.id, status: a.status, error: a.error })),
    totals: collectTotals(attempts),
    telemetry: collectTelemetry(attempts),
    ...(costEstimate === undefined ? {} : { cost_estimate: costEstimate }),
    judge_telemetry: collectJudgeTelemetry(attempts),
    experiments: collectExperiments(run, attempts, pairs, costEstimate),
    pairs,
    scorer_health: scorerHealth,
    groups: collectGroups(run, pairs),
    usage: collectUsage(run, attempts),
    egress_denials: collectEgressDenials(options.resultsDir, runId, attempts),
    egress_observation: {
      available: attempts.filter((a) => existsSync(join(options.resultsDir, runId, a.id, "egress-denials.log"))).map((a) => a.id),
      unavailable: attempts.filter((a) => !existsSync(join(options.resultsDir, runId, a.id, "egress-denials.log"))).map((a) => a.id),
    },
    methodology,
  };
}

// ---------------------------------------------------------------------------
// Text renderer (consumes ONLY ReportJson)
// ---------------------------------------------------------------------------

function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

function renderLeaderboard(experiments: ReportExperiment[]): string[] {
  const header = ["experiment", "model", "pass (all/disc)", "agent median", "tokens in", "cost", "recall"];
  const rows = [...experiments].sort(compareLeaderboard).map((experiment) => {
    const agg = experiment.aggregate;
    const model = experiment.agent.model === "unspecified" ? "unpinned" : experiment.agent.model;
    const reasoning = experiment.agent.reasoning === "unspecified" ? "" : ` · ${experiment.agent.reasoning}`;
    if (!agg) return [experiment.experiment_id, `${model}${reasoning}`, "n/a", "n/a", "n/a", "n/a", "n/a"];
    const all = agg.pass_rate_all === null ? "n/a" : `${agg.passed}/${agg.passed + agg.failed}`;
    const disc = agg.pass_rate_discriminating === null ? "n/a" : `${agg.discriminating_passed}/${agg.discriminating_scored}`;
    const time = agg.median_agent_ms === null ? "n/a" : `${(agg.median_agent_ms / 1000).toFixed(1)}s (${agg.agent_time_attempts})`;
    const tokens = agg.mean_tokens_in === null ? "n/a" : `${Math.round(agg.mean_tokens_in)}`;
    const cost =
      (agg.cost_usd === null ? `not reported (0/${agg.attempts})` : `$${agg.cost_usd.toFixed(4)} ${agg.cost_attempts}/${agg.attempts} reported`) +
      (typeof agg.estimated_cost_usd === "number" ? ` +$${agg.estimated_cost_usd.toFixed(4)} est.` : "");
    const recall = experiment.sdk_recall;
    const recallText = recall && recall.rate !== null ? `${recall.recalled}/${recall.attempts}` : "n/a";
    const id = (experiment.role ?? "agent") === "agent" ? experiment.experiment_id : `${experiment.experiment_id} (control)`;
    return [id, `${model}${reasoning}`, `${all} · ${disc}`, time, tokens, cost, recallText];
  });
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i]!.length)));
  const format = (cells: string[]): string => `  ${cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()}`;
  return ["leaderboard (benchmark suite, sorted by discriminating pass rate; controls last):", format(header), ...rows.map(format)];
}

/** Render the report as plain text. Renders FROM the JSON, never the store. */
export function renderReportText(report: ReportJson): string {
  const lines: string[] = [];
  lines.push(`run ${report.run.id}`);
  lines.push(`  started:  ${report.run.started_at}`);
  if (report.incomplete) {
    lines.push(`  finished: INCOMPLETE — unfinished run or invalid trial coverage; treat every number below as partial`);
    for (const pair of report.coverage ?? []) {
      if (!pair.complete) lines.push(`    ${pair.eval_id} × ${pair.experiment_id}: ${pair.reasons.join("; ")}`);
    }
  } else {
    lines.push(`  finished: ${report.run.finished_at}`);
  }
  lines.push(`  manifest: ${report.run.manifest_hash}`);
  lines.push("");

  const experiments = report.experiments ?? [];
  if (experiments.length > 0) {
    lines.push("experiments:");
    for (const experiment of experiments) {
      const agent = experiment.agent;
      const model = agent.model === "unspecified" ? "model unpinned" : `model ${agent.model}`;
      const reasoning = agent.reasoning === "unspecified" ? "" : `, reasoning ${agent.reasoning}`;
      lines.push(
        `  ${experiment.experiment_id}${experiment.treatment !== null ? ` [${experiment.treatment}]` : ""}: ` +
          `${model}${reasoning} (adapter ${agent.adapter}, provider ${agent.provider}, cli ${agent.cli_version})`,
      );
      const recall = experiment.sdk_recall;
      lines.push(`    sdk recall: ${recall && recall.rate !== null ? `${recall.recalled}/${recall.attempts} (${pct(recall.rate)})` : "n/a"}`);
    }
    lines.push("");
    if (experiments.some((experiment) => experiment.aggregate !== undefined)) {
      lines.push(...renderLeaderboard(experiments), "");
    }
  }

  if (report.retry_history?.length) lines.push(`prior retry history: ${report.retry_history.length} unsuccessful executions retained in the source artifacts`);
  if (report.publication) {
    lines.push(`complete-sample publication: ${report.publication.eligible.length} eligible pair(s), ${report.publication.omitted.length} omitted; expected ${report.publication.expected_trials} trials`);
    lines.push(`source attempts: ${report.publication.source_totals.attempts}, including ${report.publication.source_totals.incomplete} incomplete and ${report.publication.source_totals.errors} errors`);
    for (const pair of report.publication.omitted) lines.push(`  omitted ${pair.eval_id} × ${pair.experiment_id}: ${pair.reasons.join("; ")}`);
  }
  const t = report.totals;
  lines.push(`attempts: ${t.attempts} — ${t.passed} passed, ${t.failed} failed, ${t.incomplete} incomplete, ${t.errors} errored`);
  const tel = report.telemetry;
  lines.push(
    `  cost:    ${tel.cost_usd === null ? "unavailable" : `$${tel.cost_usd.toFixed(4)} across ${tel.cost_attempts} attempt(s)`}`,
  );
  if (report.cost_estimate) {
    const estimate = report.cost_estimate;
    const cost = estimate.cost_usd;
    const displayed = cost === null ? "unavailable" : cost > 0 && cost < 0.0001 ? "<$0.0001" : `$${cost.toFixed(4)}`;
    lines.push(`  estimated token cost: ${displayed} (in addition to reported cost)`);
    lines.push(`    ${estimate.cost_attempts} estimated, ${estimate.unpriced_attempts} unpriced attempt(s); pricing ${estimate.pricing.version}`);
    for (const attempt of estimate.attempts) {
      if (attempt.unpriced_reason) lines.push(`    ${attempt.attempt_id}: ${attempt.unpriced_reason}`);
    }
  }
  lines.push(
    `  tokens:  ${
      tel.tokens_in === null && tel.tokens_out === null
        ? "unavailable"
        : `${tel.tokens_in ?? 0} in / ${tel.tokens_out ?? 0} out (from ${tel.token_attempts} attempt(s))`
    }`,
  );
  lines.push("");

  for (const pair of report.pairs) {
    lines.push(
      `${pair.eval_id} × ${pair.experiment_id}${pair.suite !== "benchmark" ? ` [${pair.suite}]` : ""}: ` +
        `${pct(pair.pass_rate)} pass rate (${pair.passed}/${pair.scored} scored` +
        `${pair.incomplete > 0 ? `, ${pair.incomplete} incomplete` : ""}` +
        `${pair.errors > 0 ? `, ${pair.errors} errored` : ""}` +
        `${pair.flaky ? ", trials disagreed" : ""})`,
    );
    const kEntries = displayPassAtK(pair.pass_at_k);
    if (kEntries.length > 0) {
      lines.push(
        `    pass@k / pass^k — ${kEntries.map((entry) => `k=${entry.k}: ${pct(entry.pass_at_k)} / ${pct(entry.pass_to_the_k)}`).join(", ")}`,
      );
    }
    for (const check of pair.checks) {
      lines.push(`    ${check.passed === check.total ? "PASS" : "FAIL"} ${check.name} (${check.passed}/${check.total})`);
    }
  }

  // Bands and suspects are absent on schema_version < 8 reports — skip them there.
  if (report.pairs.some((pair) => pair.band !== undefined)) {
    const bands = new Map(report.pairs.map((pair) => [pair.eval_id, pair.band]));
    const count = (band: EvalBand): number => [...bands.values()].filter((value) => value === band).length;
    lines.push(
      `bands: discriminating ${count("discriminating")} · solved by all ${count("solved-by-all")} · failed by all ${count("failed-by-all")}`,
    );
  }
  for (const suspect of report.scorer_health?.suspects ?? []) {
    lines.push(
      `suspect: ${suspect.eval_id} · ${suspect.check} failed in ${suspect.attempts} attempts under ` +
        `${suspect.experiments.length} arms; passing: ${suspect.passing_checks.join(", ")}`,
    );
  }

  if (report.groups.length > 0) {
    lines.push("");
    lines.push("comparison groups:");
    for (const group of report.groups) {
      if (group.comparison === "withheld") {
        lines.push(`  ${group.group}: WITHHELD — members differ beyond their declared treatment; raw results above still stand`);
        for (const detail of group.details) lines.push(`    ${detail}`);
        continue;
      }
      lines.push(`  ${group.group}: compared (raw counts per arm)`);
      for (const arm of group.arms) {
        const cells = arm.evals.map((entry) => `${entry.eval_id} ${entry.display}`).join(", ");
        const role = experiments.find((experiment) => experiment.experiment_id === arm.experiment_id)?.role ?? "agent";
        const control = role === "agent" ? "" : " (control)";
        lines.push(`    ${arm.experiment_id}${control}${arm.treatment !== null ? ` [${arm.treatment}]` : ""}: ${cells || "no scored attempts"}`);
      }
    }
  }

  if (report.usage.length > 0) {
    lines.push("");
    lines.push("surface usage (offered vs observed):");
    for (const usage of report.usage) {
      const channels = (["docs", "mcp", "cli"] as const)
        .map((channel) => `${channel} ${usage.channels[channel].events} event(s) in ${usage.channels[channel].attempts} attempt(s)`)
        .join(", ");
      lines.push(
        `  ${usage.experiment_id}${usage.treatment !== null ? ` [offered: ${usage.treatment}]` : ""}: ` +
          `${usage.telemetry_available} attempt(s) with telemetry` +
          `${usage.telemetry_unavailable > 0 ? `, ${usage.telemetry_unavailable} unavailable` : ""} — ${channels}`,
      );
    }
  }

  if (report.egress_denials.length > 0) {
    lines.push("");
    lines.push("egress denials:");
    for (const denial of report.egress_denials) {
      lines.push(
        `  ${denial.attempt_id} (${denial.eval_id} × ${denial.experiment_id}): ${denial.count} denial(s) — ` +
          denial.top_hosts.map(({ host, count }) => `${host} (${count})`).join(", "),
      );
    }
  }

  lines.push("");
  lines.push(`methodology: ${report.methodology}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// report.json plumbing
// ---------------------------------------------------------------------------

/** Canonical location of a run's report.json. */
export function reportJsonPath(resultsDir: string, runId: string): string {
  return join(resultsDir, runId, "report.json");
}

/** Write report.json into the run's results dir. Returns the path. */
export function writeReportJson(report: ReportJson, resultsDir: string): string {
  const dir = join(resultsDir, report.run.id);
  mkdirSync(dir, { recursive: true });
  const path = reportJsonPath(resultsDir, report.run.id);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

/** Load a previously written report.json, refusing other schema versions. */
export function readReportJson(resultsDir: string, runId: string): ReportJson {
  const path = reportJsonPath(resultsDir, runId);
  if (!existsSync(path)) {
    throw new ReportError(`no report.json for run "${runId}" (expected ${path}) — run \`quickstudy report ${runId}\` first`);
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReportJson>;
    if (parsed.schema_version !== REPORT_SCHEMA_VERSION) {
      throw new Error(
        `unsupported report schema ${String(parsed.schema_version ?? "legacy")} (expected ${REPORT_SCHEMA_VERSION})`,
      );
    }
    return parsed as ReportJson;
  } catch (err) {
    throw new ReportError(
      `report.json for run "${runId}" is not readable (${err instanceof Error ? err.message : String(err)}) — ` +
        `re-generate it with \`quickstudy report ${runId}\``,
    );
  }
}

function collectJudgeTelemetry(attempts: AttemptRecord[]): NonNullable<ReportJson["judge_telemetry"]> {
  const records = attempts.flatMap((a) => a.result?.judgments ?? a.judgeRecords ?? []);
  const sum = (key: "tokensIn" | "tokensOut" | "costUsd") => {
    const available = records.map((r) => r[key]).filter((v): v is number => v !== null);
    return available.length ? available.reduce((a, b) => a + b, 0) : null;
  };
  return { provenance: "semantic-judge", calls: records.length, tokens_in: sum("tokensIn"), tokens_out: sum("tokensOut"), cost_usd: sum("costUsd") };
}
