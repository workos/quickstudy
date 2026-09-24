import type { CheckResult, EvalContext, EvalResult } from "quickstudy";

/** Per-framework scorer: the framework's starting state survives and NOTES.md exists. */
export default async function score(ctx: EvalContext): Promise<EvalResult> {
  const readme = (await ctx.fileExists("README.md")) ? await ctx.readFile("README.md") : "";
  const checks: CheckResult[] = [
    { name: "local-state-preserved", passed: readme.includes(`${ctx.framework} starting state`) },
    { name: "notes-written", passed: await ctx.fileExists("NOTES.md") },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}
