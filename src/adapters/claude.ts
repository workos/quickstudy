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

import type { McpServerConfig } from "../isolation/mcp.ts";
import { endpointUrl, parseHeaderLines } from "../secrets.ts";
import { parseClaudeStream } from "./parse.ts";
import type { AttemptMetrics, ContainerAgentAdapter, ContainerAttemptContext } from "./types.ts";

/** Container path of the MCP config Claude Code auto-discovers. */
export const CLAUDE_MCP_CONFIG_PATH = "/workspace/.mcp.json";

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
  readonly requiredHostEnv = ["ANTHROPIC_API_KEY"] as const;
  /**
   * Endpoint overrides, forwarded only when set. ANTHROPIC_BASE_URL routes
   * the CLI (and the key probe) through an Anthropic-compatible gateway —
   * e.g. Cloudflare AI Gateway's `/anthropic` endpoint, where the gateway
   * token doubles as ANTHROPIC_API_KEY; ANTHROPIC_CUSTOM_HEADERS (`Name:
   * Value` lines) carries whatever else that gateway wants, such as
   * `cf-aig-authorization` or `cf-aig-metadata`. Claude Code reads both
   * natively, so no flag changes.
   */
  readonly optionalHostEnv = ["ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"] as const;
  /**
   * Egress-proxy allowlist (harness-default layer). Claude Code documents
   * corporate-proxy support via HTTPS_PROXY/HTTP_PROXY; api.anthropic.com is
   * the default LLM endpoint (an ANTHROPIC_BASE_URL override adds its own
   * host at run time), statsig/sentry are its telemetry (allowed so denial
   * logs stay signal, not noise). Verified live by the egress-proxy regression
   * check (`bun scripts/dev-attempt.ts --experiment <id> --egress-proxy`).
   */
  readonly egressHosts = ["api.anthropic.com", "statsig.anthropic.com", "*.sentry.io"] as const;

  constructor(name = "claude", config: { model?: string; reasoning?: string } = {}) {
    this.name = name;
    this.identity = {
      provider: "anthropic",
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
      url: endpointUrl(env["ANTHROPIC_BASE_URL"], "https://api.anthropic.com", "v1/models"),
      headers: {
        ...parseHeaderLines(env["ANTHROPIC_CUSTOM_HEADERS"]),
        "x-api-key": env["ANTHROPIC_API_KEY"] ?? "",
        "anthropic-version": "2023-06-01",
      },
    };
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
    return args;
  }

  parseStream(raw: string): AttemptMetrics {
    return parseClaudeStream(raw);
  }
}
