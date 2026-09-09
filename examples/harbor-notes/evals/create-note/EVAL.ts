import type { EvalScorer } from "quickstudy";
const score: EvalScorer = async (ctx) => {
  const expected = await ctx.query("expected-note") as { title: string; body: string };
  let saved: unknown;
  try { saved = JSON.parse(await ctx.readFile("note.json")); } catch { saved = null; }
  const document = saved as { title?: string; body?: string } | null;
  const live = await ctx.exec(["test", "-f", "note.json"]);
  const checks = [
    { name: "note-persisted", passed: document?.title === expected.title && document?.body === expected.body && live.exitCode === 0 },
    { name: "starting-state-preserved", passed: await ctx.fileExists("README.txt") },
  ];
  return { passed: checks.every((check) => check.passed), checks };
};
export default score;
