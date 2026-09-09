import { defineSemanticScorer } from "quickstudy";

/** Local demonstration only: the fake judge has no network or credential dependency. */
export const semanticExample = defineSemanticScorer(
  {
    name: "explains-note",
    rubric: "The final report explains the saved note's title and body.",
    provider: "local-fake",
    model: "rubric-fixture-v1",
    includeFinalReport: true,
  },
  async (request) => ({
    verdict: {
      passed: request.evidence.some(
        (entry) => entry.text.includes("First note") && entry.text.includes("Hello from Harbor"),
      ),
      reason: "Local fixture matches the rubric vocabulary; calibrate a real judge separately.",
      evidence: ["agent:final-report"],
    },
  }),
);
