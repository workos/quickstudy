/**
 * The v3 runtime capability surface: everything the environment offers the
 * agent and the scorer — per-attempt provisioning, container image selection,
 * egress policy, MCP configuration, native-web policy, CLI availability, and
 * scorer capabilities — declared as optional methods on the experiment's
 * runtime instead of scattered per-surface special cases.
 *
 * Identity note: these are FUNCTIONS, and the manifest hashes the runtime as
 * plain data (`{kind, image, command, config}` via canonical JSON, which
 * drops functions). Anything identity-bearing a capability closes over MUST
 * also appear in `Runtime.config` — the harness cannot see inside a closure.
 */

import type { EvalMetadata } from "../evals/types.ts";
import type { McpServerConfig } from "../isolation/mcp.ts";

/** What a runtime's `provision` receives, per attempt. */
export interface RuntimeProvisionContext {
  attemptId: string;
  evalId: string;
  /** The eval's frontmatter metadata (`product`/`framework` drive provisioning). */
  metadata: EvalMetadata;
}

/** What one provisioned attempt gets. `env` values are secrets — never log. */
export interface ProvisionedEnvironment {
  /** Env vars delivered to the attempt container via the 0600 env-file, never argv. */
  env?: Record<string, string>;
  /** Credential identifier for teardown/leak accounting — never the secret itself. */
  credentialRef?: string;
  /**
   * Scrub what provision created. Failures are recorded explicitly on the
   * attempt, never silently swallowed, and never crash the run.
   */
  teardown?(): Promise<void>;
}

/** What `scorerCapabilities` receives when the runner builds the scorer's context. */
export interface ScorerCapabilityContext {
  attemptId: string;
  evalId: string;
  experimentId: string;
  metadata: EvalMetadata;
  /** The provisioned env (empty when the runtime does not provision). */
  env: Record<string, string>;
}

/**
 * Capability implementations handed to the scorer's EvalContext. A helper the
 * runtime does not provide throws at call time — there is no binding phase.
 */
export interface ScorerCapabilities {
  query?(request: unknown): Promise<unknown>;
  getClient?(name: string): unknown;
}

/** Native web-browsing policy for the agent (recorded; enforced by adapters). */
export type WebPolicy = "native-web-allowed" | "native-web-blocked";

/**
 * The optional capability methods a runtime may implement. All optional:
 * a plain-data runtime (`{kind: "host"}`) is a complete runtime. The
 * identity-bearing counterpart is `Runtime.config` (see identity note above).
 */
export interface RuntimeCapabilities {
  /** Provision per-attempt resources BEFORE the sandbox exists (fail = no agent spend). */
  provision?(ctx: RuntimeProvisionContext): Promise<ProvisionedEnvironment>;
  /**
   * Runtime-level teardown, used when `provision`'s result carries no
   * `teardown` of its own (and attempted after a failed provision).
   */
  teardown?(ctx: RuntimeProvisionContext): Promise<void>;
  /** Resolve the container image for one eval (overridden by a static `image`). */
  containerImage?(metadata: EvalMetadata): string;
  /** Hosts this attempt may reach when the egress proxy is enabled. */
  egressHosts?(metadata: EvalMetadata): readonly string[];
  /** MCP servers the environment offers; authed entries ride the token proxy. */
  mcpServers?(): Record<string, McpServerConfig>;
  /** Native web tool policy for the agent. */
  webPolicy?(): WebPolicy;
  /** Directory prepended to the container PATH (the CLI treatment), if any. */
  pathTreatment?(): string | undefined;
  /** Capabilities (`query`, `getClient`) exposed to the eval's scorer. */
  scorerCapabilities?(ctx: ScorerCapabilityContext): ScorerCapabilities;
}
