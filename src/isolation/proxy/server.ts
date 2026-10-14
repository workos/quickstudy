/**
 * The egress allowlist proxy: a small HTTP CONNECT / absolute-form forward
 * proxy (no squid dependency, no TLS interception).
 *
 * Attempt containers sit on an internal Docker network with no default
 * route; this proxy straddles that network and the bridge, and the attempt
 * env carries HTTP_PROXY/HTTPS_PROXY pointing here. For HTTPS the proxy sees
 * only the CONNECT `host:port` — allowlist enforcement is hostname-granular,
 * traffic is never decrypted. Deny-by-default; denials answer 403 naming the
 * host; raw-IP CONNECT targets are refused outright (no DNS-bypass hole).
 *
 * Every decision (allowed AND denied) is emitted as one stable JSON event —
 * to `onEvent` in-process, and as a JSON line on stdout when run as the
 * sidecar entrypoint. Denials become the attempt's `egress-denials.log`
 * artifact; zero allowed connections from an errored attempt is the
 * `egress_no_route` signal (an agent whose HTTP stack ignored proxy env).
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
  /** Validated at start; entries are exact hosts or `*.domain` wildcards. */
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
    `HTTP/1.1 ${status} ${statusText}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: close\r\n\r\n" +
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
      const headEnd = buffered.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        if (buffered.length > MAX_HEAD_BYTES) {
          done = true;
          clearTimeout(headTimer);
          writeAndClose(client, httpError(400, "Bad Request", "request head too large\n"));
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
  const lines = head.split("\r\n");
  const requestLine = lines[0] ?? "";
  const parts = requestLine.split(" ");
  if (parts.length !== 3) {
    emit(parts[0] ?? "?", "", 0, "denied", "bad_request");
    writeAndClose(client, httpError(400, "Bad Request", `malformed request line: "${requestLine}"\n`));
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
      httpError(403, "Forbidden", `egress blocked: raw-IP targets are refused ("${normalized}") — use a hostname\n`),
    );
    return false;
  }
  if (!hostAllowed(normalized, allowlist)) {
    emit(method, normalized, port, "denied", "not_allowlisted");
    writeAndClose(
      client,
      httpError(403, "Forbidden", `egress blocked: "${normalized}" is not on this run's egress allowlist\n`),
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
      writeAndClose(client, httpError(502, "Bad Gateway", `upstream connect to ${host}:${port} failed: ${err.message}\n`));
    } else {
      client.destroy();
    }
  });
}

/**
 * Bidirectional tunnel wiring shared by CONNECT and plain forwards.
 *
 * `pipe()` already ends the destination once the source ends — after the
 * buffered bytes have flushed. Destroying the client on the upstream's
 * `close` threw that buffer away: an upstream that closes right after a
 * large response (a registry tarball) left the client with a truncated body
 * and an ECONNRESET, so `npm install` through the proxy failed at random.
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
    writeAndClose(client, httpError(400, "Bad Request", `malformed CONNECT target: "${target}"\n`));
    return;
  }
  if (!gate(client, "CONNECT", parsed.host, parsed.port, emit, allowlist)) return;

  dialUpstream(client, normalizeHost(parsed.host), parsed.port, (upstream) => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // Bytes the client sent eagerly after its head (e.g. an early TLS hello).
    if (remainder.length > 0) upstream.write(remainder);
    pipeBoth(client, upstream);
    client.resume();
  });
}

/**
 * Plain-HTTP forward: proxy clients send absolute-form URIs
 * (`GET http://host/path HTTP/1.1`). The request is rewritten to origin form
 * with `Connection: close` (one exchange per connection — simple beats
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
      httpError(400, "Bad Request", `expected an absolute-form proxy request URI, got "${target}"\n`),
    );
    return;
  }
  if (url.protocol !== "http:") {
    emit(method, url.hostname, 0, "denied", "bad_request");
    writeAndClose(client, httpError(400, "Bad Request", `unsupported scheme "${url.protocol}" (https uses CONNECT)\n`));
    return;
  }
  const host = url.hostname;
  const port = url.port === "" ? 80 : Number(url.port);
  if (!gate(client, method, host, port, emit, allowlist)) return;

  const kept = headerLines.filter((line) => !DROPPED_HEADERS.test(line.split(":")[0] ?? ""));
  const originForm = `${url.pathname}${url.search}`;
  // Head assembled as lines and joined ONCE: an empty `kept` must not leave
  // a blank line after the request line (that would end the header block
  // early and push "Connection: close" into the body).
  const rewritten = [`${method} ${originForm === "" ? "/" : originForm} HTTP/1.1`, ...kept, "Connection: close", "", ""].join(
    "\r\n",
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
 * back with `docker logs` for per-attempt denial artifacts.
 */
if (import.meta.main) {
  const rawList = process.env["QUICKSTUDY_EGRESS_ALLOWLIST"] ?? "";
  const allowlist = rawList
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const port = Number(process.env["QUICKSTUDY_EGRESS_PORT"] ?? "3128");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`egress-proxy: invalid QUICKSTUDY_EGRESS_PORT "${process.env["QUICKSTUDY_EGRESS_PORT"]}"`);
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
    console.error(`egress-proxy: failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
