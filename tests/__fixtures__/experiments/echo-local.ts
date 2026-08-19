import { defineExperiment } from "quickstudy";

/** Echo agent, null runtime: no provisioning, host workspace. */
export default defineExperiment({
  id: "echo-local",
  agent: {
    adapter: "echo",
    provider: "local",
    model: "echo-v1",
    reasoning: "none",
    cliVersion: "built-in",
  },
  runtime: { kind: "host" },
  treatment: "baseline",
});
