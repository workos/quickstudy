/**
 * The v3 experiment vocabulary. An experiment is the full recipe for HOW an
 * attempt runs — agent, runtime, treatment — authored as a TypeScript module
 * whose default export is `defineExperiment({...})`. The returned object is
 * deep-frozen: experiment config is identity (it is hashed into the run
 * manifest), so nothing may mutate it after definition.
 */

import type { EvalMetadata } from "../evals/types.ts";
import { validateWorkspaceFilesRuntime, type WorkspaceFiles } from "../runtime/workspace-files.ts";
import type { SurfaceUsageConfig } from "../surface-usage.ts";
import type { RuntimeCapabilities } from "../runtime/types.ts";

/** A shared scarce resource: the scheduler lets at most `limit` attempts hold `key` at once. */
export interface RuntimeCapacity {
  key: string;
  limit: number;
}

/** Which agent executes the attempt, plus the identity fields recorded in the manifest. */
export interface AgentSpec {
  /** Adapter name, e.g. "echo" (the built-in no-op pipeline smoke agent). */
  adapter: string;
  provider?: string;
  model?: string;
  reasoning?: string;
  cliVersion?: string;
}

/**
 * Where — and with what treatment — the attempt executes. `host` runs the
 * adapter in a host scratch directory (no provisioning); `container` runs
 * inside `image` (or the image `containerImage(metadata)` resolves per eval)
 * with the standard per-attempt container lifecycle.
 *
 * The optional capability methods (runtime/types.ts) own everything the
 * environment offers the agent and the scorer: provisioning, egress hosts,
 * MCP servers, web policy, PATH treatment, scorer capabilities. Capability
 * FUNCTIONS never contribute to identity — the manifest hashes only the
 * plain-data fields, so identity-bearing runtime state belongs in `config`.
 */
export interface Runtime extends RuntimeCapabilities {
  kind: "host" | "container";
  /** Shared observation targets, independent of which surfaces this arm offers. */
  observationTargets?: SurfaceUsageConfig;
  /**
   * Shared scarce resource pool; the scheduler waits instead of starting
   * doomed jobs. A resolver decides per eval, so an eval that consumes no
   * pooled resource can answer `undefined` and never hold a slot. The static
   * form is identity; a resolver, like every capability function, is not.
   */
  capacity?: RuntimeCapacity | ((metadata: EvalMetadata) => RuntimeCapacity | undefined);
  /** Explicit environment fields the declared treatment may vary in a comparison.
   * Images and lifecycle budgets can never be exempted. All group members must
   * declare the same fields. Source/config identity still changes per attempt.
   */
  treatmentPolicyFields?: Array<"egress" | "webPolicy" | "pathTreatment" | "mcp" | "promptPreamble" | "workspaceFiles">;
  /** Attempt-local non-secret files, staged without replacing the normal adapter. */
  workspaceFiles?: WorkspaceFiles;
  /** Container image tag (container runtimes; alternative to `containerImage`). */
  image?: string;
  /** Scripted command run in /workspace (container runtimes, this phase). */
  command?: string[];
  /** Free-form runtime configuration; hashed into the experiment's identity. */
  config?: Record<string, unknown>;
}

export interface Experiment {
  id: string;
  agent: AgentSpec;
  runtime: Runtime;
  /**
   * Experiments sharing a `comparisonGroup` are compared as treatments of
   * one configuration; a group whose members disagree on anything beyond
   * the declared treatment has automatic comparison withheld (never blocked).
   */
  comparisonGroup?: string;
  /**
   * What this experiment varies. An opaque string, compared only within a
   * comparison group — never an enum in harness code. By convention the
   * treatment's own runtime configuration lives at `runtime.config[treatment]`,
   * which is what the group comparison excludes.
   */
  treatment?: string;
}

/** An experiment plus the module path that default-exported it. */
export interface LoadedExperiment {
  experiment: Experiment;
  /** Absolute path of the defining module (hashed into the manifest). */
  path: string;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate and freeze an experiment definition. The identity-frozen object is
 * what discovery hands to the planner and the manifest hasher.
 */
export function defineExperiment(experiment: Experiment): Experiment {
  if (typeof experiment.id !== "string" || experiment.id.trim() === "") {
    throw new Error("defineExperiment: id must be a non-empty string");
  }
  if (typeof experiment.agent?.adapter !== "string" || experiment.agent.adapter.trim() === "") {
    throw new Error(`defineExperiment: experiment "${experiment.id}" needs agent.adapter`);
  }
  const kind = experiment.runtime?.kind;
  if (kind !== "host" && kind !== "container") {
    throw new Error(`defineExperiment: experiment "${experiment.id}" runtime.kind must be "host" or "container"`);
  }
  if (
    kind === "container" &&
    (typeof experiment.runtime.image !== "string" || experiment.runtime.image === "") &&
    typeof experiment.runtime.containerImage !== "function"
  ) {
    throw new Error(
      `defineExperiment: experiment "${experiment.id}" container runtime needs an image ` +
        `(or a containerImage(metadata) resolver)`,
    );
  }
  if (experiment.comparisonGroup !== undefined && experiment.comparisonGroup.trim() === "") {
    throw new Error(`defineExperiment: experiment "${experiment.id}" comparisonGroup must not be empty`);
  }
  validateWorkspaceFilesRuntime(experiment.runtime);
  return deepFreeze(experiment);
}
