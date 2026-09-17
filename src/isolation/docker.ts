/**
 * Container lifecycle for one attempt, wrapping the Docker CLI via
 * `Bun.spawn` — no daemon SDK dependency, so any Docker-compatible daemon
 * works (Colima, OrbStack, Docker Desktop, Linux).
 *
 * The isolation contract, made concrete:
 *   - fresh filesystem per attempt (a new container from the image);
 *   - the ONLY host mount is the per-attempt results directory at /results
 *     ("write-only" in the sense that the harness never reads host state
 *     through it — it only collects outputs);
 *   - the fixture is delivered via `docker cp`, never a mount;
 *   - secrets arrive as environment variables at container create (via a
 *     transient env-file so values never appear in host process listings);
 *   - every container carries a `quickstudy.attempt=<id>` label so teardown
 *     is verifiable: `docker ps -aq --filter label=quickstudy.attempt` must
 *     be empty after a sweep;
 *   - teardown is `docker rm -f` — kill and remove in one step.
 */

import { mkdir, mkdtemp, rm, writeFile, cp, readdir, lstat, readlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sanitizeServerName, type McpUpstream } from "./mcp-proxy/server.ts";
import { EXCLUDED_WORKSPACE_DIRS } from "../store/artifacts.ts";

/** The label key every attempt container carries. */
export const ATTEMPT_LABEL = "quickstudy.attempt";
/**
 * The label key carried by per-run resources: the internal egress network
 * and the egress-proxy sidecar container. Same teardown-accounting pattern
 * as ATTEMPT_LABEL — `quickstudy clean` sweeps by it.
 */
export const RUN_LABEL = "quickstudy.run";
/** Where the fixture lands and the agent works, inside the container. */
export const CONTAINER_WORKSPACE = "/workspace";
/** The sole host mount, inside the container. */
export const CONTAINER_RESULTS = "/results";

/** A docker CLI invocation failed. */
export class DockerError extends Error {
  readonly args: string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: string[], exitCode: number, stderr: string) {
    super(`docker ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
    this.name = "DockerError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was killed by its wall-clock timeout. */
  timedOut: boolean;
}

/** Run `docker <args>`, capturing output. Never throws for non-zero exits. */
async function runDocker(
  args: string[],
  opts: { timeoutMs?: number; stdin?: string } = {},
): Promise<ExecResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, opts.timeoutMs ?? 30_000);
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

/** Run `docker <args>` and throw a DockerError on non-zero exit. */
async function mustDocker(args: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<ExecResult> {
  const result = await runDocker(args, opts);
  if (result.exitCode !== 0) throw new DockerError(args, result.exitCode, result.stderr);
  return result;
}

/**
 * `docker rm -f` stderr that still means "the container is gone": it was
 * already removed, or another caller's removal is in flight (a deadline kill
 * racing the attempt's final teardown) and the daemon will finish that one.
 */
export const CONTAINER_GONE_STDERR = /no such container|already in progress/i;

/** `docker rm -f <id>`, idempotent per CONTAINER_GONE_STDERR. */
async function removeContainer(id: string): Promise<void> {
  const result = await runDocker(["rm", "-f", id]);
  if (result.exitCode !== 0 && !CONTAINER_GONE_STDERR.test(result.stderr)) {
    throw new DockerError(["rm", "-f", id], result.exitCode, result.stderr);
  }
}

/** Preflight: is a Docker daemon reachable at all? */
export async function dockerDaemonReachable(): Promise<boolean> {
  const result = await runDocker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
  return result.exitCode === 0;
}

/** Preflight: does the image exist locally? */
export async function imageExists(image: string): Promise<boolean> {
  const result = await runDocker(["image", "inspect", image]);
  return result.exitCode === 0;
}

export interface DockerImageIdentity {
  tag: string;
  id: string;
  repoDigests: string[];
}

/** Resolve a mutable image tag to the content identity Docker will execute. */
export async function inspectImageIdentity(image: string): Promise<DockerImageIdentity> {
  const result = await mustDocker(["image", "inspect", image, "--format", "{{json .}}"]);
  const parsed = JSON.parse(result.stdout) as { Id?: string; RepoDigests?: string[] };
  if (!parsed.Id) throw new Error(`docker image inspect returned no Id for "${image}"`);
  return { tag: image, id: parsed.Id, repoDigests: [...(parsed.RepoDigests ?? [])].sort() };
}

/** Run a harmless version probe in an image during preflight. */
export async function inspectImageCommand(image: string, command: readonly string[]): Promise<string> {
  if (command.length === 0) throw new Error("image version command must not be empty");
  const [entrypoint, ...args] = command;
  const result = await mustDocker(["run", "--rm", "--entrypoint", entrypoint as string, image, ...args]);
  const version = `${result.stdout}\n${result.stderr}`.trim();
  if (version === "") throw new Error(`version command ${command.join(" ")} returned no output in image "${image}"`);
  return version;
}

/** All containers (running or exited) carrying the attempt label. Full ids. */
export async function listAttemptContainers(): Promise<string[]> {
  const result = await mustDocker(["ps", "-aq", "--no-trunc", "--filter", `label=${ATTEMPT_LABEL}`]);
  return result.stdout.split("\n").filter((line) => line !== "");
}

/**
 * Force-remove every `quickstudy.attempt`-labeled container — the
 * `quickstudy clean` sweep, also run at sweep start so an earlier hard-killed
 * harness never leaks containers into this run's teardown check.
 */
export async function removeAttemptContainers(): Promise<number> {
  const ids = await listAttemptContainers();
  if (ids.length === 0) return 0;
  await mustDocker(["rm", "-f", ...ids]);
  return ids.length;
}

export interface CreateAttemptContainerOptions {
  image: string;
  /** Provider keys + per-attempt runtime credentials. Values never hit argv. */
  env: Record<string, string>;
  /** Host directory mounted at /results — the sole mount. */
  resultsDir: string;
  /** Recorded as the `quickstudy.attempt` label value. */
  attemptId: string;
  /** Host fixture directory, delivered via `docker cp` (never a mount). */
  fixtureDir: string;
  /**
   * Docker network to attach INSTEAD of the default bridge. The egress-proxy
   * run mode passes the run's internal network here: no default route out —
   * the proxy sidecar is the container's only path to the world.
   */
  network?: string;
}

export interface AttemptContainer {
  id: string;
  /** Run a command in /workspace inside the container. Never throws for non-zero exits. */
  execInWorkspace(cmd: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** Write a file inside the container (parent directories created). */
  writeFile(path: string, content: string): Promise<void>;
  /** Copy /workspace to a host directory, excluding node_modules/vendor/.venv. */
  exportWorkspace(toDir: string): Promise<void>;
  /** `docker rm -f` — kill and remove. Idempotent. */
  teardown(): Promise<void>;
}

/**
 * Create and start one attempt container: labeled, env-injected, with the
 * per-attempt results directory as its only mount, then `docker cp` the
 * fixture into /workspace. On any failure the partial container is removed
 * before the error propagates — a failed create never leaks a container.
 */
export async function createAttemptContainer(opts: CreateAttemptContainerOptions): Promise<AttemptContainer> {
  // Secrets travel via a transient env-file, not argv (argv is visible in
  // host process listings while `docker run` executes).
  const envDir = await mkdtemp(join(tmpdir(), "quickstudy-env-"));
  const envFile = join(envDir, "attempt.env");
  const lines = Object.entries(opts.env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid environment variable name "${key}"`);
    if (value.includes("\n")) throw new Error(`environment variable "${key}" contains a newline`);
    return `${key}=${value}`;
  });
  await writeFile(envFile, lines.join("\n") + (lines.length > 0 ? "\n" : ""), { mode: 0o600 });

  let id: string;
  try {
    const created = await mustDocker([
      "run",
      "-d",
      "--label",
      `${ATTEMPT_LABEL}=${opts.attemptId}`,
      "--env-file",
      envFile,
      "-v",
      `${resolve(opts.resultsDir)}:${CONTAINER_RESULTS}`,
      "-w",
      CONTAINER_WORKSPACE,
      ...(opts.network !== undefined ? ["--network", opts.network] : []),
      opts.image,
      "sleep",
      "infinity",
    ]);
    id = created.stdout.trim();
  } catch (err) {
    // `docker run` can fail AFTER creating the container (start failure) —
    // sweep anything already labeled for this attempt so a failed create
    // never orphans a container.
    const leftover = await runDocker(["ps", "-aq", "--no-trunc", "--filter", `label=${ATTEMPT_LABEL}=${opts.attemptId}`]);
    const ids = leftover.stdout.split("\n").filter((line) => line !== "");
    if (ids.length > 0) await runDocker(["rm", "-f", ...ids]);
    throw err;
  } finally {
    await rm(envDir, { recursive: true, force: true });
  }

  const container: AttemptContainer = {
    id,
    execInWorkspace: async (cmd, execOpts = {}) => {
      const result = await runDocker(["exec", "-w", CONTAINER_WORKSPACE, id, ...cmd], execOpts);
      // Killing only the Docker client leaves the exec process alive in the
      // daemon. Stop the whole attempt on timeout, including descendants —
      // then restart PID 1 (`sleep infinity`) so the dead attempt's workspace
      // stays exec-able for the diff. Descendants do not come back with it.
      if (result.timedOut) {
        await runDocker(["kill", id], { timeoutMs: 10_000 });
        await runDocker(["start", id], { timeoutMs: 10_000 });
      }
      return result;
    },
    writeFile: async (path, content) => {
      // `$1` positional keeps the target path out of shell interpolation.
      await mustDocker(["exec", "-i", id, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], {
        stdin: content,
      });
    },
    exportWorkspace: async (toDir) => {
      // Filter in the container, then stream tar directly to an empty host
      // scratch directory. Dependency contents never cross the Docker boundary.
      const scratch = await mkdtemp(join(tmpdir(), "quickstudy-export-"));
      let producer: ReturnType<typeof Bun.spawn> | undefined;
      let consumer: ReturnType<typeof Bun.spawn> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        producer = Bun.spawn(["docker", "exec", id, "tar", ...EXCLUDED_WORKSPACE_DIRS.map((name) => `--exclude=${name}`),
          "--exclude=.env", "--exclude=.env.*", "-C", CONTAINER_WORKSPACE, "-cf", "-", "."], { stdout: "pipe", stderr: "pipe" });
        consumer = Bun.spawn(["tar", "-xf", "-", "-C", scratch], { stdin: producer.stdout, stdout: "ignore", stderr: "pipe" });
        timer = setTimeout(() => { producer?.kill("SIGKILL"); consumer?.kill("SIGKILL"); }, 60_000);
        const [produced, consumed, producerError, consumerError] = await Promise.all([
          producer.exited, consumer.exited, new Response(producer.stderr as ReadableStream).text(), new Response(consumer.stderr as ReadableStream).text(),
        ]);
        if (produced !== 0 || consumed !== 0) throw new Error(`workspace transfer failed: ${producerError} ${consumerError}`);
        const canonicalScratch = await realpath(scratch);
        const cleanLinks = async (dir: string): Promise<void> => {
          for (const name of await readdir(dir)) {
            const path = join(dir, name); const stat = await lstat(path);
            if (stat.isSymbolicLink()) {
              const target = await readlink(path);
              const destination = await realpath(path).catch(() => resolve(dir, target).replace(scratch, canonicalScratch));
              if (target.startsWith("/") || !destination.startsWith(`${canonicalScratch}/`)) await rm(path);
            } else if (stat.isDirectory()) await cleanLinks(path);
          }
        };
        await cleanLinks(scratch);
        await mkdir(toDir, { recursive: true });
        await cp(scratch, toDir, { recursive: true, verbatimSymlinks: true });
      } finally {
        if (timer) clearTimeout(timer);
        producer?.kill(); consumer?.kill();
        await rm(scratch, { recursive: true, force: true });
      }
    },
    teardown: () => removeContainer(id),
  };

  try {
    // Fixture delivery: docker cp, never a mount — the agent can never write
    // through to host fixture sources, and the mount count stays at one.
    await mustDocker(["cp", `${opts.fixtureDir}/.`, `${id}:${CONTAINER_WORKSPACE}`]);
  } catch (err) {
    await container.teardown();
    throw err;
  }

  return container;
}

/** `docker inspect` a container's mounts — the isolation criterion's probe. */
export async function inspectMounts(id: string): Promise<Array<{ destination: string; source: string }>> {
  const result = await mustDocker(["inspect", "--format", "{{json .Mounts}}", id]);
  const mounts = JSON.parse(result.stdout.trim()) as Array<{ Destination: string; Source: string }>;
  return mounts.map((m) => ({ destination: m.Destination, source: m.Source }));
}

/** `docker inspect` a container's label value for the attempt label. */
export async function inspectAttemptLabel(id: string): Promise<string> {
  const result = await mustDocker(["inspect", "--format", `{{index .Config.Labels "${ATTEMPT_LABEL}"}}`, id]);
  return result.stdout.trim();
}

/** A container's IP address on one specific network. */
export async function inspectContainerIp(id: string, network: string): Promise<string> {
  const result = await mustDocker([
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
    id,
  ]);
  const ip = result.stdout.trim();
  if (ip === "" || ip === "<no value>") {
    throw new DockerError(["inspect", id], 0, `container ${id.slice(0, 12)} has no address on network "${network}"`);
  }
  return ip;
}

// ---------------------------------------------------------------------------
// Egress-proxy run mode: per-run internal network + proxy sidecar.
// ---------------------------------------------------------------------------

/** The per-run internal network's name. */
export function runNetworkName(runId: string): string {
  return `quickstudy-run-${runId.toLowerCase()}`;
}

/**
 * Create the run's internal network: `--internal` means NO default route out
 * — containers on it can reach each other (the proxy sidecar) and nothing
 * else. Labeled for the same verifiable-teardown accounting as containers.
 */
export async function createRunNetwork(runId: string): Promise<string> {
  const name = runNetworkName(runId);
  await mustDocker(["network", "create", "--internal", "--label", `${RUN_LABEL}=${runId}`, name]);
  return name;
}

/** Remove one run network. Idempotent (an already-removed network is success). */
export async function removeRunNetwork(name: string): Promise<void> {
  const result = await runDocker(["network", "rm", name]);
  if (result.exitCode !== 0 && !/no such network|not found/i.test(result.stderr)) {
    throw new DockerError(["network", "rm", name], result.exitCode, result.stderr);
  }
}

/** All `quickstudy.run`-labeled networks (leak accounting / clean). */
export async function listRunNetworks(): Promise<string[]> {
  const result = await mustDocker(["network", "ls", "-q", "--filter", `label=${RUN_LABEL}`, "--format", "{{.Name}}"]);
  return result.stdout.split("\n").filter((line) => line !== "");
}

/** All `quickstudy.run`-labeled containers (egress-proxy sidecars). Full ids. */
export async function listRunContainers(): Promise<string[]> {
  const result = await mustDocker(["ps", "-aq", "--no-trunc", "--filter", `label=${RUN_LABEL}`]);
  return result.stdout.split("\n").filter((line) => line !== "");
}

/**
 * The `quickstudy clean` extension: remove leaked sidecar containers first
 * (a network with attached containers cannot be removed), then the networks.
 * Returns counts for the operator message.
 */
export async function removeRunResources(): Promise<{ containers: number; networks: number }> {
  const containers = await listRunContainers();
  if (containers.length > 0) await mustDocker(["rm", "-f", ...containers]);
  const networks = await listRunNetworks();
  for (const network of networks) await removeRunNetwork(network);
  return { containers: containers.length, networks: networks.length };
}

/** How long the sidecar may take to report `{"type":"listening"}`. */
const SIDECAR_START_TIMEOUT_MS = 30_000;

export interface StartEgressSidecarOptions {
  runId: string;
  /** The run's internal network (createRunNetwork). */
  networkName: string;
  /** Composed, validated allowlist (isolation/proxy/allowlist.ts). */
  allowlist: readonly string[];
  /** Proxy image tag. The caller passes EGRESS_PROXY_IMAGE. */
  image: string;
  /** Listen port inside the sidecar. Default 3128. */
  port?: number;
}

export interface EgressSidecar {
  id: string;
  networkName: string;
  /** The sidecar's address on the internal network. Updated on restart. */
  ip: string;
  port: number;
  /**
   * Proxy env for attempt containers. Both cases: vendor CLIs disagree on
   * which spelling they read. NO_PROXY keeps loopback traffic (dev servers,
   * graders' probes) away from the proxy.
   */
  proxyEnv(): Record<string, string>;
  /** Health probe: is the sidecar process still running? */
  isRunning(): Promise<boolean>;
  /** Restart the sidecar in place and re-resolve its internal-network IP. */
  restart(): Promise<void>;
  /** Full decision log (JSON lines) since sidecar start. */
  logs(): Promise<string>;
  /** `docker rm -f`. Idempotent. */
  teardown(): Promise<void>;
}

function countListeningLines(logs: string): number {
  return logs.split("\n").filter((line) => line.includes('"type":"listening"')).length;
}

/**
 * Poll `docker logs` until the proxy's listening line appears at least
 * `minCount` times — `docker logs` persists across restarts, so a restart
 * waits for one MORE listening line than it saw before.
 */
async function awaitSidecarListening(id: string, minCount = 1, label = "egress-proxy"): Promise<void> {
  const deadline = Date.now() + SIDECAR_START_TIMEOUT_MS;
  for (;;) {
    const logs = await runDocker(["logs", id]);
    if (countListeningLines(logs.stdout) >= minCount) return;
    const state = await runDocker(["inspect", "--format", "{{.State.Running}}", id]);
    if (state.exitCode === 0 && state.stdout.trim() !== "true") {
      throw new DockerError(
        ["logs", id],
        1,
        `${label} sidecar exited during startup:\n${logs.stdout}${logs.stderr}`,
      );
    }
    if (Date.now() > deadline) {
      throw new DockerError(["logs", id], 1, `${label} sidecar never reported listening:\n${logs.stdout}${logs.stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Start the run's egress-proxy sidecar: created ON the internal network (its
 * face toward the attempt containers — starting on a user-defined network
 * also wires Docker's embedded DNS into the container, which forwards to
 * upstream resolvers for public names), then connected to the default
 * bridge, whose gateway becomes its only route OUT (the internal network
 * has none). On any start failure the partial container is removed — a
 * failed start never leaks a sidecar.
 */
export async function startEgressSidecar(opts: StartEgressSidecarOptions): Promise<EgressSidecar> {
  const port = opts.port ?? 3128;
  const created = await mustDocker([
    "run",
    "-d",
    "--label",
    `${RUN_LABEL}=${opts.runId}`,
    "--network",
    opts.networkName,
    "-e",
    `QUICKSTUDY_EGRESS_ALLOWLIST=${opts.allowlist.join(",")}`,
    "-e",
    `QUICKSTUDY_EGRESS_PORT=${port}`,
    opts.image,
  ]);
  const id = created.stdout.trim();

  try {
    await mustDocker(["network", "connect", "bridge", id]);
    await awaitSidecarListening(id);
  } catch (err) {
    await runDocker(["rm", "-f", id]);
    throw err;
  }

  const sidecar: EgressSidecar = {
    id,
    networkName: opts.networkName,
    ip: await inspectContainerIp(id, opts.networkName),
    port,
    proxyEnv() {
      const url = `http://${this.ip}:${this.port}`;
      const noProxy = "localhost,127.0.0.1";
      return {
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        http_proxy: url,
        https_proxy: url,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
      };
    },
    async isRunning() {
      const state = await runDocker(["inspect", "--format", "{{.State.Running}}", id]);
      return state.exitCode === 0 && state.stdout.trim() === "true";
    },
    async restart() {
      const seenBefore = countListeningLines(await this.logs());
      await mustDocker(["restart", id]);
      await awaitSidecarListening(id, seenBefore + 1);
      this.ip = await inspectContainerIp(id, opts.networkName);
    },
    async logs() {
      const result = await mustDocker(["logs", id]);
      return result.stdout;
    },
    teardown: () => removeContainer(id),
  };
  return sidecar;
}

export interface StartMcpSidecarOptions {
  runId: string;
  /**
   * The run's internal network (egress mode). Omitted = default bridge —
   * attempt containers reach the sidecar by IP either way.
   */
  networkName?: string;
  /** Proxy image tag. The caller passes MCP_PROXY_IMAGE. */
  image: string;
  /** Upstream config (no secrets — safe for `docker inspect`). */
  upstreams: Record<string, McpUpstream>;
  /** Initial refresh tokens by server name. Env-file only, never argv. */
  refreshTokens: Record<string, string>;
  /** Listen port inside the sidecar. Default 8914. */
  port?: number;
}

export interface McpSidecar {
  id: string;
  /** The sidecar's address as attempt containers see it. */
  ip: string;
  port: number;
  /**
   * Current (possibly rotated) refresh token per server, read from the
   * sidecar's token-state files. Called at teardown — rotation makes the
   * on-disk token stale the moment the sidecar refreshes once.
   */
  readRotatedRefreshTokens(): Promise<Record<string, string | undefined>>;
  isRunning(): Promise<boolean>;
  teardown(): Promise<void>;
}

/**
 * Start the run's MCP token-injecting sidecar. Same topology as the egress
 * sidecar under `--egress-proxy` (internal network + bridge for its own way
 * out); on plain runs it sits on the default bridge. Secrets travel via a
 * transient 0600 env-file, mirroring createAttemptContainer.
 */
export async function startMcpSidecar(opts: StartMcpSidecarOptions): Promise<McpSidecar> {
  const port = opts.port ?? 8914;
  const envDir = await mkdtemp(join(tmpdir(), "quickstudy-mcp-env-"));
  const envFile = join(envDir, "sidecar.env");
  const env: Record<string, string> = {
    QUICKSTUDY_MCP_UPSTREAMS: JSON.stringify(opts.upstreams),
    QUICKSTUDY_MCP_PORT: String(port),
  };
  for (const [name, token] of Object.entries(opts.refreshTokens)) {
    if (token.includes("\n")) throw new Error(`mcp refresh token for "${name}" contains a newline`);
    env[`QUICKSTUDY_MCP_REFRESH_TOKEN_${sanitizeServerName(name)}`] = token;
  }
  await writeFile(
    envFile,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );

  let id: string;
  try {
    const created = await mustDocker([
      "run",
      "-d",
      "--label",
      `${RUN_LABEL}=${opts.runId}`,
      "--env-file",
      envFile,
      ...(opts.networkName !== undefined ? ["--network", opts.networkName] : []),
      opts.image,
    ]);
    id = created.stdout.trim();
  } finally {
    await rm(envDir, { recursive: true, force: true });
  }

  try {
    if (opts.networkName !== undefined) await mustDocker(["network", "connect", "bridge", id]);
    await awaitSidecarListening(id, 1, "mcp-proxy");
  } catch (err) {
    await runDocker(["rm", "-f", id]);
    throw err;
  }

  return {
    id,
    ip: await inspectContainerIp(id, opts.networkName ?? "bridge"),
    port,
    async readRotatedRefreshTokens() {
      const tokens: Record<string, string | undefined> = {};
      for (const name of Object.keys(opts.upstreams)) {
        const result = await runDocker(["exec", id, "cat", `/run/quickstudy-mcp/${sanitizeServerName(name)}.refresh-token`]);
        const value = result.stdout.trim();
        tokens[name] = result.exitCode === 0 && value !== "" ? value : undefined;
      }
      return tokens;
    },
    async isRunning() {
      const state = await runDocker(["inspect", "--format", "{{.State.Running}}", id]);
      return state.exitCode === 0 && state.stdout.trim() === "true";
    },
    teardown: () => removeContainer(id),
  };
}

/** Attach shared infrastructure to an attempt network, returning its local address. */
export async function connectContainerNetwork(id: string, network: string): Promise<string> {
  await mustDocker(["network", "connect", network, id]);
  return inspectContainerIp(id, network);
}
export async function disconnectContainerNetwork(id: string, network: string): Promise<void> {
  await mustDocker(["network", "disconnect", network, id]);
}
