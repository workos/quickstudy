import { defineExperiment } from "quickstudy";

/** Group A, mcp treatment: identical identity to its group-mates except the treatment. */
export default defineExperiment({
  id: "group-a-mcp",
  comparisonGroup: "group-a",
  treatment: "mcp",
  agent: {
    adapter: "echo",
    provider: "local",
    model: "echo-v1",
    reasoning: "none",
    cliVersion: "built-in",
  },
  runtime: { kind: "host" },
});
