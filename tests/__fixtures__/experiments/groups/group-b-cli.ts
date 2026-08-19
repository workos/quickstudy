import { defineExperiment } from "quickstudy";

/** Group B, cli treatment: a second model pin, so the groups stay distinct. */
export default defineExperiment({
  id: "group-b-cli",
  comparisonGroup: "group-b",
  treatment: "cli",
  agent: {
    adapter: "echo",
    provider: "local",
    model: "echo-v2",
    reasoning: "none",
    cliVersion: "built-in",
  },
  runtime: { kind: "host" },
});
