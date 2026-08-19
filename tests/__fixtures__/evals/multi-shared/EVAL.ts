import type { CheckResult, EvalContext, EvalResult } from "quickstudy";

/**
 * Same scorer shape as multi-fw, but the starting state lives in a shared
 * fixture root (`local: ../shared-fixtures`) — each variant is copied from
 * `shared-fixtures/<framework>/`.
 */
export default async function score(ctx: EvalContext): Promise<EvalResult> {
  const checks: CheckResult[] = [];
  const hasStart = await ctx.fileExists("start.txt");
  checks.push({
    name: "framework-state-copied",
    passed: hasStart && ctx.framework !== undefined && (await ctx.readFile("start.txt")).includes(ctx.framework),
    ...(hasStart ? {} : { notes: "start.txt does not exist" }),
  });
  checks.push({ name: "notes-written", passed: await ctx.fileExists("NOTES.md") });
  return { passed: checks.every((check) => check.passed), checks };
}
