import { defineExperiment } from "quickstudy";

/** Oracle agent, host runtime: applies each eval's solution/ and scores it. */
export default defineExperiment({
  id: "oracle-local",
  agent: {
    adapter: "oracle",
    provider: "local",
    model: "oracle-v1",
    reasoning: "none",
    cliVersion: "built-in",
  },
  runtime: { kind: "host" },
  treatment: "baseline",
});
