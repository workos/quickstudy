/**
 * Claude Code adapter: drives the `claude` CLI headless inside the attempt
 * container.
 *
 * `--dangerously-skip-permissions` is acceptable here ONLY because the
 * container is the security boundary — a fresh filesystem, one write-only
 * results mount, and force-removal after grading.
 *
 * Treatment differences are environmental, never prompt-level: the MCP
 * treatment places `.mcp.json` into /workspace before start; the CLI
 * treatment relies on the runtime-exposed PATH directory; the web treatment
 * leaves native web tools enabled. The task prompt stays byte-identical
 * across experiments.
 */

import { type ResolvedEndpoint, resolveEndpoint } from "../experiments/endpoint.ts";
import type { AgentEndpointSpec } from "../experiments/types.ts";
import type { McpServerConfig } from "../isolation/mcp.ts";
import { endpointUrl, parseHeaderLines } from "../secrets.ts";
import { parseClaudeStream } from "./parse.ts";
import type { AttemptMetrics, ContainerAgentAdapter, ContainerAttemptContext } from "./types.ts";

/** Container path of the MCP config Claude Code auto-discovers. */
export const CLAUDE_MCP_CONFIG_PATH = "/workspace/.mcp.json";

/**
 * The vendor's env names: what every claude experiment gets unless its
 * `agent.endpoint` names something else (experiments/endpoint.ts). The wire
 * is fixed — Claude Code speaks the Messages API and nothing else.
 */
export const CLAUDE_DEFAULT_ENDPOINT: ResolvedEndpoint = {
  apiKeyEnv: "ANTHROPIC_API_KEY",
  baseUrlEnv: "ANTHROPIC_BASE_URL",
  headersEnv: "ANTHROPIC_CUSTOM_HEADERS",
  wireApi: "responses",
};

/**
 * Project-scope `.mcp.json` rendered from the runtime's MCP servers
 * (streamable HTTP). The configs arrive credential-free — authed servers
 * already point at the token-proxy sidecar — so only the URL is rendered.
 */
function renderMcpJson(servers: Readonly<Record<string, McpServerConfig>> = {}): string {
  const mcpServers = Object.fromEntries(
    Object.entries(servers).map(([name, spec]) => [name, { type: "http", url: spec.url }]),
  );
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

export class ClaudeCodeAdapter implements ContainerAgentAdapter {
  readonly kind = "container" as const;
  readonly name: string;
  readonly identity;
  readonly versionCommand = ["claude", "--version"] as const;
  /**
   * The env names this experiment's traffic is routed by: the vendor's
   * (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_CUSTOM_HEADERS)
   * unless `agent.endpoint` named others. Claude Code only ever reads the
   * vendor names, so custom names are re-exported under them by a shell shim
   * in `command` — inside the container, from env the harness already placed.
   */
  readonly endpoint: ResolvedEndpoint;
  /** The key variable: required on the host, forwarded into the container. */
  readonly requiredHostEnv: readonly string[];
  /**
   * Endpoint overrides, forwarded only when set. The base URL variable routes
   * the CLI (and the key probe) through an Anthropic-compatible gateway —
   * e.g. Cloudflare AI Gateway's `/anthropic` endpoint, where the gateway
   * token doubles as the API key; the headers variable (`Name: Value`
   * lines) carries whatever else that gateway wants, such as
   * `cf-aig-authorization` or `cf-aig-metadata`. Claude Code reads both
   * natively under the vendor names, so no flag changes.
   */
  readonly optionalHostEnv: readonly string[];
  /**
   * Egress-proxy allowlist (harness-default layer). Claude Code documents
   * corporate-proxy support via HTTPS_PROXY/HTTP_PROXY; api.anthropic.com is
   * the default LLM endpoint (an ANTHROPIC_BASE_URL override adds its own
   * host at run time), statsig/sentry are its telemetry (allowed so denial
   * logs stay signal, not noise). Verified live by the egress-proxy regression
   * check (`bun scripts/dev-attempt.ts --experiment <id> --egress-proxy`).
   */
  readonly egressHosts = ["api.anthropic.com", "statsig.anthropic.com", "*.sentry.io"] as const;

  constructor(
    name = "claude",
    config: { model?: string; reasoning?: string; provider?: string; endpoint?: AgentEndpointSpec } = {},
  ) {
    this.name = name;
    this.endpoint = resolveEndpoint(name, CLAUDE_DEFAULT_ENDPOINT, config.endpoint);
    this.requiredHostEnv = [this.endpoint.apiKeyEnv];
    this.optionalHostEnv = [this.endpoint.baseUrlEnv, this.endpoint.headersEnv];
    this.identity = {
      provider: config.provider ?? "anthropic",
      model: config.model ?? "UNPINNED",
      reasoning: config.reasoning ?? "UNPINNED",
      cliVersion: "unknown",
      surfacePolicies: {
        docs: "native WebSearch/WebFetch allowed",
        mcp: "--disallowedTools WebSearch,WebFetch; MCP configured",
        cli: "--disallowedTools WebSearch,WebFetch",
      },
      nativeWebControl: "controlled" as const,
      reproducible: true,
    };
  }

  keyProbe(env: Record<string, string>): { url: string; headers: Record<string, string> } {
    return {
      url: endpointUrl(env[this.endpoint.baseUrlEnv], "https://api.anthropic.com", "v1/models"),
      headers: {
        ...parseHeaderLines(env[this.endpoint.headersEnv]),
        "x-api-key": env[this.endpoint.apiKeyEnv] ?? "",
        "anthropic-version": "2023-06-01",
      },
    };
  }

  /**
   * `export VENDOR="$CUSTOM"` lines for every endpoint variable whose name
   * differs from the vendor's — empty when nothing differs, so the default
   * invocation stays the bare `claude` argv. Optional variables are only
   * re-exported when set: an empty ANTHROPIC_BASE_URL would be a base URL.
   *
   * A custom key variable is presented both ways Claude Code can send a
   * credential — `x-api-key` (ANTHROPIC_API_KEY) and `Authorization:
   * Bearer` (ANTHROPIC_AUTH_TOKEN) — because gateways differ on which one
   * they read: a provider-native Anthropic route takes the key header, a
   * unified API takes the bearer. The vendor's own route only ever sees
   * the vendor variable, so this changes nothing for it.
   */
  private endpointExports(): string[] {
    const lines: string[] = [];
    const { apiKeyEnv, baseUrlEnv, headersEnv } = this.endpoint;
    if (apiKeyEnv !== CLAUDE_DEFAULT_ENDPOINT.apiKeyEnv) {
      lines.push(`export ANTHROPIC_API_KEY="$${apiKeyEnv}"`, `export ANTHROPIC_AUTH_TOKEN="$${apiKeyEnv}"`);
    }
    if (baseUrlEnv !== CLAUDE_DEFAULT_ENDPOINT.baseUrlEnv) {
      lines.push(`[ -n "\${${baseUrlEnv}:-}" ] && export ANTHROPIC_BASE_URL="$${baseUrlEnv}"`);
    }
    if (headersEnv !== CLAUDE_DEFAULT_ENDPOINT.headersEnv) {
      lines.push(`[ -n "\${${headersEnv}:-}" ] && export ANTHROPIC_CUSTOM_HEADERS="$${headersEnv}"`);
    }
    return lines;
  }

  setupFiles(ctx: ContainerAttemptContext): Record<string, string> {
    if (ctx.mcpServers === undefined) return {};
    return { [CLAUDE_MCP_CONFIG_PATH]: renderMcpJson(ctx.mcpServers) };
  }

  command(ctx: ContainerAttemptContext): string[] {
    const args = [
      "claude",
      "-p",
      ctx.prompt,
      // stream-json is the parseable telemetry source; it requires --verbose
      // in print mode.
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      this.identity.model,
      "--effort",
      this.identity.reasoning,
    ];
    if (ctx.mcpServers !== undefined) {
      // Explicit config beats auto-discovery: headless runs must not depend
      // on project-trust prompts.
      args.push("--mcp-config", CLAUDE_MCP_CONFIG_PATH);
    }
    if (ctx.webPolicy !== "native-web-allowed") args.push("--disallowedTools", "WebSearch,WebFetch");
    const exports = this.endpointExports();
    if (exports.length === 0) return args;
    // Custom endpoint names: re-export them under the names Claude Code reads,
    // then exec the same argv. Names only reach the shell — resolveEndpoint
    // admits POSIX env names and nothing else; values stay in the environment.
    return ["sh", "-c", `${exports.join("; ")}; exec "$@"`, "sh", ...args];
  }

  parseStream(raw: string): AttemptMetrics {
    return parseClaudeStream(raw);
  }
}
