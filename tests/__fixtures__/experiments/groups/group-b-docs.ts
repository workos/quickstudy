import { defineExperiment } from "quickstudy";

/** Group B, docs treatment: a second model pin, so the groups stay distinct. */
export default defineExperiment({
  id: "group-b-docs",
  comparisonGroup: "group-b",
  treatment: "docs",
  agent: {
    adapter: "echo",
    provider: "local",
    model: "echo-v2",
    reasoning: "none",
    cliVersion: "built-in",
  },
  runtime: { kind: "host" },
});
