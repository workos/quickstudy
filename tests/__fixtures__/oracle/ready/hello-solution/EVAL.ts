import type { CheckResult, EvalContext, EvalResult } from "quickstudy";

/** Inline fileContains-style check (shared check helpers arrive in a later phase). */
async function fileContains(ctx: EvalContext, path: string, needle: string, name: string): Promise<CheckResult> {
  if (!(await ctx.fileExists(path))) {
    return { name, passed: false, notes: `${path} does not exist` };
  }
  const content = await ctx.readFile(path);
  return {
    name,
    passed: content.includes(needle),
    ...(content.includes(needle) ? { evidence: [{ path }] } : { notes: `${path} does not contain ${JSON.stringify(needle)}` }),
  };
}

export default async function score(ctx: EvalContext): Promise<EvalResult> {
  const checks: CheckResult[] = [
    await fileContains(ctx, "README.md", "hello-local starting state", "local-state-preserved"),
    await fileContains(ctx, "NOTES.md", "Notes", "notes-written"),
  ];
  return { passed: checks.every((check) => check.passed), checks };
}
