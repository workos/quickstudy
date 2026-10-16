/**
 * The package's public entry point (`exports["."]` in package.json).
 *
 * The v3 authoring API: what an EVAL.ts scorer and an experiment module
 * import from "quickstudy".
 */

export type {
  CheckResult,
  EvalContext,
  EvalExecResult,
  EvalMetadata,
  EvalResult,
  EvalScorer,
  EvalSuite,
  EvidenceReference,
  LoadedEval,
} from "./evals/types.ts";
export { EVAL_SUITES } from "./evals/types.ts";
export { defineExperiment } from "./experiments/types.ts";
export type { AgentSpec, Experiment, LoadedExperiment, Runtime, RuntimeCapacity } from "./experiments/types.ts";
export type {
  ProvisionedEnvironment,
  RuntimeCapabilities,
  RuntimeProvisionContext,
  ScorerCapabilities,
  ScorerCapabilityContext,
  WebPolicy,
} from "./runtime/types.ts";
export type { McpServerAuthConfig, McpServerConfig } from "./isolation/mcp.ts";
export { compareGroups } from "./experiments/groups.ts";
export type { ComparisonGroup } from "./experiments/groups.ts";

// Probe scaffolding: app boot, readiness, Playwright invocation, and probe
// utilities consumed by scorer libraries. Exported so consumer scorers import
// the harness by package name, never by relative path into src/.
export {
  buildStartScript,
  deepJsonEqual,
  deliverSpecSource,
  evaluateAssertions,
  fetchViaExec,
  readAppLogTail,
  runPlaywrightSpec,
  startAppInBackground,
  stopBackgroundApp,
  truncateOutput,
  waitForAppReady,
} from "./probe.ts";
export type { JsonAssertion, ProbeExecFn } from "./probe.ts";

export type { SurfaceUsageConfig, SurfaceUsage } from "./surface-usage.ts";

export { defineSemanticScorer, SemanticScoringError } from "./semantic.ts";
export type { SemanticRubric, SemanticJudge, SemanticJudgeRequest, SemanticJudgeResponse } from "./semantic.ts";
export type { AgentOutput, JudgeRecord } from "./evals/types.ts";

export { extractSurfaceUsage, surfaceUsageConfigFromRuntime, observationConfig } from "./surface-usage.ts";
