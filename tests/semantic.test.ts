import { expect, test } from "bun:test";
import { defineSemanticScorer } from "../src/semantic.ts";
import type { EvalContext } from "../src/evals/types.ts";
const ctx: EvalContext = {
  evalId: "semantic",
  experimentId: "fake",
  trialIndex: 0,
  workspaceDir: "/unused",
  fileExists: async () => true,
  readFile: async () => "A working explanation.",
  exec: async () => {
    throw new Error("unused");
  },
  query: async () => null,
  getClient: () => null,
  agentOutput: { finalReport: "The task is complete.", transcript: null, truncated: false },
  redact: async (text) => text.replaceAll("private-value", "[REDACTED]"),
};
const rubric = {
  name: "useful-explanation",
  rubric: "The explanation describes what was changed and why.",
  provider: "fake",
  model: "fake-v1",
  includeFinalReport: true,
};
for (const passed of [true, false])
  test(`fake judge ${passed ? "positive" : "negative"} rubric fixture`, async () => {
    const scorer = defineSemanticScorer(rubric, async (request) => {
      expect(request.evidence[0]!.ref).toBe("agent:final-report");
      return {
        verdict: { passed, reason: "rubric assessed", evidence: ["agent:final-report"] },
        usage: { tokensIn: 10, tokensOut: 5, costUsd: 0 },
      };
    });
    const result = await scorer(ctx);
    expect(result.passed).toBe(passed);
    expect(result.judgments![0]!).toMatchObject({ provenance: "semantic-judge", costUsd: 0, tokensIn: 10 });
    expect(scorer.identity).toMatchObject({ semanticVersion: 1, model: "fake-v1", rubric: rubric.rubric });
  });

test("construction never calls the judge and missing usage remains unavailable", async () => {
  let calls = 0;
  const scorer = defineSemanticScorer(rubric, async () => {
    calls++;
    return { verdict: { passed: true, reason: "ok", evidence: ["agent:final-report"] } };
  });
  expect(calls).toBe(0);
  expect((await scorer(ctx)).judgments![0]!.costUsd).toBeNull();
  expect(calls).toBe(1);
});
for (const verdict of [
  null,
  "yes",
  { passed: "true" },
  { passed: true, reason: "ok", evidence: [] },
  { passed: true, reason: "ok", evidence: ["invented-file"] },
])
  test(`malformed verdict rejected: ${JSON.stringify(verdict)}`, async () => {
    await expect(defineSemanticScorer(rubric, async () => ({ verdict }))(ctx)).rejects.toThrow("malformed");
  });
test("judge timeout cancels underlying work and provider errors stay instrument errors", async () => {
  let cancelled = false;
  const hung = defineSemanticScorer({ ...rubric, timeoutMs: 10 }, async (_, options) => {
    options.signal.addEventListener("abort", () => {
      cancelled = true;
    });
    return new Promise(() => {});
  });
  await expect(hung(ctx)).rejects.toThrow("timed out");
  expect(cancelled).toBe(true);
  await expect(
    defineSemanticScorer(rubric, async () => {
      throw new Error("provider private-value failed");
    })(ctx),
  ).rejects.toThrow("provider [REDACTED] failed");
});
test("evidence is bounded and redacted, budget violations do not become agent failures", async () => {
  const context = { ...ctx, agentOutput: { ...ctx.agentOutput!, finalReport: "private-value " + "x".repeat(5000) } };
  const scorer = defineSemanticScorer({ ...rubric, maxEvidenceBytes: 100 }, async (request) => {
    expect(Buffer.byteLength(request.evidence[0]!.text)).toBeLessThanOrEqual(100);
    expect(request.evidence[0]!.text).not.toContain("private-value");
    return { verdict: { passed: true, reason: "ok", evidence: ["agent:final-report"] }, usage: { tokensOut: 10000 } };
  });
  await expect(scorer(context)).rejects.toThrow("token budget");
});
