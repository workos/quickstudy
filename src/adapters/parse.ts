/**
 * Shared parsers for the agents' headless output streams, reducing each raw
 * JSONL stream to telemetry: {tokensIn, tokensOut, turns, costUsd}.
 *
 * Tolerance is the design constraint: vendor CLIs drift between releases
 * (versions are pinned in images/agent-runtime/Dockerfile, and these parsers
 * are tested against checked-in fixture streams), so a malformed or
 * unrecognized stream must degrade gracefully — never a crash, and never a
 * lost transcript (the raw stream is persisted before parsing).
 *
 * Degradation records NULL token counts, not zeros: a stream that carried no
 * usage data is "telemetry unavailable", and zeros would poison cost stats
 * (the store's telemetry columns are nullable for exactly this). Turns stay
 * numeric — visible turns are countable even from a truncated stream.
 */

import type { AttemptMetrics } from "./types.ts";

/** Parse a JSONL stream leniently: non-JSON lines are skipped, never fatal. */
export function parseJsonlLines(raw: string): unknown[] {
  const objects: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;
    try {
      objects.push(JSON.parse(trimmed));
    } catch {
      // Tolerated: agents interleave non-JSON noise (progress bars, warnings).
    }
  }
  return objects;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A token field that is absent is "unavailable" (null) — never coerced to 0. */
function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Claude Code `--output-format stream-json`: one JSON event per line, ending
 * (on success) with a `type: "result"` event that carries authoritative
 * usage, num_turns, and total_cost_usd. Cache reads/writes count as input —
 * they are billed tokens the attempt consumed. A stream that died before its
 * result event has no usage data: token counts degrade to null.
 */
export function parseClaudeStream(raw: string): AttemptMetrics {
  const metrics: AttemptMetrics = { tokensIn: null, tokensOut: null, turns: 0 };
  let assistantEvents = 0;
  for (const event of parseJsonlLines(raw)) {
    const obj = record(event);
    if (obj["type"] === "assistant") assistantEvents += 1;
    if (obj["type"] !== "result") continue;
    const usage = record(obj["usage"]);
    metrics.tokensIn =
      num(usage["input_tokens"]) + num(usage["cache_creation_input_tokens"]) + num(usage["cache_read_input_tokens"]);
    metrics.tokensOut = num(usage["output_tokens"]);
    metrics.turns = num(obj["num_turns"]);
    const cost = obj["total_cost_usd"];
    if (typeof cost === "number" && Number.isFinite(cost)) metrics.costUsd = cost;
  }
  // A stream that died before its result event still counts visible turns.
  if (metrics.turns === 0) metrics.turns = assistantEvents;
  return metrics;
}

/**
 * Codex `exec --json`: one JSON event per line. Two shapes exist across
 * pinned-version history, and both are handled:
 *   - thread events: `{"type":"turn.completed","usage":{...}}` per turn;
 *   - legacy protocol events: `{"msg":{"type":"token_count",...}}` with
 *     cumulative totals (last one wins) and `agent_message` turns.
 *
 * Unlike Anthropic usage (where cache tokens are separate counters), OpenAI
 * usage reports `input_tokens` as the total with cached tokens as a SUBSET —
 * adding `cached_input_tokens` on top would double-count. A stream with no
 * usage events at all degrades to null token counts.
 */
export function parseCodexStream(raw: string): AttemptMetrics {
  const metrics: AttemptMetrics = { tokensIn: null, tokensOut: null, turns: 0 };
  let legacyTurns = 0;
  for (const event of parseJsonlLines(raw)) {
    const obj = record(event);

    if (obj["type"] === "turn.completed") {
      const usage = record(obj["usage"]);
      const input = numOrNull(usage["input_tokens"]);
      const output = numOrNull(usage["output_tokens"]);
      if (input !== null) metrics.tokensIn = (metrics.tokensIn ?? 0) + input;
      if (output !== null) metrics.tokensOut = (metrics.tokensOut ?? 0) + output;
      metrics.turns += 1;
      continue;
    }

    const msg = record(obj["msg"]);
    if (msg["type"] === "agent_message") legacyTurns += 1;
    if (msg["type"] === "token_count") {
      // Cumulative totals: the last token_count event is authoritative.
      const info = record(msg["info"]);
      const total = record(info["total_token_usage"]);
      const tokensIn = num(total["input_tokens"]) || num(msg["input_tokens"]);
      const tokensOut = num(total["output_tokens"]) || num(msg["output_tokens"]);
      if (tokensIn > 0) metrics.tokensIn = tokensIn;
      if (tokensOut > 0) metrics.tokensOut = tokensOut;
    }
  }
  if (metrics.turns === 0) metrics.turns = legacyTurns;
  return metrics;
}

/** Pricing needs complete usage, including the cache subset; partial telemetry cannot be priced. */
export interface CodexCostUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

function costUsage(value: unknown): CodexCostUsage | null {
  const usage = record(value);
  const input = usage["input_tokens"], cached = usage["cached_input_tokens"], output = usage["output_tokens"];
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!count(input) || !count(cached) || !count(output) || cached > input) return null;
  const reasoning = usage["reasoning_output_tokens"];
  if (reasoning !== undefined && (!count(reasoning) || reasoning > output)) return null;
  // The three-rate model does not cover separately billed cache writes.
  if (usage["cache_write_input_tokens"] !== undefined && usage["cache_write_input_tokens"] !== 0) return null;
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output };
}

/** Strict counterpart to parseCodexStream: malformed/truncated usage stays unpriced. */
export function parseCodexCostUsage(raw: string): CodexCostUsage | null {
  let total: CodexCostUsage | null = null;
  let complete = false;
  let dialect: "thread" | "legacy" | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try { obj = record(JSON.parse(line)); } catch { return null; }
    const msg = record(obj["msg"]);
    const type = obj["type"] ?? msg["type"];
    if (type === "turn.failed" || type === "error") return null;
    if (type === "turn.started" || type === "task_started") complete = false;
    if (type === "task_complete" && dialect === "legacy") complete = true;
    if (type !== "turn.completed" && type !== "token_count") continue;
    const nextDialect = type === "turn.completed" ? "thread" : "legacy";
    if (dialect !== undefined && dialect !== nextDialect) return null;
    dialect = nextDialect;
    const usage = costUsage(dialect === "thread" ? obj["usage"] : record(msg["info"])["total_token_usage"]);
    if (usage === null) return null;
    if (dialect === "legacy") {
      total = usage; // Cumulative: never sum token_count snapshots.
      complete = false;
    } else {
      total = total === null ? usage : {
        input_tokens: total.input_tokens + usage.input_tokens,
        cached_input_tokens: total.cached_input_tokens + usage.cached_input_tokens,
        output_tokens: total.output_tokens + usage.output_tokens,
      };
      complete = true;
    }
  }
  return complete && total !== null ? costUsage(total) : null;
}

