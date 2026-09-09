import { defineExperiment } from "quickstudy";
import { harborRuntime } from "../runtime.ts";
export default defineExperiment({
  id: "scripted", agent: { adapter: "scripted", provider: "local", model: "script-v1", reasoning: "none", cliVersion: "built-in" },
  runtime: harborRuntime(),
});
