/**
 * The agent adapter contract.
 *
 * The v3 runner depends only on these interfaces: it prepares the attempt's
 * starting state from the eval's `local/`, hands the adapter the eval's
 * prompt plus the experiment's treatment context, and expects back a
 * transcript, a diff, and metrics. Host adapters run in a scratch directory
 * (the echo pipeline smoke); container adapters compose a headless CLI
 * invocation the runner executes inside the attempt container.
 */

import type { McpServerConfig } from "../isolation/mcp.ts";
import type { WebPolicy } from "../runtime/types.ts";

/** Immutable agent configuration recorded in every experiment manifest. */
export interface AdapterIdentityConfig {
  provider: string;
  model: string;
  reasoning: string;
  /** Filled from the executable in the selected image when possible. */
  cliVersion: string;
  surfacePolicies: Record<string, string>;
  /** Whether non-web treatments can disable native/vendor web tools. This is not network isolation. */
  nativeWebControl: "controlled" | "uncontrolled";
  reproducible: boolean;
}

/** One event in an attempt's transcript (persisted as JSONL). */
export interface TranscriptEvent {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** ISO-8601 timestamp. */
  at: string;
}

export interface AttemptMetrics {
  /**
   * `null` means telemetry unavailable — the vendor stream carried no usage
   * data (or died before it). Never conflate with 0: zeros poison cost
   * comparisons, nulls render as "unavailable". The store's telemetry
   * columns have been nullable from the start for exactly this case.
   */
  tokensIn: number | null;
  tokensOut: number | null;
  turns: number;
  costUsd?: number;
}

/** Everything a host adapter gets for one attempt. */
export interface AttemptContext {
  /** Aborted when the current stage expires. Implementations must stop work. */
  signal?: AbortSignal;
  runId: string;
  attemptId: string;
  /** Absolute path to the directory holding the attempt's starting state. */
  fixtureDir: string;
  /**
   * Absolute path to an empty scratch directory. The adapter populates it
   * from the fixture and performs its edits there; the runner exports
   * it into the artifacts store afterwards.
   */
  workspaceDir: string;
  /**
   * The prompt the agent receives: the eval's task body (byte-identical
   * across experiments), preceded by the runtime's `promptPreamble` when the
   * treatment declares one (recorded per pair in the manifest).
   */
  prompt: string;
  trialIndex: number;
}

/** What an adapter returns for a completed attempt. */
export interface AttemptOutcome {
  transcript: TranscriptEvent[];
  /** Unified diff of the workspace against the fixture. */
  diff: string;
  metrics: AttemptMetrics;
}

/**
 * Which tree the runner prepares as the attempt's starting workspace:
 * `"fixture"` (the default) copies the eval's `local/`; `"solution"` copies
 * `local/` and then overlays the eval's `solution/` reference solution (the
 * built-in oracle adapter). A plan pairing a `"solution"` adapter with an
 * eval that has no `solution/` is refused at preflight.
 */
export type StartingState = "fixture" | "solution";

/**
 * What an adapter's attempts are for. "agent" is an arm under measurement; a
 * control checks the instrument instead: "positive-control" must pass (the
 * built-in oracle applies each eval's reference solution) and
 * "negative-control" must fail (the built-in echo adapter does nothing). The
 * runner records the role of the adapter that actually runs each experiment
 * (RunConfig.roles); the report never guesses it from a name.
 */
export type AdapterRole = "agent" | "positive-control" | "negative-control";

export interface AgentAdapter {
  /** The adapter name experiments select via `agent.adapter` (e.g. "echo"). */
  name: string;
  identity?: AdapterIdentityConfig;
  /** Starting workspace the runner prepares for this adapter (default "fixture"). */
  startingState?: StartingState;
  /** What the adapter's attempts are for (default "agent"). */
  role?: AdapterRole;
  runAttempt(ctx: AttemptContext): Promise<AttemptOutcome>;
}

/**
 * What a container adapter gets when composing its invocation. Host paths are
 * deliberately absent — a container adapter never touches the host
 * filesystem; the runner owns the container lifecycle so scoring can reach
 * the live sandbox before teardown.
 */
export interface ContainerAttemptContext {
  runId: string;
  attemptId: string;
  /**
   * The prompt the agent receives: the eval's task body (byte-identical
   * across experiments), preceded by the runtime's `promptPreamble` when the
   * treatment declares one (recorded per pair in the manifest).
   */
  prompt: string;
  trialIndex: number;
  /**
   * The experiment runtime's MCP servers, credential-free (authed entries
   * already point at the token-proxy sidecar) — present only when the
   * runtime declares servers. The adapter renders these into its vendor's
   * config format via setupFiles.
   */
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  /** The runtime's native web-tool policy (default: blocked). */
  webPolicy: WebPolicy;
  /**
   * The adapter's endpoint overrides that are set on the host (its
   * `optionalHostEnv` minus secret-named entries — never provider keys or
   * header bundles), for a CLI that takes a config-file entry rather than an
   * env var. Absent when none are set.
   */
  overrides?: Readonly<Record<string, string>>;
}

/**
 * A real agent driven headless inside the attempt container. The adapter is
 * pure composition + parsing: which files to place (treatment config),
 * which command to run in /workspace, which host env vars must exist, and
 * how to turn the raw output stream into telemetry. The raw stream itself is
 * the transcript artifact — parsing failures can never lose evidence.
 */
export interface ContainerAgentAdapter {
  kind: "container";
  /** The adapter name experiments select via `agent.adapter` (e.g. "claude", "codex"). */
  name: string;
  identity?: AdapterIdentityConfig;
  /** Starting workspace the runner prepares for this adapter (default "fixture"). */
  startingState?: StartingState;
  /** What the adapter's attempts are for (default "agent"). */
  role?: AdapterRole;
  /** Command used during preflight to record the executable's exact version. */
  versionCommand?: readonly string[];
  /**
   * Cheap authenticated request composed from the collected provider keys
   * (plus any `optionalHostEnv` overrides that are set), probed at run
   * preflight so a present-but-rejected key aborts BEFORE any container
   * spend. A 401/403 response stops the run; network failures only warn — an
   * unreachable probe must not gate a run the agent might complete.
   */
  keyProbe?(env: Record<string, string>): { url: string; headers: Record<string, string> };
  /**
   * Host env vars that must be present before any container is created
   * (shared provider keys — see src/secrets.ts).
   */
  requiredHostEnv: readonly string[];
  /**
   * Host env vars forwarded into the container when set, never required:
   * endpoint overrides such as a vendor base URL that routes the CLI through
   * an LLM gateway or proxy, and the custom headers that gateway needs. A
   * value that is an absolute URL also adds its host to the egress allowlist
   * and retargets the key probe; secret-named values (headers carrying a
   * bearer token) are redacted from artifacts like provider keys.
   */
  optionalHostEnv?: readonly string[];
  /**
   * Hosts this agent's CLI must reach (its LLM/vendor endpoints) — the
   * harness-default layer of the egress allowlist when the run uses the
   * egress proxy (see isolation/proxy/allowlist.ts). Adapters that omit it
   * contribute nothing, which under the proxy means the agent cannot reach
   * any endpoint the runtime's own egress hosts don't list.
   */
  egressHosts?: readonly string[];
  /**
   * Files to write inside the container before the agent starts, keyed by
   * absolute container path. This is where treatments differ: the MCP
   * treatment places MCP config, others place nothing.
   */
  setupFiles(ctx: ContainerAttemptContext): Record<string, string>;
  /** The headless invocation, executed in /workspace inside the container. */
  command(ctx: ContainerAttemptContext): string[];
  /** Parse the raw output stream into telemetry. Must tolerate malformed streams. */
  parseStream(raw: string): AttemptMetrics;
}

export type AnyAgentAdapter = AgentAdapter | ContainerAgentAdapter;
