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
 * + proxy sidecar and MCP auth sidecar are run-scoped, provisioning is
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

import { cp, mkdtemp, rm } from "node:fs/promises";
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
import { importEvalScorer } from "../evals/discovery.ts";
import type { EvalResult, LoadedEval } from "../evals/types.ts";
import type { AgentSpec, Experiment, LoadedExperiment, Runtime } from "../experiments/types.ts";
import { canonicalJson } from "../identity-diff.ts";
import {
  createAttemptContainer,
  createRunNetwork,
  inspectContainerIp,
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
import { composeAllowlistFromHosts } from "../isolation/proxy/allowlist.ts";
import { ulid } from "../ids.ts";
import { attemptIdentityHash, buildRunManifest, type RunManifest, type RuntimeImageIdentity } from "../manifest.ts";
import { isMovingModelAlias } from "../model-identity.ts";
import type { AttemptPlan } from "../plan.ts";
import type { ProvisionedEnvironment, RuntimeProvisionContext } from "../runtime/types.ts";
import { collectProviderKeys, redactSecrets, validateProviderKeys, type ProviderKeyProbe } from "../secrets.ts";
import { ArtifactsStore } from "../store/artifacts.ts";
import type { NewAttempt, ResultsStore, RunConfig } from "../store/db.ts";
import { compareGroups } from "../experiments/groups.ts";
import {
  extractSurfaceUsage,
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
  /**
   * Container agent adapter factories by name, constructed per experiment
   * from its `agent` spec. Defaults to the built-in claude/codex adapters.
   * A container experiment without a scripted `runtime.command` resolves its
   * agent here; unknown names fail fast before any container work.
   */
  containerAdapters?: Record<string, (agent: AgentSpec) => ContainerAgentAdapter>;
  /**
   * Route container egress through the run's allowlisting proxy sidecar.
   * Applies to container experiments whose runtime declares `egressHosts` —
   * their containers join an internal network whose only way out is the
   * proxy. Off by default (existing behavior: policy only when enabled).
   */
  egressProxy?: boolean;
  attemptTimeoutMs?: number;
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
  status: "completed" | "incomplete" | "error";
  result?: EvalResult;
  error?: string;
}

function defaultHostAdapters(): Record<string, AgentAdapter> {
  const echo = new EchoAdapter();
  return { [echo.name]: echo };
}

function defaultContainerAdapters(): Record<string, (agent: AgentSpec) => ContainerAgentAdapter> {
  return {
    claude: (agent) => new ClaudeCodeAdapter("claude", { model: agent.model, reasoning: agent.reasoning }),
    codex: (agent) => new CodexAdapter("codex", { model: agent.model, reasoning: agent.reasoning }),
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

/**
 * Run-scoped treatment infrastructure, assembled from what the planned
 * container experiments' runtimes declare: one internal network + egress
 * proxy sidecar per run (when enabled), one MCP auth-proxy sidecar per run
 * (when any runtime declares authed servers). Mirrors the legacy
 * orchestrator's topology — per-attempt sidecars would double the container
 * count for no boundary gain.
 */
interface TreatmentRuntimes {
  egress?: { networkName: string; sidecar: EgressSidecar; allowlist: string[] };
  mcp?: {
    /** Absent when every declared server is unauthenticated. */
    sidecar?: McpSidecar;
    /** The original configs (rotated-token persistence needs `auth`). */
    servers: Record<string, McpServerConfig>;
    /** Credential-free (rewritten) server maps, per experiment id. */
    serversByExperiment: Map<string, Record<string, McpServerConfig>>;
  };
}

interface SetupTreatmentArgs {
  plan: AttemptPlan[];
  evalsById: Map<string, LoadedEval>;
  experimentsById: Map<string, Experiment>;
  /** Resolved container agent adapters by experiment id (agent-driven experiments only). */
  containerAgents: Map<string, ContainerAgentAdapter>;
  runId: string;
  egressProxy: boolean;
  log: (line: string) => void;
}

/**
 * Start the run's treatment infrastructure. Fail-fast by design: a missing
 * MCP credentials file or an invalid egress host aborts here, BEFORE the run
 * row exists or any attempt container is created. A partial failure tears
 * down whatever already started — setup never leaks a sidecar or network.
 */
async function setupTreatmentRuntimes(args: SetupTreatmentArgs): Promise<TreatmentRuntimes> {
  const { plan, evalsById, experimentsById, runId, log } = args;
  const state: TreatmentRuntimes = {};

  const containerExperimentIds = [
    ...new Set(
      plan
        .map((entry) => entry.experimentId)
        .filter((id) => (experimentsById.get(id) as Experiment).runtime.kind === "container"),
    ),
  ].sort((a, b) => a.localeCompare(b));

  // --- egress: union allowlist across every planned (experiment, eval) pair.
  // Two layers compose: the runtime's own hosts (product API, registries) and
  // the agent adapter's harness-default hosts (its LLM/vendor endpoints) ---
  if (args.egressProxy) {
    const hosts: string[] = [];
    let anyEgress = false;
    for (const entry of plan) {
      const runtime = (experimentsById.get(entry.experimentId) as Experiment).runtime;
      if (runtime.kind !== "container" || runtime.egressHosts === undefined) continue;
      anyEgress = true;
      hosts.push(...runtime.egressHosts((evalsById.get(entry.evalId) as LoadedEval).metadata));
      hosts.push(...(args.containerAgents.get(entry.experimentId)?.egressHosts ?? []));
    }
    if (anyEgress) {
      const allowlist = composeAllowlistFromHosts(hosts);
      const networkName = await createRunNetwork(runId);
      let sidecar: EgressSidecar;
      try {
        sidecar = await startEgressSidecar({ runId, networkName, allowlist, image: EGRESS_PROXY_IMAGE });
      } catch (err) {
        await removeRunNetwork(networkName); // a failed start never leaks the network
        throw err;
      }
      state.egress = { networkName, sidecar, allowlist };
      log(
        `egress proxy: ${allowlist.length} allowlisted host(s), sidecar ${sidecar.id.slice(0, 12)} ` +
          `on ${networkName} — treatment containers have no other route out`,
      );
    }
  }

  // --- mcp: merge every runtime-declared server map; one sidecar per run ---
  const merged: Record<string, McpServerConfig> = {};
  const declaredByExperiment = new Map<string, Record<string, McpServerConfig>>();
  try {
    for (const experimentId of containerExperimentIds) {
      const runtime = (experimentsById.get(experimentId) as Experiment).runtime;
      if (runtime.mcpServers === undefined) continue;
      const servers = runtime.mcpServers();
      declaredByExperiment.set(experimentId, servers);
      for (const [name, spec] of Object.entries(servers)) {
        const existing = merged[name];
        if (existing !== undefined && canonicalJson(existing) !== canonicalJson(spec)) {
          throw new Error(
            `mcp server "${name}" is declared with conflicting configs by multiple experiment runtimes — rename one`,
          );
        }
        merged[name] = spec;
      }
    }

    if (declaredByExperiment.size > 0) {
      let sidecar: McpSidecar | undefined;
      // The sidecar's address differs by vantage point: experiments under
      // the egress treatment reach it on the run's internal network, while
      // experiments outside it (default bridge) need its bridge address —
      // the sidecar always sits on both when the internal network exists.
      let internalBase: string | undefined;
      let bridgeBase: string | undefined;
      if (Object.keys(authedMcpServers(merged)).length > 0) {
        // Fail-fast: a missing/incomplete credentials file means every MCP
        // attempt is a guaranteed auth error — refuse before any container work.
        const material = readMcpAuthMaterialFromConfig(merged);
        sidecar = await startMcpSidecar({
          runId,
          ...(state.egress ? { networkName: state.egress.networkName } : {}),
          image: MCP_PROXY_IMAGE,
          upstreams: material.upstreams,
          refreshTokens: material.refreshTokens,
        });
        internalBase = `http://${sidecar.ip}:${sidecar.port}`;
        bridgeBase = state.egress
          ? `http://${await inspectContainerIp(sidecar.id, "bridge")}:${sidecar.port}`
          : internalBase;
        log(
          `mcp auth proxy: sidecar ${sidecar.id.slice(0, 12)} at ${sidecar.ip}:${sidecar.port} — ` +
            `attempt containers see credential-free proxy URLs`,
        );
      }
      state.mcp = {
        ...(sidecar !== undefined ? { sidecar } : {}),
        servers: merged,
        serversByExperiment: new Map(
          [...declaredByExperiment].map(([id, servers]) => {
            const onInternalNetwork =
              state.egress !== undefined && (experimentsById.get(id) as Experiment).runtime.egressHosts !== undefined;
            // Without a sidecar every server is unauthed and the rewrite is
            // an auth-stripping identity map — the base is never used.
            const proxyBase = (onInternalNetwork ? internalBase : bridgeBase) ?? "http://unused";
            return [id, rewriteMcpServerConfigs(servers, proxyBase)];
          }),
        ),
      };
    }
  } catch (err) {
    // MCP setup failed after egress came up: tear egress down before
    // rethrowing (state.mcp is only assigned once the whole block succeeds).
    await teardownTreatmentRuntimes(state, log);
    throw err;
  }

  return state;
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
          `run \`quickstudy clean\` to remove leaked resources`,
      );
    }
  }
  if (state.egress) {
    try {
      await state.egress.sidecar.teardown();
      await removeRunNetwork(state.egress.networkName);
    } catch (err) {
      log(
        `warning: egress proxy teardown failed (${err instanceof Error ? err.message : String(err)}) — ` +
          `run \`quickstudy clean\` to remove leaked resources`,
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
    if (declared > 0) surfaces[experimentId] = offered;
  }
  return Object.keys(surfaces).length > 0 ? surfaces : undefined;
}

/** Race a host adapter against the wall clock; a loss is `incomplete`, not an error. */
async function withTimeout(
  work: Promise<AttemptOutcome>,
  timeoutMs: number,
): Promise<{ outcome: AttemptOutcome } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([work.then((outcome) => ({ outcome })), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function executeRunV3(options: ExecuteRunV3Options): Promise<RunSummaryV3> {
  const { store, artifacts, plan } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const hostAdapters = options.hostAdapters ?? defaultHostAdapters();

  const evalsById = new Map(options.evals.map((entry) => [entry.metadata.id, entry]));
  const experimentsById = new Map(options.experiments.map((entry) => [entry.experiment.id, entry.experiment]));
  const containerAdapterFactories = options.containerAdapters ?? defaultContainerAdapters();

  // Fail fast BEFORE the first attempt: every plan entry must resolve, every
  // experiment must be executable (a scripted command or a known container
  // agent adapter), and every provider key must be present on the host.
  const containerAgents = new Map<string, ContainerAgentAdapter>();
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
      if ((experiment.runtime.command ?? []).length === 0 && !containerAgents.has(experiment.id)) {
        const adapter = resolveContainerAdapter(experiment, containerAdapterFactories);
        // Provider keys are validated here — before any run row, sidecar, or
        // container exists — and injected into the attempt container at create.
        collectProviderKeys([adapter]);
        containerAgents.set(experiment.id, adapter);
      }
      const loadedEval = evalsById.get(entry.evalId) as LoadedEval;
      const image = experiment.runtime.image ?? experiment.runtime.containerImage?.(loadedEval.metadata);
      if (image === undefined || image === "") {
        throw new Error(
          `experiment "${experiment.id}" resolves no container image for eval "${entry.evalId}" — ` +
            `set runtime.image or a containerImage(metadata) resolver`,
        );
      }
      let tags = imageTagsByExperiment.get(experiment.id);
      if (tags === undefined) imageTagsByExperiment.set(experiment.id, (tags = new Set()));
      tags.add(image);
    }
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
    manifest = buildRunManifest({ evals: options.evals, experiments: options.experiments, images, cliVersions });
  }
  const runId = ulid();

  // Treatment infrastructure comes up BEFORE the run row: setup is fail-fast
  // (missing MCP credentials, invalid egress hosts), and what a run could
  // reach is part of its recorded configuration.
  const treatments = await setupTreatmentRuntimes({
    plan,
    evalsById,
    experimentsById,
    containerAgents,
    runId,
    egressProxy: options.egressProxy ?? false,
    log,
  });

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
      trials: options.config?.trials ?? plan.reduce((max, entry) => Math.max(max, entry.trialIndex + 1), 1),
      evalIds: options.config?.evalIds ?? [...new Set(plan.map((entry) => entry.evalId))],
      experimentIds: options.config?.experimentIds ?? [...new Set(plan.map((entry) => entry.experimentId))],
      ...(options.config?.evalsRoot !== undefined ? { evalsRoot: options.config.evalsRoot } : {}),
      ...(options.config?.experimentsRoot !== undefined ? { experimentsRoot: options.config.experimentsRoot } : {}),
      egress: treatments.egress
        ? { proxy: true, allowlist: treatments.egress.allowlist }
        : { proxy: false, allowlist: [] },
      // Comparison groups (with their withhold-and-diff state) are recorded
      // ON THE RUN: the manifest holds runtime config only as an opaque hash,
      // so the report could never recompute this after the fact.
      groups: compareGroups(options.experiments.map((entry) => entry.experiment), manifest),
      ...(offeredSurfaces !== undefined ? { surfaces: offeredSurfaces } : {}),
    };
    store.insertRun({ id: runId, startedAt: Date.now(), config, manifest });

    const summary: RunSummaryV3 = { runId, total: plan.length, passed: 0, failed: 0, incomplete: 0, errors: 0 };

    for (const entry of plan) {
      const loadedEval = evalsById.get(entry.evalId) as LoadedEval;
      const experiment = experimentsById.get(entry.experimentId) as Experiment;
      const attemptId = ulid();
      const startedAt = Date.now();

      const persisted: NewAttempt = {
        id: attemptId,
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
            ? await runHostAttemptV3(options, hostAdapters, loadedEval, experiment, entry, { runId, attemptId, attemptTimeoutMs, persisted })
            : await runContainerAttemptV3(
                options,
                loadedEval,
                experiment,
                entry,
                { runId, attemptId, attemptTimeoutMs, persisted },
                treatments,
                containerAgents.get(experiment.id),
              );
      } catch (err) {
        // An attempt failure never aborts the run: persist the error and move on.
        const message = err instanceof Error ? err.message : String(err);
        await artifacts.writeError(runId, attemptId, message);
        disposition = { status: "error", error: message };
      }

      persisted.status = disposition.status;
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
        `attempt ${attemptId} (${entry.evalId} × ${entry.experimentId} trial ${entry.trialIndex}): ` +
          `${disposition.status}${disposition.result ? ` — ${disposition.result.passed ? "passed" : "failed"}` : ""}`,
      );
    }

    store.finishRun(runId, Date.now());
    return summary;
  } finally {
    await teardownTreatmentRuntimes(treatments, log);
  }
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

/** Prepare the attempt's starting state: a copy of `local/`, or empty (tools-only evals). */
async function prepWorkspaceSource(loadedEval: LoadedEval): Promise<string> {
  const sourceDir = await mkdtemp(join(tmpdir(), "quickstudy-v3-source-"));
  if (loadedEval.localDir !== null) {
    await cp(loadedEval.localDir, sourceDir, { recursive: true });
  }
  return sourceDir;
}

interface AttemptArgs {
  runId: string;
  attemptId: string;
  attemptTimeoutMs: number;
  persisted: NewAttempt;
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

  const sourceDir = await prepWorkspaceSource(loadedEval);
  const scratchDir = await mkdtemp(join(tmpdir(), "quickstudy-v3-attempt-"));
  try {
    const raced = await withTimeout(
      adapter.runAttempt({
        runId,
        attemptId,
        fixtureDir: sourceDir,
        workspaceDir: scratchDir,
        prompt: loadedEval.promptBody,
        trialIndex: entry.trialIndex,
      }),
      args.attemptTimeoutMs,
    );
    if ("timedOut" in raced) {
      await artifacts.writeError(runId, attemptId, `attempt timed out after ${args.attemptTimeoutMs}ms`);
      return { status: "incomplete", error: `attempt timed out after ${args.attemptTimeoutMs}ms` };
    }

    const { outcome } = raced;
    persisted.transcriptRef = await artifacts.writeTranscript(runId, attemptId, outcome.transcript);
    persisted.diffRef = await artifacts.writeDiff(runId, attemptId, outcome.diff);
    persisted.tokensIn = outcome.metrics.tokensIn;
    persisted.tokensOut = outcome.metrics.tokensOut;
    persisted.turns = outcome.metrics.turns;
    if (outcome.metrics.costUsd !== undefined) persisted.costUsd = outcome.metrics.costUsd;

    // Export FIRST, then score against the export (no live sandbox exists on
    // the host path — exec runs in the exported workspace directory).
    const workspaceDir = await artifacts.exportWorkspace(runId, attemptId, scratchDir);
    return await scoreAttempt(options, loadedEval, experiment, entry, { runId, attemptId, workspaceDir });
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
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
): Promise<string | undefined> {
  try {
    if (provisioned?.teardown) await provisioned.teardown();
    else if (runtime.teardown) await runtime.teardown(ctx);
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
      provisioned = await runtime.provision(provisionCtx);
    } catch (err) {
      const message = `provision failed: ${err instanceof Error ? err.message : String(err)}`;
      // Teardown is still attempted — a provisioner may fail after creating
      // some of what its runtime-level teardown knows how to scrub.
      const teardownFailure = await attemptRuntimeTeardown(runtime, undefined, provisionCtx);
      const error = teardownFailure !== undefined ? `${message}; ${teardownFailure}` : message;
      await artifacts.writeError(runId, attemptId, error);
      return { status: "error", error };
    }
  }

  const sourceDir = await prepWorkspaceSource(loadedEval);
  let containerTeardownFailure: string | undefined;
  let disposition: AttemptDisposition;
  try {
    disposition = await (async (): Promise<AttemptDisposition> => {
      const image = runtime.image ?? (runtime.containerImage?.(loadedEval.metadata) as string);

      // --- treatment env: everything rides the 0600 env-file, never argv ---
      const env: Record<string, string> = { ...provisioned?.env };
      // Only the SECRET-bearing subset feeds redaction: provisioned
      // credentials and provider keys. Treatment plumbing (PATH, proxy env,
      // the credential-free MCP server map) is diagnostic, not secret —
      // redacting it would blind the transcript reader for no hygiene gain.
      const secretEnv: Record<string, string> = { ...provisioned?.env };
      const pathDir = runtime.pathTreatment?.();
      if (pathDir !== undefined && pathDir !== "") {
        // Only this treatment exposes the directory; other treatments keep
        // the image-default PATH and cannot accidentally discover its tools.
        env["PATH"] = `${pathDir}:${NORMAL_CONTAINER_PATH}`;
      }
      const rewrittenServers = treatments.mcp?.serversByExperiment.get(experiment.id);
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
      const egress = runtime.egressHosts !== undefined ? treatments.egress : undefined;
      if (egress) {
        const proxyEnv = egress.sidecar.proxyEnv();
        const mcpSidecar = treatments.mcp?.sidecar;
        if (mcpSidecar) {
          // The mcp sidecar shares the internal network — its address must
          // bypass the egress proxy, which refuses raw-IP targets by design.
          const noProxy = `${proxyEnv["NO_PROXY"]},${mcpSidecar.ip}`;
          proxyEnv["NO_PROXY"] = noProxy;
          proxyEnv["no_proxy"] = noProxy;
        }
        Object.assign(env, proxyEnv);
      }

      const paths = await artifacts.prepareAttempt(runId, attemptId);
      const container = await createAttemptContainer({
        image,
        env,
        resultsDir: paths.attemptDir,
        attemptId,
        fixtureDir: sourceDir,
        // Under the egress treatment the internal network replaces the
        // default bridge: the proxy sidecar is the only path to the world.
        ...(egress ? { network: egress.networkName } : {}),
      });
      try {
        let command: string[];
        let baselineSha: string | undefined;
        if (agentAdapter !== undefined) {
          // --- real agent path: baseline commit -> treatment files -> CLI ---
          // Baseline commit: the diff artifact is git's comparison of the
          // final workspace against this exact commit. The SHA is recorded
          // (not just HEAD) so an agent that makes its own commits cannot
          // move the baseline out from under the diff.
          const gitAvailable = (await container.execInWorkspace(["git", "--version"])).exitCode === 0;
          if (gitAvailable) {
            await mustExec(container, ["git", "init", "-q"]);
            await mustExec(container, ["git", "add", "-A"]);
            await mustExec(container, [
              "git", "-c", "user.name=quickstudy", "-c", "user.email=quickstudy@localhost",
              "commit", "-q", "--allow-empty", "-m", "quickstudy fixture baseline",
            ]);
            baselineSha = (await mustExec(container, ["git", "rev-parse", "HEAD"])).stdout.trim();
          } else {
            (options.log ?? console.log)(
              `attempt ${attemptId}: git is unavailable in image "${image}" — diff.patch will be empty ` +
                `(the agent-runtime image ships git; only bare test images lack it)`,
            );
          }

          const promptCtx: ContainerAttemptContext = {
            runId,
            attemptId,
            prompt: loadedEval.promptBody,
            trialIndex: entry.trialIndex,
            ...(rewrittenServers !== undefined ? { mcpServers: rewrittenServers } : {}),
            webPolicy: runtime.webPolicy?.() ?? "native-web-blocked",
          };
          // Treatment config files (e.g. the MCP treatment's vendor config).
          // The prompt itself is byte-identical across experiments.
          for (const [path, content] of Object.entries(agentAdapter.setupFiles(promptCtx))) {
            await container.writeFile(path, content);
          }
          command = agentAdapter.command(promptCtx);
        } else {
          command = runtime.command as string[];
        }

        const agentResult = await container.execInWorkspace(command, { timeoutMs: args.attemptTimeoutMs });
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
              surfaceUsageConfigFromRuntime(runtime.config, Object.keys(rewrittenServers ?? {})),
            );
          }
        }
        if (agentResult.timedOut) {
          await artifacts.writeError(runId, attemptId, `attempt timed out after ${args.attemptTimeoutMs}ms — container removed`);
          return { status: "incomplete", error: `attempt timed out after ${args.attemptTimeoutMs}ms` };
        }
        if (agentResult.exitCode !== 0) {
          const message = `agent command exited ${agentResult.exitCode}\n--- stderr ---\n${agentResult.stderr}`;
          await artifacts.writeError(runId, attemptId, redactSecrets(message, secretEnv));
          return { status: "error", error: `agent command exited ${agentResult.exitCode}` };
        }

        if (baselineSha !== undefined) {
          // `git add -A` stages new files so the diff captures them; diffing
          // the recorded baseline SHA (not HEAD) also captures any commits
          // the agent made itself.
          await mustExec(container, ["git", "add", "-A"]);
          const diff = (await mustExec(container, ["git", "diff", baselineSha])).stdout;
          persisted.diffRef = await artifacts.writeDiff(runId, attemptId, redactSecrets(diff, secretEnv));
        }

        // Export the workspace BEFORE scoring, with the container still alive:
        // file checks read the export, ctx.exec reaches into the live sandbox.
        await container.exportWorkspace(paths.workspace);
        return await scoreAttempt(options, loadedEval, experiment, entry, {
          runId,
          attemptId,
          workspaceDir: paths.workspace,
          exec: (cmd, opts) => container.execInWorkspace(cmd, opts),
          ...(provisioned?.env ? { provisionedEnv: provisioned.env } : {}),
        });
      } finally {
        // Teardown LAST — after export and scoring both resolved. A teardown
        // failure is captured, never thrown: it must not mask the result.
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
    disposition = { status: "error", error: message };
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }

  // Explicit teardown accounting: the attempt keeps its status and result;
  // any teardown failure is appended to its recorded error, never thrown.
  const failures: string[] = [];
  if (containerTeardownFailure !== undefined) failures.push(containerTeardownFailure);
  const provisionTeardownFailure = await attemptRuntimeTeardown(runtime, provisioned, provisionCtx);
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
  },
): Promise<AttemptDisposition> {
  try {
    const scorer = await importEvalScorer(loadedEval.scorerPath);
    // Runtime-provided capabilities join the scorer's context here; a helper
    // the runtime does not provide throws at call time, naming the
    // capability and the experiment (context.ts).
    const capabilities =
      experiment.runtime.scorerCapabilities?.({
        attemptId: args.attemptId,
        evalId: entry.evalId,
        experimentId: entry.experimentId,
        metadata: loadedEval.metadata,
        env: args.provisionedEnv ?? {},
      }) ?? {};
    const result = await scorer(
      buildEvalContext({
        evalId: entry.evalId,
        experimentId: entry.experimentId,
        trialIndex: entry.trialIndex,
        ...(loadedEval.metadata.framework !== undefined ? { framework: loadedEval.metadata.framework } : {}),
        workspaceDir: args.workspaceDir,
        ...(args.exec ? { exec: args.exec } : {}),
        ...(capabilities.query ? { query: capabilities.query } : {}),
        ...(capabilities.getClient ? { getClient: capabilities.getClient } : {}),
      }),
    );
    return { status: "completed", result };
  } catch (err) {
    const message = `scorer threw: ${err instanceof Error ? err.message : String(err)}`;
    await options.artifacts.writeError(args.runId, args.attemptId, message);
    return { status: "error", error: message };
  }
}
