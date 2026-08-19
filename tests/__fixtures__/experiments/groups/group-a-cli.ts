import { defineExperiment } from "quickstudy";

/** Group A, cli treatment: identical identity to its group-mates except the treatment. */
export default defineExperiment({
  id: "group-a-cli",
  comparisonGroup: "group-a",
  treatment: "cli",
  agent: {
    adapter: "echo",
    provider: "local",
    model: "echo-v1",
    reasoning: "none",
    cliVersion: "built-in",
  },
  runtime: { kind: "host" },
});
