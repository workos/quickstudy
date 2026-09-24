import type { CheckResult, EvalContext, EvalResult } from "quickstudy";

/** A scorer whose build check needs a runtime: `ctx.exec` defers under validate --oracle. */
export default async function score(ctx: EvalContext): Promise<EvalResult> {
  const notes = (await ctx.fileExists("NOTES.md")) ? await ctx.readFile("NOTES.md") : "";
  const checks: CheckResult[] = [{ name: "notes-written", passed: notes.includes("Notes") }];
  try {
    const build = await ctx.exec(["true"]);
    checks.push({ name: "build-passes", passed: build.exitCode === 0 });
  } catch (err) {
    checks.push({ name: "build-passes", passed: false, notes: err instanceof Error ? err.message : String(err) });
  }
  return { passed: checks.every((check) => check.passed), checks };
}
