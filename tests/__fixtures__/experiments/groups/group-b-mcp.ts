import { defineExperiment } from "quickstudy";

/** Group B, mcp treatment: a second model pin, so the groups stay distinct. */
export default defineExperiment({
  id: "group-b-mcp",
  comparisonGroup: "group-b",
  treatment: "mcp",
  agent: {
    adapter: "echo",
    provider: "local",
    model: "echo-v2",
    reasoning: "none",
    cliVersion: "built-in",
  },
  runtime: { kind: "host" },
});
