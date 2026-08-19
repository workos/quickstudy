/**
 * MCP auth-proxy wiring: the pure glue between runtime-declared
 * `McpServerConfig.auth` and the mcp-proxy sidecar (mcp-proxy/server.ts).
 *
 * Credentials never ride in runtime config — `auth.credentialsFile` names an
 * env-format file the owning runtime's login tooling maintains. This module
 * reads it (fail-fast with the operator's fix), rewrites the server map
 * agents see (proxy URL in, real URL + auth out), and persists rotated
 * refresh tokens back after the run — rotation means the on-disk token dies
 * the moment the sidecar refreshes, so skipping persistence would cost the
 * operator a re-login every run.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { sanitizeServerName, type McpUpstream } from "./mcp-proxy/server.ts";

/**
 * Plain OAuth refresh-token auth config for an MCP server — the v3 shape.
 * No secret values here: `credentialsFile` names an env-format file the
 * owning runtime's login tooling maintains (0600, gitignored).
 */
export interface McpServerAuthConfig {
  kind: "oauth-refresh";
  /** OAuth token endpoint for the refresh grant. */
  tokenEndpoint: string;
  /** RFC 8707 resource indicator, when the server audience-binds tokens. */
  resource?: string;
  /** Absolute path to the env-format credentials file. */
  credentialsFile: string;
  /** Key in that file holding the OAuth client id. */
  clientIdKey: string;
  /** Key in that file holding the current refresh token. */
  refreshTokenKey: string;
}

/** Plain `{url, auth}` MCP server config declared by experiment runtimes. */
export interface McpServerConfig {
  url: string;
  auth?: McpServerAuthConfig;
}

/** Everything the sidecar needs: config (loggable) + secrets (never logged). */
export interface McpAuthMaterial {
  upstreams: Record<string, McpUpstream>;
  /** Refresh tokens by server name — env-file-only, never argv or logs. */
  refreshTokens: Record<string, string>;
}

/** Servers whose config carries an `auth` block. */
export function authedMcpServers<T extends McpServerConfig>(servers: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(servers).filter(([, spec]) => spec.auth !== undefined));
}

function parseEnvFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.trimStart().startsWith("#")) values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return values;
}

/**
 * Read every authed server's credentials file into sidecar material.
 * Failures are fail-fast and actionable: a missing file or key means the
 * operator has not run the owning login tooling (or its token store
 * moved) — starting the run would burn attempts on guaranteed auth errors.
 */
export function readMcpAuthMaterialFromConfig(servers: Record<string, McpServerConfig>): McpAuthMaterial {
  const upstreams: Record<string, McpUpstream> = {};
  const refreshTokens: Record<string, string> = {};
  const sanitized = new Map<string, string>();

  for (const [name, spec] of Object.entries(servers)) {
    const auth = spec.auth;
    if (!auth) continue;

    const clash = sanitized.get(sanitizeServerName(name));
    if (clash !== undefined) {
      throw new Error(`mcp servers "${clash}" and "${name}" collide after name sanitization — rename one`);
    }
    sanitized.set(sanitizeServerName(name), name);

    if (!existsSync(auth.credentialsFile)) {
      throw new Error(
        `mcp server "${name}": credentials file ${auth.credentialsFile} does not exist — ` +
          `run the owning runtime's MCP login tooling to create it, or deselect the MCP-treatment experiment`,
      );
    }
    const values = parseEnvFile(readFileSync(auth.credentialsFile, "utf8"));
    const clientId = values.get(auth.clientIdKey);
    const refreshToken = values.get(auth.refreshTokenKey);
    if (!clientId || !refreshToken) {
      throw new Error(
        `mcp server "${name}": ${auth.credentialsFile} lacks ${auth.clientIdKey} and/or ${auth.refreshTokenKey} — ` +
          `re-run the owning runtime's MCP login tooling`,
      );
    }
    upstreams[name] = {
      url: spec.url,
      tokenEndpoint: auth.tokenEndpoint,
      clientId,
      ...(auth.resource !== undefined ? { resource: auth.resource } : {}),
    };
    refreshTokens[name] = refreshToken;
  }
  return { upstreams, refreshTokens };
}

/**
 * The server map agents actually see: authed servers point at the sidecar
 * (`<proxyBase>/<name>`), auth blocks are stripped everywhere — adapters
 * render vendor config from this and must never carry credential material.
 */
export function rewriteMcpServerConfigs(
  servers: Record<string, McpServerConfig>,
  proxyBase: string,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, spec]) => [
      name,
      { url: spec.auth !== undefined ? `${proxyBase}/${encodeURIComponent(name)}` : spec.url },
    ]),
  );
}

/**
 * Write a rotated refresh token back to its credentials file, preserving
 * every other line. 0600 like the login tooling that created it.
 */
export function persistRotatedRefreshToken(spec: McpServerConfig, rotatedToken: string): void {
  const auth = spec.auth;
  if (!auth) return;
  const lines = existsSync(auth.credentialsFile) ? readFileSync(auth.credentialsFile, "utf8").split("\n") : [];
  const prefix = `${auth.refreshTokenKey}=`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index >= 0) lines[index] = `${prefix}${rotatedToken}`;
  else {
    while (lines.at(-1) === "") lines.pop();
    lines.push(`${prefix}${rotatedToken}`, "");
  }
  writeFileSync(auth.credentialsFile, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  chmodSync(auth.credentialsFile, 0o600);
}
