import type { CheckResult } from "../../src/evals/types.ts";

/** Absent = graded; only an explicit `graded: false` marks a recorded-but-ungraded check. */
export const isGraded = (check: Pick<CheckResult, "graded">): boolean => check.graded !== false;

/** Pass/total over graded checks only — ungraded checks never enter the "x/y checks" count. */
export function countGradedChecks(checks: CheckResult[] | null): { passed: number; total: number } {
  const graded = (checks ?? []).filter(isGraded);
  return { passed: graded.filter((check) => check.passed).length, total: graded.length };
}

/** Tooltip for the ungraded tag, shared by every check list. */
export const UNGRADED_TITLE = "Recorded, not graded: never enters pass/fail";

/** Text for the recorded tag: `recorded`, or `recorded · wiring` when the check carries a kind. */
export const recordedLabel = (check: { kind?: string | null | undefined }): string =>
  check.kind ? `recorded · ${check.kind}` : "recorded";
