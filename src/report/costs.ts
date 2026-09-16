import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseCodexCostUsage, type CodexCostUsage } from "../adapters/parse.ts";
import { hashString } from "../hash.ts";
import type { AttemptRecord, RunRecord } from "../store/db.ts";

const rateSchema = z.object({
  provider: z.literal("openai"),
  model: z.string().min(1),
  effective_from: z.iso.datetime({ offset: true }),
  effective_until: z.iso.datetime({ offset: true }).optional(),
  source: z.url({ protocol: /^https?$/ }),
  input_usd_per_million: z.number().finite().nonnegative(),
  cached_input_usd_per_million: z.number().finite().nonnegative(),
  output_usd_per_million: z.number().finite().nonnegative(),
}).strict();
const pricingSchema = z.object({
  version: z.string().min(1), currency: z.literal("USD"), rates: z.array(rateSchema).min(1),
}).strict();
export type Pricing = z.infer<typeof pricingSchema>;
type Rate = Pricing["rates"][number];

export class PricingError extends Error {
  constructor(message: string) { super(message); this.name = "PricingError"; }
}

/** Reject ambiguous schedules rather than silently selecting one matching price. */
export function parsePricing(value: unknown): Pricing {
  const result = pricingSchema.safeParse(value);
  if (!result.success) throw new PricingError(`invalid pricing: ${result.error.message}`);
  const pricing = result.data;
  const ends = new Map<string, number>();
  for (const rate of [...pricing.rates].sort((a, b) => Date.parse(a.effective_from) - Date.parse(b.effective_from))) {
    const start = Date.parse(rate.effective_from);
    const end = rate.effective_until === undefined ? Infinity : Date.parse(rate.effective_until);
    if (end <= start) throw new PricingError(`invalid pricing: ${rate.model} effective_until must follow effective_from`);
    const key = `${rate.provider}:${rate.model}`;
    if ((ends.get(key) ?? -Infinity) > start) throw new PricingError(`invalid pricing: overlapping rates for ${rate.model}`);
    ends.set(key, end);
  }
  return pricing;
}

export function readPricing(path: string): Pricing {
  try { return parsePricing(JSON.parse(readFileSync(path, "utf8"))); }
  catch (err) {
    throw new PricingError(`pricing file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface AttemptCostEstimate {
  attempt_id: string;
  cost_usd: number | null;
  unpriced_reason?: "unsupported_adapter" | "pricing_unavailable" | "transcript_unreadable" | "usage_unavailable" | "invalid_cost";
  usage?: CodexCostUsage;
  transcript_sha256?: string;
  rate_index?: number;
}

/** Estimates supplement, never replace, telemetry.cost_usd and its reported-attempt count. */
export interface RunCostEstimate {
  pricing: Pricing;
  cost_usd: number | null;
  cost_attempts: number;
  unpriced_attempts: number;
  /** Only attempts without a provider-reported cost. All values are agent token costs, not invoices. */
  attempts: AttemptCostEstimate[];
}

function readTranscript(resultsDir: string, runId: string, attempt: AttemptRecord): string {
  // Prefer the restored artifacts tree to the original machine's absolute reference.
  const canonical = join(resultsDir, runId, attempt.id, "transcript.jsonl");
  try { return readFileSync(canonical, "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !attempt.transcriptRef || attempt.transcriptRef === canonical) throw err;
    return readFileSync(attempt.transcriptRef, "utf8");
  }
}

function estimateAttempt(run: RunRecord, attempt: AttemptRecord, resultsDir: string, pricing: Pricing): AttemptCostEstimate {
  const unavailable = (unpriced_reason: NonNullable<AttemptCostEstimate["unpriced_reason"]>): AttemptCostEstimate =>
    ({ attempt_id: attempt.id, cost_usd: null, unpriced_reason });
  const agent = run.manifest.experiments[attempt.experimentId]?.components.agent;
  if (agent?.adapter !== "codex" || agent.provider !== "openai") return unavailable("unsupported_adapter");
  const at = attempt.startedAt ?? run.startedAt;
  const rateIndex = pricing.rates.findIndex((rate) => rate.provider === agent.provider && rate.model === agent.model &&
    at >= Date.parse(rate.effective_from) && (rate.effective_until === undefined || at < Date.parse(rate.effective_until)));
  const rate = pricing.rates[rateIndex];
  if (rate === undefined) return unavailable("pricing_unavailable");
  let raw: string;
  try { raw = readTranscript(resultsDir, run.id, attempt); }
  catch { return unavailable("transcript_unreadable"); }
  const usage = parseCodexCostUsage(raw);
  if (usage === null) return { ...unavailable("usage_unavailable"), transcript_sha256: hashString(raw) };
  const cost = tokenCost(usage, rate);
  if (!Number.isFinite(cost)) return unavailable("invalid_cost");
  return { attempt_id: attempt.id, cost_usd: cost, usage, transcript_sha256: hashString(raw), rate_index: rateIndex };
}

function tokenCost(usage: CodexCostUsage, rate: Rate): number {
  return ((usage.input_tokens - usage.cached_input_tokens) * rate.input_usd_per_million +
    usage.cached_input_tokens * rate.cached_input_usd_per_million +
    usage.output_tokens * rate.output_usd_per_million) / 1_000_000;
}

/** Uses the report's selected attempts (excluding superseded retries and publication omissions). */
export function estimateRunCosts(run: RunRecord, attempts: AttemptRecord[], resultsDir: string, input: Pricing): RunCostEstimate {
  const pricing = parsePricing(input);
  const estimates = attempts.filter((a) => a.costUsd === null).map((a) => estimateAttempt(run, a, resultsDir, pricing));
  const costs = estimates.flatMap((a) => a.cost_usd === null ? [] : [a.cost_usd]);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (!Number.isFinite(total)) throw new PricingError("estimated token cost exceeds the supported numeric range");
  return { pricing, cost_usd: costs.length ? total : null, cost_attempts: costs.length,
    unpriced_attempts: estimates.length - costs.length, attempts: estimates };
}
