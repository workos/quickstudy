/**
 * AUTO-GENERATED — do not edit by hand.
 *
 * The harness image build contexts (Dockerfiles + the proxy sources they
 * COPY), embedded so the compiled binary can `images build` without a
 * checkout: resolveImagesRoot materializes these into a temp directory and
 * `docker build` runs against that. Paths are repo-relative and mirror the
 * source tree exactly.
 *
 * Regenerate with: bun scripts/generate-image-contexts.ts
 * (tests/image-contexts.test.ts fails when this module drifts from source.)
 */

export const IMAGE_CONTEXT_FILES: Record<string, string> = {
  "images/agent-runtime/Dockerfile": `# quickstudy agent-runtime base image.
#
# Debian-slim + git + node, with the agent CLIs installed at PINNED versions:
# vendor CLIs change their stream formats between releases, and the parsers in
# src/adapters/parse.ts are tested against fixtures captured from these exact
# versions. Bump the pins deliberately (\`quickstudy images build --pull\`) and
# re-capture fixtures when you do.
#
# Framework toolchains (Rails, Django, ...) layer on top in Phase 3 — this
# image stays agent-only.

FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.215
ARG CODEX_VERSION=0.149.1
ARG GEMINI_CLI_VERSION=0.51.0
# cursor-agent is not an npm package: it ships as versioned tarballs (the
# vendor install script pins the same way). Fixture streams in
# tests/__fixtures__/streams/cursor/ correspond to this pin.
ARG CURSOR_AGENT_VERSION=2026.07.17-3e2a980

RUN apt-get update \\
  && apt-get install -y --no-install-recommends ca-certificates curl git procps ripgrep \\
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit \\
  "@anthropic-ai/claude-code@\${CLAUDE_CODE_VERSION}" \\
  "@openai/codex@\${CODEX_VERSION}" \\
  "@google/gemini-cli@\${GEMINI_CLI_VERSION}"

RUN arch="$(dpkg --print-architecture)" \\
  && case "$arch" in \\
       amd64) cursor_arch=x64 ;; \\
       arm64) cursor_arch=arm64 ;; \\
       *) echo "unsupported architecture for cursor-agent: $arch" >&2; exit 1 ;; \\
     esac \\
  && mkdir -p /opt/cursor-agent \\
  && curl -fsSL "https://downloads.cursor.com/lab/\${CURSOR_AGENT_VERSION}/linux/\${cursor_arch}/agent-cli-package.tar.gz" \\
     | tar --strip-components=1 -xzf - -C /opt/cursor-agent \\
  && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent

# The fixture-baseline commit (and any commits the agent makes) need an
# identity; system-level config applies to whichever user runs.
RUN git config --system user.name "quickstudy" \\
  && git config --system user.email "quickstudy@localhost" \\
  && git config --system init.defaultBranch main \\
  && git config --system --add safe.directory /workspace

# Claude Code refuses --dangerously-skip-permissions as root unless it can
# tell it is inside a sandbox. The container IS the security boundary here —
# that is the entire point of this phase.
ENV IS_SANDBOX=1

WORKDIR /workspace

# The harness drives everything through \`docker exec\`; the main process just
# keeps the container alive until teardown.
CMD ["sleep", "infinity"]
`,
  "images/egress-proxy/Dockerfile": `# quickstudy egress-proxy sidecar image.
#
# One per run: attempt containers sit on an internal Docker network with no
# default route, and this proxy (attached to BOTH the internal network and
# the bridge) is their only way out — an HTTP CONNECT / absolute-form forward
# proxy enforcing the run's host allowlist (src/isolation/proxy/server.ts).
# No TLS interception: for HTTPS the proxy sees only the CONNECT host:port.
#
# Build context is src/isolation/proxy (the image needs exactly two files):
#   docker build -t quickstudy/egress-proxy -f images/egress-proxy/Dockerfile src/isolation/proxy
# or simply \`quickstudy images build\`, which builds this alongside the
# agent-runtime image.
#
# Config via env at \`docker run\`:
#   QUICKSTUDY_EGRESS_ALLOWLIST  comma-separated hosts / *.wildcards (required)
#   QUICKSTUDY_EGRESS_PORT       listen port (default 3128)

FROM oven/bun:1.3-slim

WORKDIR /app

COPY allowlist.ts server.ts ./proxy/

EXPOSE 3128

# Decisions (allowed + denied) stream to stdout as JSON lines; the harness
# reads them back with \`docker logs\` for per-attempt denial artifacts.
ENTRYPOINT ["bun", "/app/proxy/server.ts"]
`,
  "images/mcp-proxy/Dockerfile": `# quickstudy mcp-proxy sidecar image.
#
# One per run, only when the runtime's mcpServers declare \`auth\`: attempt
# containers speak credential-free HTTP to this proxy, which forwards to the
# real MCP server injecting a Bearer access token it mints (and re-mints)
# from a refresh token (src/isolation/mcp-proxy/server.ts). Refresh tokens
# rotate on use; the current one is persisted inside the container at
# /run/quickstudy-mcp/ for the harness to read back at teardown.
#
# Build context is src/isolation/mcp-proxy (the image needs exactly one file):
#   docker build -t quickstudy/mcp-proxy -f images/mcp-proxy/Dockerfile src/isolation/mcp-proxy
# or simply \`quickstudy images build\`, which builds this alongside the
# agent-runtime and egress-proxy images.
#
# Config via env at \`docker run\` (secrets arrive via --env-file, never argv):
#   QUICKSTUDY_MCP_UPSTREAMS             JSON {name: {url, tokenEndpoint, clientId, resource?}}
#   QUICKSTUDY_MCP_REFRESH_TOKEN_<NAME>  initial refresh token per server
#   QUICKSTUDY_MCP_PORT                  listen port (default 8914)

FROM oven/bun:1.3-slim

WORKDIR /app

COPY server.ts ./mcp-proxy/

EXPOSE 8914

# Events (forwards + token refreshes) stream to stdout as JSON lines; token
# values never appear in them.
ENTRYPOINT ["bun", "/app/mcp-proxy/server.ts"]
`,
  "src/isolation/proxy/allowlist.ts": `/**
 * Egress allowlist: composition and matching.
 *
 * The allowlist composes from two layers, both recorded into the run's
 * config_json for auditability:
 *   (1) harness defaults — each container agent adapter declares the LLM
 *       endpoints its CLI needs (\`egressHosts\` on the adapter);
 *   (2) runtime contribution — the experiment runtime's
 *       \`egressHosts(metadata)\` (product endpoints, package registries).
 *
 * Matching is deliberately narrow: exact hostnames and \`*.domain\` subdomain
 * wildcards only — no path rules, no IP rules, no CIDR. Raw-IP CONNECT
 * targets are refused outright (closing the resolve-then-dial DNS bypass),
 * so IP literals in the allowlist itself are rejected at compose time.
 */

/** An allowlist entry is invalid (IP literal, port, scheme, path, bad wildcard). */
export class AllowlistEntryError extends Error {
  constructor(entry: string, problem: string) {
    super(\`invalid egress allowlist entry "\${entry}": \${problem}\`);
    this.name = "AllowlistEntryError";
  }
}

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Normalize one host for matching: lowercase, strip a single trailing dot
 * (DNS absolute form — \`evil.com.\` resolves identically to \`evil.com\` and
 * must match the same allowlist entries, never bypass them).
 */
export function normalizeHost(host: string): string {
  const lowered = host.toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

/**
 * Is this host an IP literal (any form)? The proxy refuses raw-IP CONNECTs
 * regardless of allowlist, so this is deliberately over-broad: dotted quads,
 * anything with a colon (IPv6), bracketed literals, all-digit decimal forms
 * (\`http://2130706433/\`), and 0x-prefixed hex forms all count.
 */
export function isRawIpHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h.length === 0) return true;
  if (h.includes(":") || h.startsWith("[")) return true; // IPv6 / bracketed
  if (/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(h)) return true; // dotted quad
  if (/^\\d+$/.test(h)) return true; // decimal int form
  if (/^0x[0-9a-f]+$/.test(h)) return true; // hex int form
  if (/^[\\d.]+$/.test(h)) return true; // partial numeric forms (1.2.3, 1.2)
  return false;
}

/** Validate one entry (exact host or \`*.domain\`); returns its normalized form. */
export function validateAllowlistEntry(entry: string): string {
  const normalized = normalizeHost(entry.trim());
  if (normalized.length === 0) throw new AllowlistEntryError(entry, "empty");
  if (/[/?#\\s]/.test(normalized) || normalized.includes("://")) {
    throw new AllowlistEntryError(entry, "must be a bare hostname (no scheme, path, or spaces)");
  }
  if (normalized.includes(":")) {
    throw new AllowlistEntryError(entry, "must not carry a port (allowlisting is hostname-granularity)");
  }
  const body = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
  if (body.includes("*")) {
    throw new AllowlistEntryError(entry, "wildcards are subdomain-only: a single leading \`*.\` label");
  }
  if (isRawIpHost(body)) {
    throw new AllowlistEntryError(entry, "IP literals are refused by the proxy — allowlist hostnames only");
  }
  // Single-label hosts are legal: Docker-network service names ("origin")
  // and localhost matter for tests and runtime-provisioned local services.
  const labels = body.split(".");
  if (!labels.every((label) => LABEL.test(label))) {
    throw new AllowlistEntryError(entry, "not a valid hostname");
  }
  return normalized;
}

/**
 * Does \`host\` match the allowlist? Exact entries match the whole hostname
 * (case-insensitively, trailing dot stripped); \`*.domain\` entries match any
 * subdomain of \`domain\` — at least one extra label, never \`domain\` itself
 * (which is why runtimes list both \`example.com\` and \`*.example.com\`).
 * IP literals never match anything.
 */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (isRawIpHost(h)) return false;
  for (const entry of allowlist) {
    const e = normalizeHost(entry);
    if (e.startsWith("*.")) {
      const suffix = e.slice(1); // ".domain"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === e) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a CONNECT authority-form target (\`host:port\`, \`[v6]:port\`) or a bare
 * host. Returns undefined for garbage. The port defaults to 443 — CONNECT
 * targets are overwhelmingly TLS.
 */
export function parseHostPort(target: string): { host: string; port: number } | undefined {
  const trimmed = target.trim();
  if (trimmed.length === 0) return undefined;
  let host: string;
  let portText: string | undefined;
  if (trimmed.startsWith("[")) {
    // Bracketed IPv6 literal: [::1]:443 — kept intact so isRawIpHost sees it.
    const end = trimmed.indexOf("]");
    if (end === -1) return undefined;
    host = trimmed.slice(0, end + 1);
    const rest = trimmed.slice(end + 1);
    if (rest.startsWith(":")) portText = rest.slice(1);
    else if (rest !== "") return undefined;
  } else {
    const colon = trimmed.lastIndexOf(":");
    // A second colon means an unbracketed IPv6 literal: keep whole as host.
    if (colon !== -1 && trimmed.indexOf(":") === colon) {
      host = trimmed.slice(0, colon);
      portText = trimmed.slice(colon + 1);
    } else {
      host = trimmed;
    }
  }
  if (host.length === 0) return undefined;
  if (portText === undefined) return { host, port: 443 };
  if (!/^\\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  if (port < 1 || port > 65535) return undefined;
  return { host, port };
}

/**
 * Compose a validated allowlist from an explicit host list (the runner
 * unions runtime- and adapter-declared hosts before calling). Validated,
 * normalized, deduplicated, sorted — the sorted list is what lands in
 * config_json, so two identical runs record identical allowlists.
 */
export function composeAllowlistFromHosts(hosts: readonly string[]): string[] {
  const entries = new Set<string>();
  for (const host of hosts) entries.add(validateAllowlistEntry(host));
  return [...entries].sort();
}
`,
  "src/isolation/proxy/server.ts": `/**
 * The egress allowlist proxy: a small HTTP CONNECT / absolute-form forward
 * proxy (no squid dependency, no TLS interception).
 *
 * Attempt containers sit on an internal Docker network with no default
 * route; this proxy straddles that network and the bridge, and the attempt
 * env carries HTTP_PROXY/HTTPS_PROXY pointing here. For HTTPS the proxy sees
 * only the CONNECT \`host:port\` — allowlist enforcement is hostname-granular,
 * traffic is never decrypted. Deny-by-default; denials answer 403 naming the
 * host; raw-IP CONNECT targets are refused outright (no DNS-bypass hole).
 *
 * Every decision (allowed AND denied) is emitted as one stable JSON event —
 * to \`onEvent\` in-process, and as a JSON line on stdout when run as the
 * sidecar entrypoint. Denials become the attempt's \`egress-denials.log\`
 * artifact; zero allowed connections from an errored attempt is the
 * \`egress_no_route\` signal (an agent whose HTTP stack ignored proxy env).
 *
 * Threat model (also in README): a MISBEHAVING agent, not a determined
 * adversary — a hostile workload could still tunnel over an allowlisted
 * host.
 */

import { connect, createServer, type Server, type Socket } from "node:net";
import { hostAllowed, isRawIpHost, normalizeHost, parseHostPort, validateAllowlistEntry } from "./allowlist.ts";

/** One proxy decision. The line shape is stable — consumers parse it. */
export interface EgressEvent {
  type: "egress";
  /** ISO-8601 timestamp. */
  ts: string;
  /** Client IP (the attempt container's internal-network address). */
  client: string;
  /** "CONNECT" for tunnels, the HTTP method for plain forwards. */
  method: string;
  host: string;
  port: number;
  decision: "allowed" | "denied";
  /** Present on denials only. */
  reason?: "not_allowlisted" | "raw_ip" | "bad_request";
}

export interface EgressProxyOptions {
  /** Validated at start; entries are exact hosts or \`*.domain\` wildcards. */
  allowlist: readonly string[];
  /** 0 (default) picks a random free port. Sidecar runs pass a fixed one. */
  port?: number;
  /** Bind address. Default 0.0.0.0 (the sidecar must accept from the internal network). */
  hostname?: string;
  /** Decision sink (both allowed and denied). */
  onEvent?: (event: EgressEvent) => void;
}

export interface EgressProxyHandle {
  port: number;
  close(): Promise<void>;
}

/** How long a client may take to send its request head. */
const HEAD_TIMEOUT_MS = 30_000;
/** How long an upstream TCP connect may take. */
const CONNECT_TIMEOUT_MS = 20_000;
/** Request heads larger than this are dropped (nothing legitimate is close). */
const MAX_HEAD_BYTES = 32 * 1024;

/** Hop-by-hop headers never forwarded upstream on plain-HTTP forwards. */
const DROPPED_HEADERS = /^(proxy-connection|proxy-authorization|connection|keep-alive|te|upgrade|transfer-encoding)$/i;

function writeAndClose(socket: Socket, response: string): void {
  socket.write(response, () => socket.end());
}

function httpError(status: number, statusText: string, body: string): string {
  return (
    \`HTTP/1.1 \${status} \${statusText}\\r\\n\` +
    "Content-Type: text/plain; charset=utf-8\\r\\n" +
    \`Content-Length: \${Buffer.byteLength(body)}\\r\\n\` +
    "Connection: close\\r\\n\\r\\n" +
    body
  );
}

/** Start the proxy. Resolves once listening. */
export function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxyHandle> {
  // Fail fast on a malformed allowlist — a sidecar that silently allowed
  // nothing (or crashed per-request) would fail every attempt wholesale.
  const allowlist = options.allowlist.map(validateAllowlistEntry);
  const onEvent = options.onEvent ?? (() => {});

  const server: Server = createServer((client) => {
    client.on("error", () => client.destroy());
    const clientIp = client.remoteAddress ?? "unknown";
    let buffered = Buffer.alloc(0);
    let done = false;

    const headTimer = setTimeout(() => {
      if (!done) client.destroy();
    }, HEAD_TIMEOUT_MS);

    const emit = (
      method: string,
      host: string,
      port: number,
      decision: EgressEvent["decision"],
      reason?: EgressEvent["reason"],
    ): void => {
      onEvent({
        type: "egress",
        ts: new Date().toISOString(),
        client: clientIp,
        method,
        host,
        port,
        decision,
        ...(reason ? { reason } : {}),
      });
    };

    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const headEnd = buffered.indexOf("\\r\\n\\r\\n");
      if (headEnd === -1) {
        if (buffered.length > MAX_HEAD_BYTES) {
          done = true;
          clearTimeout(headTimer);
          writeAndClose(client, httpError(400, "Bad Request", "request head too large\\n"));
        }
        return;
      }
      done = true;
      clearTimeout(headTimer);
      client.removeListener("data", onData);
      client.pause();

      const head = buffered.subarray(0, headEnd).toString("latin1");
      const remainder = buffered.subarray(headEnd + 4);
      buffered = Buffer.alloc(0);
      handleRequest(client, head, remainder, emit, allowlist);
    };
    client.on("data", onData);
  });

  // Track live client sockets so close() can sever open tunnels — a
  // long-lived CONNECT tunnel would otherwise keep the server open forever.
  const open = new Set<Socket>();
  server.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname ?? "0.0.0.0", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of open) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

function handleRequest(
  client: Socket,
  head: string,
  remainder: Buffer,
  emit: (
    method: string,
    host: string,
    port: number,
    decision: EgressEvent["decision"],
    reason?: EgressEvent["reason"],
  ) => void,
  allowlist: readonly string[],
): void {
  const lines = head.split("\\r\\n");
  const requestLine = lines[0] ?? "";
  const parts = requestLine.split(" ");
  if (parts.length !== 3) {
    emit(parts[0] ?? "?", "", 0, "denied", "bad_request");
    writeAndClose(client, httpError(400, "Bad Request", \`malformed request line: "\${requestLine}"\\n\`));
    return;
  }
  const [method, target] = parts as [string, string, string];

  if (method === "CONNECT") {
    handleConnect(client, target, remainder, emit, allowlist);
  } else {
    handleForward(client, method, target, lines.slice(1), remainder, emit, allowlist);
  }
}

/** Shared allow/deny gate. Writes the 403 (naming the host) on denial. */
function gate(
  client: Socket,
  method: string,
  host: string,
  port: number,
  emit: (
    method: string,
    host: string,
    port: number,
    decision: EgressEvent["decision"],
    reason?: EgressEvent["reason"],
  ) => void,
  allowlist: readonly string[],
): boolean {
  const normalized = normalizeHost(host);
  if (isRawIpHost(normalized)) {
    emit(method, normalized, port, "denied", "raw_ip");
    writeAndClose(
      client,
      httpError(403, "Forbidden", \`egress blocked: raw-IP targets are refused ("\${normalized}") — use a hostname\\n\`),
    );
    return false;
  }
  if (!hostAllowed(normalized, allowlist)) {
    emit(method, normalized, port, "denied", "not_allowlisted");
    writeAndClose(
      client,
      httpError(403, "Forbidden", \`egress blocked: "\${normalized}" is not on this run's egress allowlist\\n\`),
    );
    return false;
  }
  emit(method, normalized, port, "allowed");
  return true;
}

/** Dial upstream with a connect timeout; invoke ready exactly once on success. */
function dialUpstream(client: Socket, host: string, port: number, ready: (upstream: Socket) => void): void {
  const upstream = connect(port, host);
  let established = false;
  const connectTimer = setTimeout(() => {
    if (!established) upstream.destroy(new Error("connect timeout"));
  }, CONNECT_TIMEOUT_MS);
  upstream.once("connect", () => {
    established = true;
    clearTimeout(connectTimer);
    ready(upstream);
  });
  upstream.on("error", (err) => {
    clearTimeout(connectTimer);
    if (!established) {
      writeAndClose(client, httpError(502, "Bad Gateway", \`upstream connect to \${host}:\${port} failed: \${err.message}\\n\`));
    } else {
      client.destroy();
    }
  });
}

/**
 * Bidirectional tunnel wiring shared by CONNECT and plain forwards.
 *
 * \`pipe()\` already ends the destination once the source ends — after the
 * buffered bytes have flushed. Destroying the client on the upstream's
 * \`close\` threw that buffer away: an upstream that closes right after a
 * large response (a registry tarball) left the client with a truncated body
 * and an ECONNRESET, so \`npm install\` through the proxy failed at random.
 * So the upstream's close only ENDS the client (flush, then FIN). The other
 * direction stays a destroy: a client that is gone will never read what the
 * upstream still has to say, and a merely ended upstream would sit paused
 * and half-open until the origin gave up.
 */
function pipeBoth(client: Socket, upstream: Socket): void {
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => {
    if (!client.writableEnded) client.end();
  });
}

/** CONNECT host:port — the HTTPS path. The tunnel is opaque to the proxy. */
function handleConnect(
  client: Socket,
  target: string,
  remainder: Buffer,
  emit: (
    method: string,
    host: string,
    port: number,
    decision: EgressEvent["decision"],
    reason?: EgressEvent["reason"],
  ) => void,
  allowlist: readonly string[],
): void {
  const parsed = parseHostPort(target);
  if (!parsed) {
    emit("CONNECT", target, 0, "denied", "bad_request");
    writeAndClose(client, httpError(400, "Bad Request", \`malformed CONNECT target: "\${target}"\\n\`));
    return;
  }
  if (!gate(client, "CONNECT", parsed.host, parsed.port, emit, allowlist)) return;

  dialUpstream(client, normalizeHost(parsed.host), parsed.port, (upstream) => {
    client.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    // Bytes the client sent eagerly after its head (e.g. an early TLS hello).
    if (remainder.length > 0) upstream.write(remainder);
    pipeBoth(client, upstream);
    client.resume();
  });
}

/**
 * Plain-HTTP forward: proxy clients send absolute-form URIs
 * (\`GET http://host/path HTTP/1.1\`). The request is rewritten to origin form
 * with \`Connection: close\` (one exchange per connection — simple beats
 * keep-alive bookkeeping in a harness proxy).
 */
function handleForward(
  client: Socket,
  method: string,
  target: string,
  headerLines: string[],
  remainder: Buffer,
  emit: (
    method: string,
    host: string,
    port: number,
    decision: EgressEvent["decision"],
    reason?: EgressEvent["reason"],
  ) => void,
  allowlist: readonly string[],
): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    emit(method, target, 0, "denied", "bad_request");
    writeAndClose(
      client,
      httpError(400, "Bad Request", \`expected an absolute-form proxy request URI, got "\${target}"\\n\`),
    );
    return;
  }
  if (url.protocol !== "http:") {
    emit(method, url.hostname, 0, "denied", "bad_request");
    writeAndClose(client, httpError(400, "Bad Request", \`unsupported scheme "\${url.protocol}" (https uses CONNECT)\\n\`));
    return;
  }
  const host = url.hostname;
  const port = url.port === "" ? 80 : Number(url.port);
  if (!gate(client, method, host, port, emit, allowlist)) return;

  const kept = headerLines.filter((line) => !DROPPED_HEADERS.test(line.split(":")[0] ?? ""));
  const originForm = \`\${url.pathname}\${url.search}\`;
  // Head assembled as lines and joined ONCE: an empty \`kept\` must not leave
  // a blank line after the request line (that would end the header block
  // early and push "Connection: close" into the body).
  const rewritten = [\`\${method} \${originForm === "" ? "/" : originForm} HTTP/1.1\`, ...kept, "Connection: close", "", ""].join(
    "\\r\\n",
  );

  dialUpstream(client, normalizeHost(host), port, (upstream) => {
    upstream.write(rewritten);
    if (remainder.length > 0) upstream.write(remainder);
    pipeBoth(client, upstream);
    client.resume();
  });
}

/**
 * Sidecar entrypoint (images/egress-proxy). Config via env:
 *   QUICKSTUDY_EGRESS_ALLOWLIST  comma-separated entries (required)
 *   QUICKSTUDY_EGRESS_PORT       listen port (default 3128)
 * Every decision prints as one JSON line on stdout; the harness reads them
 * back with \`docker logs\` for per-attempt denial artifacts.
 */
if (import.meta.main) {
  const rawList = process.env["QUICKSTUDY_EGRESS_ALLOWLIST"] ?? "";
  const allowlist = rawList
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const port = Number(process.env["QUICKSTUDY_EGRESS_PORT"] ?? "3128");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(\`egress-proxy: invalid QUICKSTUDY_EGRESS_PORT "\${process.env["QUICKSTUDY_EGRESS_PORT"]}"\`);
    process.exit(1);
  }
  try {
    const handle = await startEgressProxy({
      allowlist,
      port,
      onEvent: (event) => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify({ type: "listening", port: handle.port, allowlist }));
  } catch (err) {
    console.error(\`egress-proxy: failed to start: \${err instanceof Error ? err.message : String(err)}\`);
    process.exit(1);
  }
}
`,
  "src/isolation/mcp-proxy/server.ts": `/**
 * The MCP token-injecting proxy: attempt containers speak plain,
 * credential-free HTTP to \`http://<sidecar>:<port>/<serverName>\`, and this
 * proxy forwards each request to the real streamable-HTTP MCP server with
 * \`Authorization: Bearer <access token>\` attached.
 *
 * Why it exists: some MCP servers only accept OAuth bearer tokens, which
 * expire in minutes and are minted from a refresh token that ROTATES on
 * every use. Neither belongs anywhere near an agent: a token in vendor
 * config would land in workspace diffs, and concurrent per-attempt
 * refreshes would invalidate each other. So the proxy owns the whole token
 * lifecycle — one serialized refresher per upstream, access tokens cached
 * until near expiry, one forced refresh + retry on an upstream 401.
 *
 * Rotation persistence: every rotated refresh token is written to
 * \`<tokenStateDir>/<name>.refresh-token\` (0600). The harness reads that
 * file back (docker exec) at teardown and persists it for the next run —
 * losing it costs the operator a re-login, nothing worse.
 *
 * Like the egress proxy, this file is self-contained (the sidecar image
 * copies it alone) and doubles as the container entrypoint. Events go to
 * \`onEvent\` in-process and stdout JSON lines in the sidecar; token VALUES
 * never appear in either.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface McpUpstream {
  /** The real MCP server URL requests are forwarded to. */
  url: string;
  /** OAuth token endpoint for the refresh grant. */
  tokenEndpoint: string;
  /** Public client id (token_endpoint_auth "none"); rides in the form body. */
  clientId: string;
  /** RFC 8707 resource indicator — REQUIRED by servers that audience-bind tokens. */
  resource?: string;
}

/** One proxy decision or token event. The line shape is stable. */
export interface McpProxyEvent {
  type: "mcp-proxy" | "mcp-token" | "listening";
  ts: string;
  server?: string;
  /** mcp-proxy: upstream response status (or 0 when unreachable). */
  status?: number;
  method?: string;
  /** mcp-token: whether the refresh response rotated the refresh token. */
  rotated?: boolean;
  error?: string;
  port?: number;
}

export interface McpProxyOptions {
  upstreams: Record<string, McpUpstream>;
  /** Initial refresh tokens by server name (the only secrets handed in). */
  refreshTokens: Record<string, string>;
  /** 0 (default) picks a random free port. Sidecar runs pass a fixed one. */
  port?: number;
  /** Bind address. Default 0.0.0.0 (must accept from the attempt network). */
  hostname?: string;
  /** Where rotated refresh tokens are persisted, one file per server. */
  tokenStateDir?: string;
  onEvent?: (event: McpProxyEvent) => void;
}

export interface McpProxyHandle {
  port: number;
  close(): Promise<void>;
}

/** Access tokens are refreshed this many ms before their stated expiry. */
const EXPIRY_SLACK_MS = 30_000;
/** Assumed lifetime when the token response omits expires_in. */
const DEFAULT_EXPIRES_IN_S = 300;

/**
 * Canonical server-name sanitizer, shared BY CONVENTION with
 * src/isolation/docker.ts (env-var suffixes) — this file cannot import it.
 */
export function sanitizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

/** Request headers forwarded upstream; everything else (esp. host) is dropped. */
const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
/** Response headers forwarded back to the agent. */
const FORWARD_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"];

interface TokenState {
  refreshToken: string;
  accessToken?: string;
  expiresAtMs?: number;
  /** Single-flight guard: concurrent requests share one refresh. */
  inflight?: Promise<void>;
}

class RefreshError extends Error {
  readonly oauthCode: string;

  constructor(oauthCode: string) {
    super(\`token refresh failed: \${oauthCode}\`);
    this.oauthCode = oauthCode;
  }
}

export function startMcpProxy(options: McpProxyOptions): McpProxyHandle {
  const emit = (event: Omit<McpProxyEvent, "ts">): void => {
    options.onEvent?.({ ...event, ts: new Date().toISOString() });
  };
  const states = new Map<string, TokenState>();
  for (const name of Object.keys(options.upstreams)) {
    const refreshToken = options.refreshTokens[name];
    if (refreshToken === undefined || refreshToken === "") {
      throw new Error(\`mcp-proxy: no refresh token provided for upstream "\${name}"\`);
    }
    states.set(name, { refreshToken });
  }

  const persistRefreshToken = (name: string, token: string): void => {
    if (!options.tokenStateDir) return;
    const path = join(options.tokenStateDir, \`\${sanitizeServerName(name)}.refresh-token\`);
    writeFileSync(path, \`\${token}\\n\`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  };
  if (options.tokenStateDir) {
    mkdirSync(options.tokenStateDir, { recursive: true, mode: 0o700 });
    // Written at startup too, so teardown read-back never races the first
    // rotation and always finds a file per server.
    for (const [name, state] of states) persistRefreshToken(name, state.refreshToken);
  }

  async function refresh(name: string, upstream: McpUpstream, state: TokenState): Promise<void> {
    const response = await fetch(upstream.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: state.refreshToken,
        client_id: upstream.clientId,
        ...(upstream.resource !== undefined ? { resource: upstream.resource } : {}),
      }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof body["access_token"] !== "string") {
      const code = typeof body["error"] === "string" ? body["error"] : \`http_\${response.status}\`;
      throw new RefreshError(code);
    }
    state.accessToken = body["access_token"];
    const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : DEFAULT_EXPIRES_IN_S;
    state.expiresAtMs = Date.now() + expiresIn * 1000;
    const rotated = typeof body["refresh_token"] === "string" && body["refresh_token"] !== state.refreshToken;
    if (rotated) {
      state.refreshToken = body["refresh_token"] as string;
      persistRefreshToken(name, state.refreshToken);
    }
    emit({ type: "mcp-token", server: name, rotated });
  }

  async function ensureToken(name: string, upstream: McpUpstream, force = false): Promise<string> {
    const state = states.get(name) as TokenState;
    const fresh = state.accessToken !== undefined && state.expiresAtMs !== undefined && Date.now() < state.expiresAtMs - EXPIRY_SLACK_MS;
    if (!force && fresh) return state.accessToken as string;
    if (!state.inflight) {
      state.inflight = refresh(name, upstream, state).finally(() => {
        state.inflight = undefined;
      });
    }
    await state.inflight;
    return state.accessToken as string;
  }

  function forward(upstream: McpUpstream, request: Request, body: ArrayBuffer | undefined, accessToken: string): Promise<Response> {
    const headers = new Headers({ authorization: \`Bearer \${accessToken}\` });
    for (const header of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(header);
      if (value !== null) headers.set(header, value);
    }
    return fetch(upstream.url, { method: request.method, headers, ...(body !== undefined ? { body } : {}) });
  }

  const server = Bun.serve({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port ?? 0,
    idleTimeout: 0, // SSE streams are long-lived by design
    async fetch(request) {
      const name = new URL(request.url).pathname.replace(/^\\//, "");
      const upstream = options.upstreams[name];
      if (!upstream) return Response.json({ error: "unknown_server", server: name }, { status: 404 });

      try {
        // JSON-RPC requests are small — buffer ONCE (a request body cannot be
        // re-read, and the 401 path forwards it twice). RESPONSES stream
        // (SSE sessions are long-lived and unbounded).
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
        let token = await ensureToken(name, upstream);
        let response = await forward(upstream, request, body, token);
        if (response.status === 401) {
          // The cached token may have been revoked upstream — refresh once
          // and retry once; a second 401 is the upstream's real answer.
          token = await ensureToken(name, upstream, true);
          response = await forward(upstream, request, body, token);
        }
        emit({ type: "mcp-proxy", server: name, method: request.method, status: response.status });
        const headers = new Headers();
        for (const header of FORWARD_RESPONSE_HEADERS) {
          const value = response.headers.get(header);
          if (value !== null) headers.set(header, value);
        }
        return new Response(response.body, { status: response.status, headers });
      } catch (error) {
        const detail = error instanceof RefreshError ? error.oauthCode : "upstream_unreachable";
        emit({ type: "mcp-proxy", server: name, method: request.method, status: 0, error: detail });
        return Response.json({ error: "mcp_proxy_error", detail }, { status: 502 });
      }
    },
  });

  emit({ type: "listening", port: server.port ?? options.port ?? 0 });
  return {
    port: server.port ?? options.port ?? 0,
    close: async () => {
      await server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Sidecar entrypoint (images/mcp-proxy/Dockerfile). Config via env:
//   QUICKSTUDY_MCP_UPSTREAMS               JSON {name: McpUpstream} (required)
//   QUICKSTUDY_MCP_REFRESH_TOKEN_<NAME>    initial refresh token per server,
//                                          NAME per sanitizeServerName
//   QUICKSTUDY_MCP_PORT                    listen port (default 8914)
//   QUICKSTUDY_MCP_TOKEN_STATE_DIR         rotation files (default /run/quickstudy-mcp)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const rawUpstreams = process.env["QUICKSTUDY_MCP_UPSTREAMS"];
  if (!rawUpstreams) {
    console.error("mcp-proxy: QUICKSTUDY_MCP_UPSTREAMS is required");
    process.exit(1);
  }
  const upstreams = JSON.parse(rawUpstreams) as Record<string, McpUpstream>;
  const refreshTokens: Record<string, string> = {};
  for (const name of Object.keys(upstreams)) {
    const token = process.env[\`QUICKSTUDY_MCP_REFRESH_TOKEN_\${sanitizeServerName(name)}\`];
    if (!token) {
      console.error(\`mcp-proxy: missing QUICKSTUDY_MCP_REFRESH_TOKEN_\${sanitizeServerName(name)}\`);
      process.exit(1);
    }
    refreshTokens[name] = token;
  }
  startMcpProxy({
    upstreams,
    refreshTokens,
    port: Number(process.env["QUICKSTUDY_MCP_PORT"] ?? 8914),
    tokenStateDir: process.env["QUICKSTUDY_MCP_TOKEN_STATE_DIR"] ?? "/run/quickstudy-mcp",
    onEvent: (event) => console.log(JSON.stringify(event)),
  });
}
`,
};
