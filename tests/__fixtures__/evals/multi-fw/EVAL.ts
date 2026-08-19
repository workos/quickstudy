import type { CheckResult, EvalContext, EvalResult } from "quickstudy";

/**
 * One scorer for every framework variant: the starting state is per-framework
 * (`local/<framework>/start.txt` names its stack), and `ctx.framework` says
 * which variant is being scored.
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
