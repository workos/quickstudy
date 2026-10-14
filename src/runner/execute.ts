/**
 * The v3 attempt loop: workspace prep from the eval's `local/`, agent
 * execution (host adapters, scripted container commands, or real container
 * agent adapters — claude/codex — driven headless inside the attempt
 * container), workspace export BEFORE scoring, scorer invocation with the
 * sandbox still alive, and persistence with explicit
 * `completed | incomplete | error` states.
 *
 * Treatments are runtime-owned: the experiment's `Runtime` supplies
 * provisioning, the container image, egress hosts, MCP servers, and the
 * PATH treatment (runtime/types.ts). The runner wires them — egress network
 * + proxy sidecar are per attempt; the MCP auth sidecar is run-scoped. Provisioning is
 * per-attempt, and every treatment reaches the container through the same
 * 0600 env-file channel secrets use (never argv).
 *
 * Ordering invariant: for container runtimes the workspace is exported and
 * the scorer runs while the container is still up — `ctx.exec` reaches into
 * the live sandbox — and teardown happens last. Scoring against a dead
 * sandbox is the failure mode this ordering exists to prevent. Teardown
 * failures are recorded explicitly on the attempt, never silently swallowed
 * and never allowed to mask the attempt's result.
 */

import { stageWorkspaceFiles } from "./workspace-files.ts";
import { defineWorkspaceFiles, validateWorkspaceFilesRuntime, workspaceFilesIdentity } from "../runtime/workspace-files.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentAdapter,
  AttemptOutcome,
  ContainerAgentAdapter,
  ContainerAttemptContext,
} from "../adapters/types.ts";
import { ClaudeCodeAdapter } from "../adapters/claude.ts";
import { CodexAdapter } from "../adapters/codex.ts";
import { EchoAdapter } from "../adapters/echo.ts";
import { OracleAdapter, OracleContainerAdapter } from "../adapters/oracle.ts";
import { validEvalResult } from "../evals/result.ts";
import { importEvalScorer } from "../evals/discovery.ts";
import { deadline, StageTimeoutError } from "./deadline.ts";
import { scoreInWorker } from "./score-worker.ts";
import { prepWorkspaceSource } from "./workspace-source.ts";
import type { EvalResult, LoadedEval } from "../evals/types.ts";
import type { AgentSpec, Experiment, LoadedExperiment, Runtime } from "../experiments/types.ts";
import { canonicalJson } from "../identity-diff.ts";
import {
  createAttemptContainer,
  connectContainerNetwork,
  disconnectContainerNetwork,
  createRunNetwork,
  inspectImageCommand,
  inspectImageIdentity,
  removeRunNetwork,
  startEgressSidecar,
  startMcpSidecar,
  type EgressSidecar,
  type McpSidecar,
} from "../isolation/docker.ts";
import { EGRESS_PROXY_IMAGE, MCP_PROXY_IMAGE } from "../isolation/images.ts";
import {
  authedMcpServers,
  persistRotatedRefreshToken,
  readMcpAuthMaterialFromConfig,
  rewriteMcpServerConfigs,
  type McpServerConfig,
} from "../isolation/mcp.ts";
import { hashString } from "../hash.ts";
import { DEFAULT_BUDGETS, pairKey, resolvePairEnvironments, type LifecycleBudgets, type PairEnvironment, composePrompt } from "../execution-policy.ts";
import { ulid } from "../ids.ts";
import { attemptIdentityHash, buildRunManifest, type RunManifest, type RuntimeImageIdentity } from "../manifest.ts";
import { isMovingModelAlias } from "../model-identity.ts";
import type { AttemptPlan } from "../plan.ts";
import type { ProvisionedEnvironment, RuntimeProvisionContext } from "../runtime/types.ts";
import { collectProviderKeys, hostSecretEnv, redactSecrets, validateProviderKeys, type ProviderKeyProbe } from "../secrets.ts";
import { ArtifactsStore } from "../store/artifacts.ts";
import { activeAttempts, type ErrorKind, type NewAttempt, type ResultsStore, type RunConfig } from "../store/db.ts";
import { acquireRunLock } from "./run-lock.ts";
import { orderedPlan, schedule } from "./scheduler.ts";
import { compareGroups } from "../experiments/groups.ts";
import {
  extractSurfaceUsage,
  observationConfig,
  surfaceUsageConfigFromRuntime,
  surfaceUsageVendor,
  type SurfaceUsageConfig,
} from "../surface-usage.ts";
import { buildEvalContext } from "./context.ts";

const DEFAULT_ATTEMPT_TIMEOUT_MS = 10 * 60_000;

/** The image-default PATH a `pathTreatment` directory is prepended to. */
const NORMAL_CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface ExecuteRunV3Options {
  evals: LoadedEval[];
  experiments: LoadedExperiment[];
  plan: AttemptPlan[];
  store: ResultsStore;
  artifacts: ArtifactsStore;
  /** Prebuilt manifest (tests inject one); built from evals/experiments when omitted. */
  manifest?: RunManifest;
  /** Extra run-config fields recorded in `runs.config_json`. */
  config?: Partial<RunConfig>;
  /** Host adapters by name. Defaults to the built-in echo adapter. */
  hostAdapters?: Record<string, AgentAdapter>;
  /** Internal offline-test seam; not part of the public consumer API. */
  createContainer?: typeof createAttemptContainer;
  /**
   * Container agent adapter factories by name, constructed per experiment
   * from its `agent` spec. Defaults to the built-in claude/codex adapters.
   * A container experiment without a scripted `runtime.command` resolves its
   * agent here; unknown names fail fast before any container work.
   */
  containerAdapters?: Record<string, (agent: AgentSpec) => ContainerAgentAdapter>;
  /**
   * Route every container through its own allowlisting proxy and internal
   * network. Unconfigured runtimes allow adapter endpoints only. Off by default.
   */
  egressProxy?: boolean;
  concurrency?: number;
  seed?: string;
  resumeRunId?: string;
  retryUnfinished?: boolean;
  signal?: AbortSignal;
  attemptTimeoutMs?: number;
  budgets?: Partial<LifecycleBudgets>;
  log?: (line: string) => void;
}

export interface RunSummaryV3 {
  runId: string;
  total: number;
  passed: number;
  failed: number;
  incomplete: number;
  errors: number;
}

interface AttemptDisposition {
  judgeRecords?: import("../evals/types.ts").JudgeRecord[];
  status: "completed" | "incomplete" | "error";
  result?: EvalResult;
  error?: string;
  /** Which stage failed; set on every `status: "error"` disposition. */
  errorKind?: ErrorKind;
}

/**
 * An error tagged with the attempt stage it was thrown from. Stages wrap
 * their own boundary (`inStage`) so helpers stay unaware of the taxonomy;
 * the message is the cause's, so recorded errors read exactly as before.
 */
export class StageFailure extends Error {
  constructor(readonly kind: ErrorKind, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "StageFailure";
  }
}

/** The kind an error reaching a catch-all carries: its stage, else `harness`. */
export function errorKindOf(err: unknown): ErrorKind {
  return err instanceof StageFailure ? err.kind : "harness";
}

async function inStage<T>(kind: ErrorKind, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw err instanceof StageFailure ? err : new StageFailure(kind, err);
  }
}

function defaultHostAdapters(): Record<string, AgentAdapter> {
  const echo = new EchoAdapter();
  const oracle = new OracleAdapter();
  return { [echo.name]: echo, [oracle.name]: oracle };
}

function defaultContainerAdapters(): Record<string, (agent: AgentSpec) => ContainerAgentAdapter> {
  return {
    claude: (agent) => new ClaudeCodeAdapter("claude", { model: agent.model, reasoning: agent.reasoning }),
    codex: (agent) => new CodexAdapter("codex", { model: agent.model, reasoning: agent.reasoning }),
    oracle: () => new OracleContainerAdapter(),
  };
}

/**
 * Resolve one container experiment's agent adapter, fail-fast on everything
 * that would otherwise burn a container: unknown adapter names, unpinned
 * model/reasoning (a moving default is not a valid measurement), and missing
 * provider keys (checked by the caller via `requiredHostEnv`).
 */
function resolveContainerAdapter(
  experiment: Experiment,
  factories: Record<string, (agent: AgentSpec) => ContainerAgentAdapter>,
): ContainerAgentAdapter {
  const make = Object.hasOwn(factories, experiment.agent.adapter) ? factories[experiment.agent.adapter] : undefined;
  if (!make) {
    throw new Error(
      `experiment "${experiment.id}" has a container runtime with no runtime.command and no container agent ` +
        `adapter named "${experiment.agent.adapter}" (available: ${Object.keys(factories).sort().join(", ")}) — ` +
        `declare a scripted command or select a known adapter`,
    );
  }
  const adapter = make(experiment.agent);
  if (adapter.identity?.model === "UNPINNED") {
    throw new Error(
      `experiment "${experiment.id}" must pin agent.model to an exact versioned id — ` +
        `moving agent defaults are not valid measurements`,
    );
  }
  if (adapter.identity?.model !== undefined && isMovingModelAlias(adapter.identity.model)) {
    throw new Error(
      `experiment "${experiment.id}" pins model "${adapter.identity.model}", which is a moving alias — ` +
        `use an immutable versioned model id`,
    );
  }
  if (adapter.identity?.reasoning === "UNPINNED") {
    throw new Error(`experiment "${experiment.id}" must pin agent.reasoning so reasoning effort cannot drift between runs`);
  }
  return adapter;
}

/** Shared MCP authentication. Egress networks and allowlists belong to each attempt. */
interface TreatmentRuntimes {
  mcp?: {
    sidecar?: McpSidecar;
    servers: Record<string, McpServerConfig>;
    originalByExperiment: Map<string, Record<string, McpServerConfig>>;
    serversByExperiment: Map<string, Record<string, McpServerConfig>>;
  };
}

async function setupTreatmentRuntimes(args: {
  declaredByExperiment: Map<string, Record<string, McpServerConfig>>;
  runId: string;
}): Promise<TreatmentRuntimes> {
  const merged: Record<string, McpServerConfig> = {};
  for (const servers of args.declaredByExperiment.values()) for (const [name, spec] of Object.entries(servers)) {
    if (merged[name] && canonicalJson(merged[name]) !== canonicalJson(spec)) throw new Error(`mcp server "${name}" has conflicting configs`);
    merged[name] = spec;
  }
  if (args.declaredByExperiment.size === 0) return {};
  let sidecar: McpSidecar | undefined;
  if (Object.keys(authedMcpServers(merged)).length > 0) {
    const material = readMcpAuthMaterialFromConfig(merged);
    sidecar = await startMcpSidecar({ runId: args.runId, image: MCP_PROXY_IMAGE, upstreams: material.upstreams, refreshTokens: material.refreshTokens });
  }
  const base = sidecar ? `http://${sidecar.ip}:${sidecar.port}` : "http://unused";
  return { mcp: { ...(sidecar ? { sidecar } : {}), servers: merged,
    originalByExperiment: args.declaredByExperiment,
    serversByExperiment: new Map([...args.declaredByExperiment].map(([id, servers]) => [id, rewriteMcpServerConfigs(servers, base)])),
  } };
}

/**
 * Stop the run's treatment infrastructure. Rotated MCP refresh tokens are
 * read back BEFORE the sidecar dies — rotation makes the on-disk token stale
 * the moment the sidecar refreshes once, and losing the live token silently
 * would cost the operator a re-login. Teardown failures warn and continue
 * (label-swept by `clean`); they never crash the run.
 */
async function teardownTreatmentRuntimes(state: TreatmentRuntimes, log: (line: string) => void): Promise<void> {
  const mcpSidecar = state.mcp?.sidecar;
  if (state.mcp && mcpSidecar) {
    try {
      const rotated = await mcpSidecar.readRotatedRefreshTokens();
      for (const [name, token] of Object.entries(rotated)) {
        const spec = state.mcp.servers[name];
        if (token !== undefined && spec) persistRotatedRefreshToken(spec, token);
        else {
          log(
            `warning: could not read back the rotated refresh token for mcp server "${name}" — ` +
              `the next run may need a fresh login`,
          );
        }
      }
      await mcpSidecar.teardown();
    } catch (err) {
      log(
        `warning: mcp auth proxy teardown failed (${err instanceof Error ? err.message : String(err)}) — ` +
          `inspect resources labeled for this run before removing them`,
      );
    }
  }

}

/**
 * Derive the OFFERED surface configuration per planned container experiment,
 * for the run record (the egress-allowlist precedent: what a run offered is
 * part of its record). MCP names come from the runner's already-resolved
 * server maps — never from calling `runtime.mcpServers()` again, which could
 * re-trigger credential checks. Experiments whose config yields nothing are
 * omitted, and an all-empty result is `undefined` so the run record omits
 * the field entirely (absent ≠ empty-offered).
 */
export function collectOfferedSurfaces(options: {
  experimentIds: readonly string[];
  experimentsById: Map<string, Experiment>;
  mcpServersByExperiment?: Map<string, Record<string, McpServerConfig>>;
}): Record<string, SurfaceUsageConfig> | undefined {
  const surfaces: Record<string, SurfaceUsageConfig> = {};
  const ids = [...new Set(options.experimentIds)].sort((a, b) => a.localeCompare(b));
  for (const experimentId of ids) {
    const experiment = options.experimentsById.get(experimentId);
    if (experiment === undefined || experiment.runtime.kind !== "container") continue;
    const offered = surfaceUsageConfigFromRuntime(
      experiment.runtime.config,
      Object.keys(options.mcpServersByExperiment?.get(experimentId) ?? {}),
    );
    const declared =
      (offered.docsHosts?.length ?? 0) + (offered.cliCommands?.length ?? 0) + (offered.mcpServers?.length ?? 0);
    if (declared > 0 || experiment.runtime.observationTargets !== undefined) surfaces[experimentId] = offered;
  }
  return Object.keys(surfaces).length > 0 ? surfaces : undefined;
}

export async function executeRunV3(options: ExecuteRunV3Options): Promise<RunSummaryV3> {
  // Capture immutable payload strings before the first await, including callers
  // that did not use defineExperiment. Identity and execution share this snapshot.
  options = { ...options, experiments: options.experiments.map((loaded) => {
    validateWorkspaceFilesRuntime(loaded.experiment.runtime);
    const files = loaded.experiment.runtime.workspaceFiles;
    return files === undefined ? loaded : { ...loaded, experiment: { ...loaded.experiment,
      runtime: { ...loaded.experiment.runtime, workspaceFiles: defineWorkspaceFiles(files) },
    } };
  }) };
  const { store, artifacts, plan } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const attemptTimeoutMs = options.attemptTimeoutMs ?? options.budgets?.agentMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const hostAdapters = options.hostAdapters ?? defaultHostAdapters();

  const evalsById = new Map(options.evals.map((entry) => [entry.metadata.id, entry]));
  const experimentsById = new Map(options.experiments.map((entry) => [entry.experiment.id, entry.experiment]));
  const containerAdapterFactories = options.containerAdapters ?? defaultContainerAdapters();

  // Fail fast BEFORE the first attempt: every plan entry must resolve, every
  // experiment must be executable (a scripted command or a known container
  // agent adapter), and every provider key must be present on the host.
  const containerAgents = new Map<string, ContainerAgentAdapter>();
  const imageTagsByPair: Record<string, string> = {};
  const declaredByExperiment = new Map<string, Record<string, McpServerConfig>>();
  const imageTagsByExperiment = new Map<string, Set<string>>();
  for (const entry of plan) {
    if (!evalsById.has(entry.evalId)) throw new Error(`plan names unknown eval "${entry.evalId}"`);
    const experiment = experimentsById.get(entry.experimentId);
    if (!experiment) throw new Error(`plan names unknown experiment "${entry.experimentId}"`);
    if (experiment.runtime.kind === "host" && !Object.hasOwn(hostAdapters, experiment.agent.adapter)) {
      throw new Error(
        `experiment "${experiment.id}" needs host adapter "${experiment.agent.adapter}" ` +
          `(available: ${Object.keys(hostAdapters).join(", ")})`,
      );
    }
    if (experiment.runtime.kind === "container") {
      if ((experiment.runtime.command ?? []).length > 0 && experiment.agent.adapter === "oracle") {
        throw new Error(
          `experiment "${experiment.id}" selects the oracle adapter but sets runtime.command, which bypasses it — ` +
            `drop runtime.command so the reference solution is what gets scored`,
        );
      }
      if ((experiment.runtime.command ?? []).length === 0 && !containerAgents.has(experiment.id)) {
        const adapter = resolveContainerAdapter(experiment, containerAdapterFactories);
        // Provider keys are validated here — before any run row, sidecar, or
        // container exists — and injected into the attempt container at create.
        collectProviderKeys([adapter]);
        containerAgents.set(experiment.id, adapter);
      }
      if (experiment.runtime.mcpServers && !declaredByExperiment.has(experiment.id)) declaredByExperiment.set(experiment.id, experiment.runtime.mcpServers());
      const loadedEval = evalsById.get(entry.evalId) as LoadedEval;
      const key = pairKey(entry.evalId, entry.experimentId);
      const image = imageTagsByPair[key] ?? experiment.runtime.image ?? experiment.runtime.containerImage?.(loadedEval.metadata);
      if (image === undefined || image === "") {
        throw new Error(
          `experiment "${experiment.id}" resolves no container image for eval "${entry.evalId}" — ` +
            `set runtime.image or a containerImage(metadata) resolver`,
        );
      }
      let tags = imageTagsByExperiment.get(experiment.id);
      if (tags === undefined) imageTagsByExperiment.set(experiment.id, (tags = new Set()));
      tags.add(image);
      imageTagsByPair[key] = image;
    }
  }

  // Reference-solution preflight: an adapter that starts from the solution
  // overlay (the oracle) cannot run an eval without solution/. Every
  // offending pair is named at once, before any run row exists.
  const missingSolutions: string[] = [];
  for (const entry of plan) {
    const experiment = experimentsById.get(entry.experimentId) as Experiment;
    const startingState =
      experiment.runtime.kind === "host"
        ? hostAdapters[experiment.agent.adapter]?.startingState
        : containerAgents.get(experiment.id)?.startingState;
    if (startingState === "solution" && (evalsById.get(entry.evalId) as LoadedEval).solutionDir === null) {
      missingSolutions.push(`${entry.experimentId} × ${entry.evalId}`);
    }
  }
  if (missingSolutions.length > 0) {
    throw new Error(
      `the oracle adapter needs solution/ — add it or drop the eval from the run: ${[...new Set(missingSolutions)].join(", ")}`,
    );
  }

  // Live key preflight: a key that is present but rejected by the provider
  // would burn a container per attempt just to 401 inside it. Probe each
  // unique agent's endpoint once — before any docker, sidecar, or run-row
  // work — and say plainly whether the run starts. Adapters without a probe
  // (tests, custom adapters) skip it.
  const probesByAdapter = new Map<string, ProviderKeyProbe>();
  for (const adapter of containerAgents.values()) {
    if (adapter.keyProbe === undefined || probesByAdapter.has(adapter.name)) continue;
    probesByAdapter.set(adapter.name, {
      name: adapter.name,
      envVars: adapter.requiredHostEnv,
      ...adapter.keyProbe(collectProviderKeys([adapter])),
    });
  }
  await validateProviderKeys([...probesByAdapter.values()], { log });
  log(`run starting: ${plan.length} attempt(s)`);

  // Resolve image digests and agent CLI versions BEFORE building the manifest:
  // a mutable tag names the image, its digest is the image, and the executable
  // in it is the CLI version the run actually measured. Probing happens only
  // when this call builds the manifest itself (injected manifests are the
  // tests' deterministic path); host-only plans collect no tags and never
  // touch Docker.
  let manifest = options.manifest;
  if (manifest === undefined) {
    const allTags = [...new Set([...imageTagsByExperiment.values()].flatMap((tags) => [...tags]))].sort((a, b) =>
      a.localeCompare(b),
    );
    const images: Record<string, RuntimeImageIdentity> = {};
    for (const tag of allTags) {
      // A missing image fails here — before the run row, sidecars, or any
      // agent spend exist — with docker's own "No such image" message.
      images[tag] = await inspectImageIdentity(tag);
    }
    const cliVersions: Record<string, string> = {};
    const probeCache = new Map<string, string>();
    for (const [experimentId, adapter] of containerAgents) {
      const command = adapter.versionCommand;
      const tags = imageTagsByExperiment.get(experimentId);
      if (command === undefined || tags === undefined) continue;
      // A resolver can map one experiment to several images; they share the
      // agent CLI layer, so probe the first (sorted) tag for determinism.
      const tag = [...tags].sort((a, b) => a.localeCompare(b))[0] as string;
      const cacheKey = `${tag}\0${command.join(" ")}`;
      let version = probeCache.get(cacheKey);
      if (version === undefined) {
        try {
          version = await inspectImageCommand(tag, command);
        } catch (err) {
          // A failed probe degrades to the experiment's declared cliVersion
          // rather than aborting: the headless invocation may still work
          // where a bare --entrypoint probe does not.
          log(
            `warning: version probe "${command.join(" ")}" failed in image "${tag}" ` +
              `(${err instanceof Error ? err.message : String(err)}) — recording the declared cliVersion`,
          );
          continue;
        }
        probeCache.set(cacheKey, version);
      }
      cliVersions[experimentId] = version;
    }
    const scorerIdentities: Record<string, Record<string, unknown>> = {};
    for (const loaded of options.evals) {
      const scorer = await importEvalScorer(loaded.scorerPath);
      if (scorer.identity) scorerIdentities[loaded.metadata.id] = scorer.identity;
    }
    const pairs = resolvePairEnvironments({ ...options, images, imageTags: imageTagsByPair,
      adapterHosts: Object.fromEntries([...containerAgents].map(([id, adapter]) => [id, adapter.egressHosts ?? []])),
      budgets: { ...options.budgets, agentMs: options.attemptTimeoutMs ?? options.budgets?.agentMs ?? attemptTimeoutMs },
      mcpHashes: Object.fromEntries([...declaredByExperiment].map(([id, servers]) => [id, hashString(canonicalJson(servers))])),
    });
    manifest = buildRunManifest({ evals: options.evals, experiments: options.experiments, images, cliVersions, pairs, scorerIdentities });
  }
  // Injected/stale manifests must not authorize a different payload (or silently
  // omit one). Historical no-overlay manifests retain their original shape.
  for (const entry of plan) {
    const files = experimentsById.get(entry.experimentId)!.runtime.workspaceFiles;
    const intended = files ? workspaceFilesIdentity(files) : undefined;
    if (canonicalJson(intended ?? null) !== canonicalJson(manifest.pairs?.[pairKey(entry.evalId, entry.experimentId)]?.workspaceFiles ?? null)) {
      throw new Error("workspaceFiles: manifest payload identity mismatch");
    }
  }
  const recorded = options.resumeRunId ? store.getRun(options.resumeRunId) : null;
  if (options.resumeRunId && !recorded) throw new Error(`cannot resume unknown run ${options.resumeRunId}`);
  if (recorded && (recorded.manifest.manifestVersion !== "v4" || recorded.manifestHash !== manifest.hash)) throw new Error("resume refused: code or environment identity changed (historical v3 identity cannot be resumed)");
  const runId = recorded?.id ?? ulid();
  const concurrency = options.concurrency ?? recorded?.config.scheduler?.concurrency ?? 1;
  const seed = options.seed ?? recorded?.config.scheduler?.seed ?? "0";
  const order = orderedPlan(plan, seed);
  if (recorded && canonicalJson(recorded.config.scheduler?.order) !== canonicalJson(order)) throw new Error("resume refused: planned coordinates or ordering changed");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const releaseLock = acquireRunLock(artifacts.rootDir, runId);
  let treatments: TreatmentRuntimes = {};
  try {

  // Treatment infrastructure comes up BEFORE the run row: setup is fail-fast
  // (missing MCP credentials, invalid egress hosts), and what a run could
  // reach is part of its recorded configuration.
  treatments = await setupTreatmentRuntimes({ declaredByExperiment, runId });

  try {
    // Offered surfaces are recorded ON THE RUN — the per-attempt derivation
    // (observed-usage extraction) is otherwise derived live and discarded,
    // which would leave post-hoc diagnosis blind in exactly the
    // never-invoked-the-surface case.
    const offeredSurfaces = collectOfferedSurfaces({
      experimentIds: plan.map((entry) => entry.experimentId),
      experimentsById,
      ...(treatments.mcp !== undefined ? { mcpServersByExperiment: treatments.mcp.serversByExperiment } : {}),
    });
    const config: RunConfig = {
      scheduler: { concurrency, seed, policy: "seeded-hash-v1", order },
      trials: options.config?.trials ?? plan.reduce((max, entry) => Math.max(max, entry.trialIndex + 1), 1),
      evalIds: options.config?.evalIds ?? [...new Set(plan.map((entry) => entry.evalId))],
      experimentIds: options.config?.experimentIds ?? [...new Set(plan.map((entry) => entry.experimentId))],
      ...(options.config?.evalsRoot !== undefined ? { evalsRoot: options.config.evalsRoot } : {}),
      ...(options.config?.experimentsRoot !== undefined ? { experimentsRoot: options.config.experimentsRoot } : {}),
      // Summary only. Each attempt enforces its manifest.pairs policy.
      egress: { proxy: options.egressProxy ?? false, allowlist: [...new Set(Object.values(manifest.pairs ?? {}).flatMap((p) => p.egress.proxy ? p.egress.allowlist : []))].sort() },
      // Comparison groups (with their withhold-and-diff state) are recorded
      // ON THE RUN: the manifest holds runtime config only as an opaque hash,
      // so the report could never recompute this after the fact.
      groups: compareGroups(options.experiments.map((entry) => entry.experiment), manifest),
      // Roles come from the resolved adapter, never its name: a scripted
      // container command is an agent whatever `agent.adapter` says.
      roles: Object.fromEntries(
        [...experimentsById.values()].map((experiment) => [
          experiment.id,
          experiment.runtime.kind === "host"
            ? (hostAdapters[experiment.agent.adapter]?.role ?? "agent")
            : (experiment.runtime.command ?? []).length > 0
              ? "agent"
              : (containerAgents.get(experiment.id)?.role ?? "agent"),
        ]),
      ),
      ...(offeredSurfaces !== undefined ? { surfaces: offeredSurfaces } : {}),
    };

    const summary: RunSummaryV3 = { runId, total: plan.length, passed: 0, failed: 0, incomplete: 0, errors: 0 };

    const previous = activeAttempts(store.listAttempts(runId));
    const coordinate = (entry: AttemptPlan) => JSON.stringify([entry.evalId, entry.experimentId, entry.trialIndex]);
    const byCoordinate = new Map<string, typeof previous>();
    for (const row of previous) {
      const key = coordinate(row); const rows = byCoordinate.get(key) ?? []; rows.push(row); byCoordinate.set(key, rows);
      if (row.status === "completed" && !validEvalResult(row.result)) throw new Error(`resume refused: invalid completed outcome ${row.id}`);
      if (rows.length > 1) throw new Error(`resume refused: duplicate trial coordinate ${key}`);
      if (row.attemptIdentityHash !== attemptIdentityHash(row, manifest)) throw new Error(`resume refused: attempt identity mismatch ${row.id}`);
    }
    if (recorded) store.reopenRun(runId);
    else store.insertRun({ id: runId, startedAt: Date.now(), config, manifest });
    const pending = order.filter((entry) => {
      const existing = byCoordinate.get(coordinate(entry))?.[0];
      return !existing || (existing.status !== "completed" && options.retryUnfinished);
    });
    const ids = new Map(plan.map((entry) => [coordinate(entry), ulid()]));
    await schedule(pending, concurrency, async (entry) => {
      const loadedEval = evalsById.get(entry.evalId) as LoadedEval;
      const experiment = experimentsById.get(entry.experimentId) as Experiment;
      const attemptId = ids.get(coordinate(entry))!;
      const startedAt = Date.now();

      const persisted: NewAttempt = {
        id: attemptId,
        retryOf: byCoordinate.get(coordinate(entry))?.[0]?.id ?? null,
        runId,
        evalId: entry.evalId,
        experimentId: entry.experimentId,
        suite: loadedEval.metadata.suite,
        trialIndex: entry.trialIndex,
        attemptIdentityHash: attemptIdentityHash(entry, manifest),
        status: "error",
        startedAt,
      };

      let disposition: AttemptDisposition;
      try {
        disposition =
          experiment.runtime.kind === "host"
            ? await runHostAttemptV3(options, hostAdapters, loadedEval, experiment, entry, { runId, attemptId, attemptTimeoutMs, persisted, environment: manifest.pairs?.[pairKey(entry.evalId, entry.experimentId)] })
            : await runContainerAttemptV3(
                options,
                loadedEval,
                experiment,
                entry,
                { runId, attemptId, attemptTimeoutMs, persisted, environment: manifest.pairs?.[pairKey(entry.evalId, entry.experimentId)] },
                treatments,
                containerAgents.get(experiment.id),
              );
      } catch (err) {
        // An attempt failure never aborts the run: persist the error and move on.
        const message = err instanceof Error ? err.message : String(err);
        await artifacts.writeError(runId, attemptId, message);
        disposition = { status: "error", error: message, errorKind: errorKindOf(err) };
      }

      persisted.status = disposition.status;
      persisted.errorKind = disposition.status === "error" ? (disposition.errorKind ?? "harness") : null;
      // A limit hit means the workspace it left was graded; an unscored
      // attempt (incomplete, or a later stage errored) carries none.
      if (disposition.status !== "completed") persisted.limitHit = null;
      if (disposition.judgeRecords) persisted.judgeRecords = disposition.judgeRecords;
      if (disposition.result !== undefined) persisted.result = disposition.result;
      if (disposition.error !== undefined) persisted.error = disposition.error;
      persisted.finishedAt = Date.now();
      store.insertAttempt(persisted);

      if (disposition.status === "completed") {
        if (disposition.result?.passed) summary.passed += 1;
        else summary.failed += 1;
      } else if (disposition.status === "incomplete") {
        summary.incomplete += 1;
      } else {
        summary.errors += 1;
      }
      log(
        `attempt ${attemptId} (${entry.evalId} × ${entry.experimentId} trial ${entry.trialIndex + 1}): ` +
          `${disposition.status}${disposition.result ? ` — ${disposition.result.passed ? "passed" : "failed"}` : ""}`,
      );
    }, { ...(options.signal ? { signal: options.signal } : {}), capacity: (entry) => experimentsById.get(entry.experimentId)?.runtime.capacity });

    const current = activeAttempts(store.listAttempts(runId));
    summary.passed = current.filter((a) => a.status === "completed" && a.result?.passed).length;
    summary.failed = current.filter((a) => a.status === "completed" && !a.result?.passed).length;
    summary.errors = current.filter((a) => a.status === "error").length;
    summary.incomplete = current.filter((a) => a.status === "incomplete").length + plan.length - current.length;
    if (!options.signal?.aborted) store.finishRun(runId, Date.now());
    return summary;
  } finally {
    await teardownTreatmentRuntimes(treatments, log);
  }
  } finally { releaseLock(); }
}

/** Exec inside the container and throw (with stderr) on non-zero exit. */
async function mustExec(
  container: { execInWorkspace(cmd: string[], opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> },
  cmd: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await container.execInWorkspace(cmd);
  if (result.exitCode !== 0) {
    throw new Error(`container command "${cmd.join(" ")}" exited ${result.exitCode}: ${result.stderr.trim()}`);
  }
  return result;
}

interface AttemptArgs {
  runId: string;
  attemptId: string;
  attemptTimeoutMs: number;
  persisted: NewAttempt;
  environment?: PairEnvironment;
}

async function runHostAttemptV3(
  options: ExecuteRunV3Options,
  hostAdapters: Record<string, AgentAdapter>,
  loadedEval: LoadedEval,
  experiment: Experiment,
  entry: AttemptPlan,
  args: AttemptArgs,
): Promise<AttemptDisposition> {
  const { artifacts } = options;
  const { runId, attemptId, persisted } = args;
  const adapter = hostAdapters[experiment.agent.adapter] as AgentAdapter;

  const sourceDir = await inStage("environment", () => prepWorkspaceSource(loadedEval, adapter.startingState ?? "fixture"));
  const scratchDir = await inStage("environment", () => mkdtemp(join(tmpdir(), "quickstudy-v3-attempt-")));
  try {
    let outcome: AttemptOutcome | undefined;
    persisted.agentStartedAt = Date.now();
    try {
      outcome = await deadline("agent", args.attemptTimeoutMs, (signal) => adapter.runAttempt({
        signal,
        runId,
        attemptId,
        fixtureDir: sourceDir,
        workspaceDir: scratchDir,
        prompt: composePrompt(args.environment?.promptPreamble, loadedEval.promptBody),
        trialIndex: entry.trialIndex,
      }));
    } catch (err) {
      if (!(err instanceof StageTimeoutError)) throw new StageFailure("agent", err);
      // Graded timeout: the adapter never returned (no transcript, diff, or
      // metrics), but the scratch workspace it was writing into exists — the
      // tree it left behind is exported and scored like any other.
      await artifacts.writeError(runId, attemptId, `attempt timed out after ${args.attemptTimeoutMs}ms; workspace graded as left`);
      persisted.limitHit = "timeout";
    } finally {
      persisted.agentFinishedAt = Date.now();
    }

    if (outcome === undefined) {
      const workspaceDir = await inStage("environment", () => artifacts.exportWorkspace(runId, attemptId, scratchDir));
      return await scoreAttempt(options, loadedEval, experiment, entry, { runId, attemptId, workspaceDir });
    }

    persisted.transcriptRef = await artifacts.writeTranscript(runId, attemptId, outcome.transcript);
    persisted.diffRef = await artifacts.writeDiff(runId, attemptId, outcome.diff);
    persisted.tokensIn = outcome.metrics.tokensIn;
    persisted.tokensOut = outcome.metrics.tokensOut;
    persisted.turns = outcome.metrics.turns;
    if (outcome.metrics.costUsd !== undefined) persisted.costUsd = outcome.metrics.costUsd;

    // Export FIRST, then score against the export (no live sandbox exists on
    // the host path — exec runs in the exported workspace directory).
    const workspaceDir = await inStage("environment", () => artifacts.exportWorkspace(runId, attemptId, scratchDir));
    return await scoreAttempt(options, loadedEval, experiment, entry, { runId, attemptId, workspaceDir, agentOutput: { finalReport: outcome.transcript.filter((e) => e.role === "assistant").at(-1)?.content ?? null, transcript: JSON.stringify(outcome.transcript).slice(0, 131072), truncated: JSON.stringify(outcome.transcript).length > 131072 } });
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
    if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
  }
}

/**
 * Run the provisioned (or runtime-level) teardown, returning a failure note
 * instead of throwing: a broken teardown must never mask the attempt's
 * result — the note is recorded explicitly on the attempt instead.
 */
async function attemptRuntimeTeardown(
  runtime: Runtime,
  provisioned: ProvisionedEnvironment | undefined,
  ctx: RuntimeProvisionContext,
  timeoutMs = DEFAULT_BUDGETS.cleanupMs,
): Promise<string | undefined> {
  try {
    await deadline("cleanup", timeoutMs, async (signal) => {
      if (provisioned?.teardown) await provisioned.teardown(signal);
      else if (runtime.teardown) await runtime.teardown({ ...ctx, signal });
    });
    return undefined;
  } catch (err) {
    return `runtime teardown failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function runContainerAttemptV3(
  options: ExecuteRunV3Options,
  loadedEval: LoadedEval,
  experiment: Experiment,
  entry: AttemptPlan,
  args: AttemptArgs,
  treatments: TreatmentRuntimes,
  agentAdapter: ContainerAgentAdapter | undefined,
): Promise<AttemptDisposition> {
  const { artifacts } = options;
  const { runId, attemptId, persisted } = args;
  const runtime = experiment.runtime;
  const environment = args.environment;
  let egress: { networkName: string; sidecar: EgressSidecar } | undefined;
  let mcpIp: string | undefined;
  let mcpNetwork: string | undefined;

  const provisionCtx: RuntimeProvisionContext = {
    attemptId,
    evalId: entry.evalId,
    metadata: loadedEval.metadata,
  };

  // Provision BEFORE any container work: a failed provision is an explicit
  // attempt error with the provisioner's message and costs no agent spend.
  let provisioned: ProvisionedEnvironment | undefined;
  if (runtime.provision) {
    try {
      provisioned = await deadline("provision", environment?.budgets.provisionMs ?? options.budgets?.provisionMs ?? DEFAULT_BUDGETS.provisionMs,
        (signal) => runtime.provision!({ ...provisionCtx, signal }),
        async (late) => { const note = await attemptRuntimeTeardown(runtime, late, provisionCtx, options.budgets?.cleanupMs); if (note) await artifacts.writeError(runId, attemptId, note); });
    } catch (err) {
      const message = `provision failed: ${err instanceof Error ? err.message : String(err)}`;
      // Teardown is still attempted — a provisioner may fail after creating
      // some of what its runtime-level teardown knows how to scrub.
      const teardownFailure = await attemptRuntimeTeardown(runtime, undefined, provisionCtx, environment?.budgets.cleanupMs ?? options.budgets?.cleanupMs);
      const error = teardownFailure !== undefined ? `${message}; ${teardownFailure}` : message;
      await artifacts.writeError(runId, attemptId, error);
      return { status: "error", error, errorKind: "environment" };
    }
  }

  let sourceDir: Awaited<ReturnType<typeof prepWorkspaceSource>> | undefined;
  let containerTeardownFailure: string | undefined;
  let disposition: AttemptDisposition;
  try {
    disposition = await (async (): Promise<AttemptDisposition> => {
      sourceDir = await inStage("environment", () => prepWorkspaceSource(loadedEval, agentAdapter?.startingState ?? "fixture"));
      const resolvedImage = environment?.image;
      const image = resolvedImage && resolvedImage.id !== "unresolved" ? resolvedImage.id : resolvedImage?.tag ?? runtime.image ?? (runtime.containerImage?.(loadedEval.metadata) as string);
      if (environment?.egress.proxy) {
        const egressPolicy = environment.egress;
        await inStage("environment", async () => {
          const networkName = await createRunNetwork(`${runId}-${attemptId}`);
          try {
            const sidecar = await startEgressSidecar({ runId, networkName, allowlist: egressPolicy.allowlist, image: EGRESS_PROXY_IMAGE });
            egress = { networkName, sidecar };
          } catch (err) { await removeRunNetwork(networkName); throw err; }
          if (treatments.mcp?.sidecar) {
            mcpNetwork = networkName;
            mcpIp = await connectContainerNetwork(treatments.mcp.sidecar.id, networkName);
          }
        });
      }

      // --- treatment env: everything rides the 0600 env-file, never argv ---
      const env: Record<string, string> = { ...provisioned?.env };
      // Only the SECRET-bearing subset feeds redaction: provisioned
      // credentials and provider keys. Treatment plumbing (PATH, proxy env,
      // the credential-free MCP server map) is diagnostic, not secret —
      // redacting it would blind the transcript reader for no hygiene gain.
      const secretEnv: Record<string, string> = { ...provisioned?.env };
      const pathDir = environment?.pathTreatment ?? undefined;
      if (pathDir !== undefined && pathDir !== "") {
        // Only this treatment exposes the directory; other treatments keep
        // the image-default PATH and cannot accidentally discover its tools.
        env["PATH"] = `${pathDir}:${NORMAL_CONTAINER_PATH}`;
      }
      const originalServers = treatments.mcp?.originalByExperiment.get(experiment.id);
      const rewrittenServers = mcpIp && originalServers && treatments.mcp?.sidecar
        ? rewriteMcpServerConfigs(originalServers, `http://${mcpIp}:${treatments.mcp.sidecar.port}`)
        : treatments.mcp?.serversByExperiment.get(experiment.id);
      if (rewrittenServers !== undefined) {
        // Credential-free by construction: rewriteMcpServerConfigs stripped
        // every auth block and pointed authed servers at the proxy sidecar.
        env["QUICKSTUDY_MCP_SERVERS"] = JSON.stringify(rewrittenServers);
      }
      if (agentAdapter !== undefined) {
        // The agent's provider keys, validated at run preflight — injected
        // at create via the 0600 env-file channel, never argv.
        const providerKeys = collectProviderKeys([agentAdapter]);
        Object.assign(env, providerKeys);
        Object.assign(secretEnv, providerKeys);
      }
      if (egress) {
        const proxyEnv = egress.sidecar.proxyEnv();
        const mcpSidecar = treatments.mcp?.sidecar;
        if (mcpSidecar) {
          // The mcp sidecar shares the internal network — its address must
          // bypass the egress proxy, which refuses raw-IP targets by design.
          const noProxy = `${proxyEnv["NO_PROXY"]},${mcpIp ?? mcpSidecar.ip}`;
          proxyEnv["NO_PROXY"] = noProxy;
          proxyEnv["no_proxy"] = noProxy;
        }
        Object.assign(env, proxyEnv);
      }

      const paths = await inStage("environment", () => artifacts.prepareAttempt(runId, attemptId));
      const fixtureDir = sourceDir;
      const container = await inStage("environment", () => (options.createContainer ?? createAttemptContainer)({
        image,
        env,
        resultsDir: paths.attemptDir,
        attemptId,
        fixtureDir,
        // Under the egress treatment the internal network replaces the
        // default bridge: the proxy sidecar is the only path to the world.
        ...(egress ? { network: egress.networkName } : {}),
      }));
      try {
        let command: string[];
        let baselineSha: string | undefined;
        if (agentAdapter !== undefined) {
          // --- real agent path: baseline commit -> treatment files -> CLI ---
          // Baseline commit: the diff artifact is git's comparison of the
          // final workspace against this exact commit. The SHA is recorded
          // (not just HEAD) so an agent that makes its own commits cannot
          // move the baseline out from under the diff.
          const gitAvailable = await inStage("environment", async () => (await container.execInWorkspace(["git", "--version"])).exitCode === 0);
          if (gitAvailable) {
            baselineSha = await inStage("environment", async () => {
              await mustExec(container, ["git", "init", "-q"]);
              await mustExec(container, ["git", "add", "-A"]);
              await mustExec(container, [
                "git", "-c", "user.name=quickstudy", "-c", "user.email=quickstudy@localhost",
                "commit", "-q", "--allow-empty", "-m", "quickstudy fixture baseline",
              ]);
              return (await mustExec(container, ["git", "rev-parse", "HEAD"])).stdout.trim();
            });
          } else {
            if (runtime.workspaceFiles) throw new StageFailure("environment", new Error("workspaceFiles: git baseline is required"));
            (options.log ?? console.log)(
              `attempt ${attemptId}: git is unavailable in image "${image}" — diff.patch will be empty ` +
                `(the agent-runtime image ships git; only bare test images lack it)`,
            );
          }

          const promptCtx: ContainerAttemptContext = {
            runId,
            attemptId,
            // The eval body is byte-identical across experiments; a runtime's
            // promptPreamble (recorded per pair in the manifest) may precede it.
            prompt: composePrompt(environment?.promptPreamble, loadedEval.promptBody),
            trialIndex: entry.trialIndex,
            ...(rewrittenServers !== undefined ? { mcpServers: rewrittenServers } : {}),
            webPolicy: environment?.webPolicy ?? "native-web-blocked",
          };
          // Treatment config files (e.g. the MCP treatment's vendor config).
          await inStage("environment", async () => {
            const setup = agentAdapter.setupFiles(promptCtx);
            if (runtime.workspaceFiles) {
              const evidence = await stageWorkspaceFiles(container, runtime.workspaceFiles, environment!.workspaceFiles!, setup, options.signal);
              await artifacts.writeWorkspaceFilesEvidence(runId, attemptId, evidence);
              if (options.signal?.aborted) throw new Error("workspaceFiles: staging cancelled");
            } else {
              for (const [path, content] of Object.entries(setup)) await container.writeFile(path, content);
            }
          });
          command = agentAdapter.command(promptCtx);
        } else {
          command = runtime.command as string[];
        }

        if (runtime.workspaceFiles && options.signal?.aborted) throw new StageFailure("environment", new Error("workspaceFiles: staging cancelled"));
        persisted.agentStartedAt = Date.now();
        let agentResult: Awaited<ReturnType<typeof container.execInWorkspace>>;
        try {
          agentResult = await inStage("agent", () => container.execInWorkspace(command, { timeoutMs: args.attemptTimeoutMs }));
        } finally {
          persisted.agentFinishedAt = Date.now();
        }
        // The raw stream is the transcript artifact (redacted) — persisted
        // even when the agent timed out or failed, so there is always evidence.
        const redactedStream = redactSecrets(agentResult.stdout, secretEnv);
        persisted.transcriptRef = await artifacts.writeTranscriptRaw(runId, attemptId, redactedStream);
        if (agentAdapter !== undefined) {
          const metrics = agentAdapter.parseStream(agentResult.stdout);
          persisted.tokensIn = metrics.tokensIn;
          persisted.tokensOut = metrics.tokensOut;
          persisted.turns = metrics.turns;
          if (metrics.costUsd !== undefined) persisted.costUsd = metrics.costUsd;
          // Surface-usage telemetry: extracted from the already-redacted
          // stream (only sanitized identifiers are stored). Offered surfaces
          // derive from the runtime's config + resolved MCP server names. An
          // unsupported vendor stream stays NULL — never a zero-filled object.
          const vendor = surfaceUsageVendor(experiment.agent.adapter);
          if (vendor !== null) {
            persisted.surfaceUsage = extractSurfaceUsage(
              vendor,
              redactedStream,
              observationConfig(surfaceUsageConfigFromRuntime(runtime.config, Object.keys(rewrittenServers ?? {})), runtime.observationTargets),
            );
          }
        }
        // `git add -A` stages new files so the diff captures them; diffing
        // the recorded baseline SHA (not HEAD) also captures any commits the
        // agent made itself.
        const captureDiff = async (): Promise<void> => {
          if (baselineSha === undefined) return;
          await mustExec(container, ["git", "add", "-A"]);
          const diff = (await mustExec(container, ["git", "diff", baselineSha])).stdout;
          persisted.diffRef = await artifacts.writeDiff(runId, attemptId, redactSecrets(diff, secretEnv));
        };
        if (agentResult.timedOut || agentResult.exitCode !== 0) {
          // The workspace is evidence of what the agent got done before it
          // died; a failed capture must not mask the attempt's own outcome.
          try {
            await captureDiff();
          } catch (err) {
            (options.log ?? console.log)(`attempt ${attemptId}: diff unavailable after failure: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (agentResult.timedOut) {
          // Graded timeout: runDocker restarted the killed container, so the
          // tree the agent left behind is exported and scored below.
          // captureDiff already ran above.
          await artifacts.writeError(runId, attemptId, `attempt timed out after ${args.attemptTimeoutMs}ms — container killed; workspace graded as left`);
          persisted.limitHit = "timeout";
        } else if (agentResult.exitCode !== 0) {
          const message = `agent command exited ${agentResult.exitCode}\n--- stderr ---\n${agentResult.stderr}`;
          await artifacts.writeError(runId, attemptId, redactSecrets(message, secretEnv));
          return { status: "error", error: `agent command exited ${agentResult.exitCode}`, errorKind: "agent" };
        } else {
          await inStage("environment", captureDiff);
        }

        // Export the workspace BEFORE scoring, with the container still alive:
        // file checks read the export, ctx.exec reaches into the live sandbox.
        try {
          await inStage("environment", () => deadline("export", environment?.budgets.exportMs ?? DEFAULT_BUDGETS.exportMs, async (signal) => {
            const kill = () => { void container.teardown(); };
            signal.addEventListener("abort", kill, { once: true });
            try { await container.exportWorkspace(paths.workspace); } finally { signal.removeEventListener("abort", kill); }
          }));
        } catch (err) {
          if (persisted.limitHit !== "timeout") throw err;
          // Nothing to score: `incomplete` keeps its meaning "no workspace".
          const error = `attempt timed out after ${args.attemptTimeoutMs}ms; workspace could not be exported`;
          await artifacts.writeError(runId, attemptId, `${error}: ${err instanceof Error ? err.message : String(err)}`);
          return { status: "incomplete", error };
        }
        return await scoreAttempt(options, loadedEval, experiment, entry, {
          runId,
          attemptId,
          workspaceDir: paths.workspace,
          agentOutput: extractAgentOutput(redactedStream),
          exec: (cmd, opts) => container.execInWorkspace(cmd, opts),
          cancel: () => container.teardown(),
          ...(provisioned?.env ? { provisionedEnv: provisioned.env } : {}),
        });
      } finally {
        // Teardown LAST — after export and scoring both resolved. A teardown
        // failure is captured, never thrown: it must not mask the result.
        if (egress) {
          try {
            const lines = (await egress.sidecar.logs()).split("\n").flatMap((line) => {
              try {
                const event = JSON.parse(line);
                if (event.type !== "egress" || event.decision !== "denied") return [];
                // Only hostname-level identifiers survive: never raw requests or query strings.
                const host = typeof event.host === "string" && /^[a-zA-Z0-9.*:[\]_-]+$/.test(event.host) ? event.host.slice(0, 253) : "invalid-host";
                return [JSON.stringify({ type: "egress", attempt_id: attemptId, host, decision: "denied", reason: event.reason })];
              } catch { return []; }
            });
            await artifacts.writeEgressDenials(runId, attemptId, lines);
          } catch (err) { containerTeardownFailure = `egress evidence unavailable: ${err instanceof Error ? err.message : String(err)}`; }
        }
        try {
          await container.teardown();
        } catch (err) {
          containerTeardownFailure = `container teardown failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await artifacts.writeError(runId, attemptId, message);
    disposition = { status: "error", error: message, errorKind: errorKindOf(err) };
  } finally {
    if (mcpNetwork && treatments.mcp?.sidecar) {
      try { await disconnectContainerNetwork(treatments.mcp.sidecar.id, mcpNetwork); } catch { containerTeardownFailure = "MCP network disconnect failed"; }
    }
    if (egress) {
      try { await egress.sidecar.teardown(); } catch { containerTeardownFailure = "egress sidecar teardown failed"; }
      try { await removeRunNetwork(egress.networkName); } catch { containerTeardownFailure = "egress network teardown failed"; }
    }
    if (sourceDir) {
      try { await rm(sourceDir, { recursive: true, force: true }); }
      catch { containerTeardownFailure = [containerTeardownFailure, "workspace source cleanup failed"].filter(Boolean).join("; "); }
    }
  }

  // Explicit teardown accounting: the attempt keeps its status and result;
  // any teardown failure is appended to its recorded error, never thrown.
  const failures: string[] = [];
  if (containerTeardownFailure !== undefined) failures.push(containerTeardownFailure);
  const provisionTeardownFailure = await attemptRuntimeTeardown(runtime, provisioned, provisionCtx, environment?.budgets.cleanupMs ?? options.budgets?.cleanupMs);
  if (provisionTeardownFailure !== undefined) failures.push(provisionTeardownFailure);
  if (failures.length > 0) {
    const note = failures.join("; ");
    const error = disposition.error !== undefined && disposition.error !== "" ? `${disposition.error}; ${note}` : note;
    await artifacts.writeError(runId, attemptId, error);
    disposition = { ...disposition, error };
  }
  return disposition;
}

async function scoreAttempt(
  options: ExecuteRunV3Options,
  loadedEval: LoadedEval,
  experiment: Experiment,
  entry: AttemptPlan,
  args: {
    runId: string;
    attemptId: string;
    workspaceDir: string;
    exec?: (cmd: string[], opts?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
    /** The provisioned env, when the runtime provisioned this attempt. */
    provisionedEnv?: Record<string, string>;
    cancel?: () => Promise<void>;
    agentOutput?: import("../evals/types.ts").AgentOutput;
  },
): Promise<AttemptDisposition> {
  try {
    return await deadline("scoring", options.budgets?.scoreMs ?? DEFAULT_BUDGETS.scoreMs, async (signal) => {
    const cancel = () => { void args.cancel?.(); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
    // Runtime-provided capabilities join the scorer's context here; a helper
    // the runtime does not provide throws at call time, naming the
    // capability and the experiment (context.ts).
    const capabilities =
      experiment.runtime.scorerCapabilities?.({
        signal,
        attemptId: args.attemptId,
        evalId: entry.evalId,
        experimentId: entry.experimentId,
        metadata: loadedEval.metadata,
        env: args.provisionedEnv ?? {},
      }) ?? {};
    const result = await scoreInWorker(loadedEval.scorerPath,
      buildEvalContext({
        signal,
        ...(args.agentOutput ? { agentOutput: args.agentOutput } : {}),
        redact: async (text) => redactSecrets(redactSecrets(text, hostSecretEnv()), args.provisionedEnv ?? {}),
        evalId: entry.evalId,
        experimentId: entry.experimentId,
        trialIndex: entry.trialIndex,
        ...(loadedEval.metadata.framework !== undefined ? { framework: loadedEval.metadata.framework } : {}),
        workspaceDir: args.workspaceDir,
        ...(args.exec ? { exec: args.exec } : {}),
        ...(capabilities.query ? { query: capabilities.query } : {}),
        ...(capabilities.getClient ? { getClient: capabilities.getClient } : {}),
      }), signal,
    );
    if (!validEvalResult(result)) throw new Error("scorer returned an invalid EvalResult");
    return { status: "completed", result };
    } finally { signal.removeEventListener("abort", cancel); }
    });
  } catch (err) {
    const message = redactSecrets(redactSecrets(`scorer threw: ${err instanceof Error ? err.message : String(err)}`, hostSecretEnv()), args.provisionedEnv ?? {});
    await options.artifacts.writeError(args.runId, args.attemptId, message);
    const judgments = (err as { judgments?: import("../evals/types.ts").JudgeRecord[] })?.judgments;
    const judgeRecords = judgments && validEvalResult({passed:false,checks:[],judgments}) ? judgments : undefined;
    return { status: "error", error: message, errorKind: "scorer", ...(judgeRecords ? {judgeRecords} : {}) };
  }
}

/** Supported stream shapes only; unavailable final reports stay null. */
function extractAgentOutput(raw: string): import("../evals/types.ts").AgentOutput {
  let finalReport: string | null = null;
  for (const line of raw.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && typeof event.result === "string") finalReport = event.result;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") finalReport = event.item.text;
      const text = event.type === "assistant" ? event.message?.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : undefined;
      if (text) finalReport = text;
    } catch { /* unsupported event */ }
  }
  return { finalReport: finalReport?.slice(0, 131072) ?? null, transcript: raw.slice(0, 131072), truncated: raw.length > 131072 || (finalReport?.length ?? 0) > 131072 };
}
