/**
 * 148074667 → "148.1M", 2200000 → "2.2M", 512000 → "512k", 40900 → "40.9k", 512 → "512";
 * null → "—" (unavailable, never 0). A whole-number k/M drops its ".0".
 */
export function fmtTokens(tokens: number | null): string {
  if (tokens === null) return "—";
  const short = (value: number): string => value.toFixed(1).replace(/\.0$/, "");
  if (tokens >= 1_000_000) return `${short(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${short(tokens / 1000)}k`;
  return String(Math.round(tokens));
}

/** 411000 → "6m 51s", 59000 → "59s", 3720000 → "62m 0s"; null → "—". */
export function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** 1.987 → "$1.99", 0.004 → "<$0.01", 0 → "$0.00"; null → "—". */
export function fmtUsd(usd: number | null): string {
  if (usd === null) return "—";
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/**
 * The specific reason a run is incomplete — "5 attempts timed out; 1 errored" — in
 * place of the generic "unfinished run or missing trial coverage" when the counts are
 * known. `timedOut` refines `incomplete` where the attempt errors are available (matrix).
 */
export function incompleteReason(input: { unfinished: boolean; incomplete: number; errors: number; timedOut?: number }): string {
  const timedOut = input.timedOut ?? 0;
  const otherIncomplete = input.incomplete - timedOut;
  const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const parts = [
    input.unfinished ? "the run never finished" : "",
    timedOut > 0 ? `${n(timedOut, "attempt")} timed out` : "",
    otherIncomplete > 0 ? `${n(otherIncomplete, "attempt")} incomplete` : "",
    input.errors > 0 ? `${n(input.errors, "attempt")} errored` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : "missing trial coverage";
}
