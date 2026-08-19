/**
 * The MCP token-injecting proxy: attempt containers speak plain,
 * credential-free HTTP to `http://<sidecar>:<port>/<serverName>`, and this
 * proxy forwards each request to the real streamable-HTTP MCP server with
 * `Authorization: Bearer <access token>` attached.
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
 * `<tokenStateDir>/<name>.refresh-token` (0600). The harness reads that
 * file back (docker exec) at teardown and persists it for the next run —
 * losing it costs the operator a re-login, nothing worse.
 *
 * Like the egress proxy, this file is self-contained (the sidecar image
 * copies it alone) and doubles as the container entrypoint. Events go to
 * `onEvent` in-process and stdout JSON lines in the sidecar; token VALUES
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
    super(`token refresh failed: ${oauthCode}`);
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
      throw new Error(`mcp-proxy: no refresh token provided for upstream "${name}"`);
    }
    states.set(name, { refreshToken });
  }

  const persistRefreshToken = (name: string, token: string): void => {
    if (!options.tokenStateDir) return;
    const path = join(options.tokenStateDir, `${sanitizeServerName(name)}.refresh-token`);
    writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
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
      const code = typeof body["error"] === "string" ? body["error"] : `http_${response.status}`;
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
    const headers = new Headers({ authorization: `Bearer ${accessToken}` });
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
      const name = new URL(request.url).pathname.replace(/^\//, "");
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
    const token = process.env[`QUICKSTUDY_MCP_REFRESH_TOKEN_${sanitizeServerName(name)}`];
    if (!token) {
      console.error(`mcp-proxy: missing QUICKSTUDY_MCP_REFRESH_TOKEN_${sanitizeServerName(name)}`);
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
