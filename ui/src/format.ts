/** 148074667 → "148.1M", 4172900 → "4.2M", 40900 → "40.9k", 512 → "512"; null → "—" (unavailable, never 0). */
export function fmtTokens(tokens: number | null): string {
  if (tokens === null) return "—";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
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
