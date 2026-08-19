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

/** Inline existence check. */
async function fileExists(ctx: EvalContext, path: string, name: string): Promise<CheckResult> {
  const exists = await ctx.fileExists(path);
  return { name, passed: exists, ...(exists ? { evidence: [{ path }] } : { notes: `${path} does not exist` }) };
}

/**
 * The treatment-runtime diagonal scorer. On an unmodified starting state the
 * local/-delivery checks (starting_state_delivered, seed_untampered) pass and
 * the checks that need agent work (settings_configured, notes_written) fail —
 * honest failures with notes, never a throw.
 */
export default async function score(ctx: EvalContext): Promise<EvalResult> {
  const checks: CheckResult[] = [
    await fileContains(ctx, "seed.txt", "treatment-fixture starting state", "starting_state_delivered"),
    await fileContains(ctx, "settings.json", '"configured": true', "settings_configured"),
    await fileExists(ctx, "NOTES.md", "notes_written"),
    await fileContains(ctx, "settings.json", '"app": "treatment-fixture"', "seed_untampered"),
  ];
  return { passed: checks.every((check) => check.passed), checks };
}
