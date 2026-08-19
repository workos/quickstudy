/**
 * Image resolution and building.
 *
 * The harness core owns exactly one image: `quickstudy/agent-runtime`
 * (debian-slim + git + the pinned agent CLIs — see images/agent-runtime/).
 * A runtime may declare per-framework images that layer toolchains on top;
 * anything it does not declare resolves to the base image.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { IMAGE_CONTEXT_FILES } from "./image-contexts.generated.ts";

/** The base image tag the harness core owns and builds. */
export const AGENT_RUNTIME_IMAGE = "quickstudy/agent-runtime";

/** The egress-proxy sidecar image — also harness-owned. */
export const EGRESS_PROXY_IMAGE = "quickstudy/egress-proxy";

/** The MCP token-injecting proxy sidecar image — also harness-owned. */
export const MCP_PROXY_IMAGE = "quickstudy/mcp-proxy";

/**
 * Locate the directory holding the harness image build contexts (`images/`
 * and `src/isolation/`).
 *
 * Default: the embedded copies, materialized into a temp directory —
 * `docker build` needs a real directory to send as context, and the harness
 * carries one, so the same contexts build from source and from the compiled
 * binary with no checkout anywhere. The ONLY override is an explicit
 * `--images-dir` (when iterating on the Dockerfiles themselves, point it at
 * a checkout — or regenerate: bun scripts/generate-image-contexts.ts).
 */
export function resolveImagesRoot(override?: string): string {
  if (override) return resolve(override);
  return materializeEmbeddedContexts();
}

/**
 * Write the binary-embedded build contexts into a temp directory mirroring
 * the repo layout, so `imagePaths()` resolves against it unchanged. One
 * directory per process: the three image builds of `images build` share it.
 */
let embeddedRoot: string | undefined;
export function materializeEmbeddedContexts(): string {
  if (embeddedRoot !== undefined) return embeddedRoot;
  const root = mkdtempSync(join(tmpdir(), "quickstudy-image-contexts-"));
  for (const [rel, contents] of Object.entries(IMAGE_CONTEXT_FILES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  embeddedRoot = root;
  return root;
}

/** The build contexts, resolved against a given harness root. */
function imagePaths(root: string) {
  return {
    /** Base-image Dockerfile directory (context = the directory). */
    agentRuntimeBuildDir: join(root, "images", "agent-runtime"),
    /**
     * The egress-proxy Dockerfile and its build CONTEXT (just the proxy
     * sources — the image copies two files, so shipping the whole repo to the
     * daemon on every build would be pure waste).
     */
    egressProxyDockerfile: join(root, "images", "egress-proxy", "Dockerfile"),
    egressProxyContext: join(root, "src", "isolation", "proxy"),
    /** The mcp-proxy Dockerfile and its build context (its single source file). */
    mcpProxyDockerfile: join(root, "images", "mcp-proxy", "Dockerfile"),
    mcpProxyContext: join(root, "src", "isolation", "mcp-proxy"),
  };
}

/** A build-context-missing error that points at the fix. */
function missingContext(what: string, path: string): Error {
  return new Error(
    `${what} not found at ${path}.\n` +
      "Point --images-dir at a quickstudy checkout, or omit it — " +
      "without the flag the binary builds from its own embedded contexts.",
  );
}

/** Options common to the base-image builds. */
export interface BuildImageOptions {
  /** Pass `docker build --pull` to refresh base layers. */
  pull?: boolean;
  /** Override where the build contexts are read from (see {@link resolveImagesRoot}). */
  imagesRoot?: string;
}

/**
 * Build the agent-runtime base image (`quickstudy images build`). Streams
 * docker's own progress output straight through — this is an interactive
 * developer command, not an attempt-time operation.
 */
export async function buildAgentRuntimeImage(opts: BuildImageOptions = {}): Promise<number> {
  const { agentRuntimeBuildDir } = imagePaths(resolveImagesRoot(opts.imagesRoot));
  if (!existsSync(join(agentRuntimeBuildDir, "Dockerfile"))) {
    throw missingContext("agent-runtime Dockerfile", join(agentRuntimeBuildDir, "Dockerfile"));
  }
  const args = ["build", "-t", AGENT_RUNTIME_IMAGE];
  if (opts.pull) args.push("--pull");
  args.push(agentRuntimeBuildDir);
  const proc = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

/**
 * Build the egress-proxy sidecar image (also part of `quickstudy images
 * build`). The build context is src/isolation/proxy — the Dockerfile lives
 * in images/egress-proxy/ next to its sibling, passed via -f.
 */
export async function buildEgressProxyImage(opts: BuildImageOptions = {}): Promise<number> {
  const { egressProxyDockerfile, egressProxyContext } = imagePaths(resolveImagesRoot(opts.imagesRoot));
  if (!existsSync(egressProxyDockerfile)) {
    throw missingContext("egress-proxy Dockerfile", egressProxyDockerfile);
  }
  const args = ["build", "-t", EGRESS_PROXY_IMAGE, "-f", egressProxyDockerfile];
  if (opts.pull) args.push("--pull");
  args.push(egressProxyContext);
  const proc = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

/** Build the mcp-proxy sidecar image (also part of `quickstudy images build`). */
export async function buildMcpProxyImage(opts: BuildImageOptions = {}): Promise<number> {
  const { mcpProxyDockerfile, mcpProxyContext } = imagePaths(resolveImagesRoot(opts.imagesRoot));
  if (!existsSync(mcpProxyDockerfile)) {
    throw missingContext("mcp-proxy Dockerfile", mcpProxyDockerfile);
  }
  const args = ["build", "-t", MCP_PROXY_IMAGE, "-f", mcpProxyDockerfile];
  if (opts.pull) args.push("--pull");
  args.push(mcpProxyContext);
  const proc = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}
