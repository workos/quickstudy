import type { EvalResult } from "./types.ts";
export function validEvalResult(value: unknown): value is EvalResult {
  if (!value || typeof value !== "object") return false;
  const result = value as EvalResult;
  if (typeof result.passed !== "boolean" || !Array.isArray(result.checks)) return false;
  if (result.checks.some((c) => !c || typeof c.name !== "string" || c.name === "" || typeof c.passed !== "boolean")) return false;
  if (new Set(result.checks.map((c) => c.name)).size !== result.checks.length) return false;
  return result.judgments === undefined || (Array.isArray(result.judgments) && result.judgments.every((j) => j && typeof j === "object" && j.provenance === "semantic-judge" &&
    typeof j.provider === "string" && typeof j.model === "string" && [j.tokensIn, j.tokensOut, j.costUsd].every((v) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0))));
}
