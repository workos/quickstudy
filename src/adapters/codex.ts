/**
 * Codex CLI adapter: drives `codex exec --json` headless inside the attempt
 * container.
 *
 * Sandbox/approval bypass is acceptable ONLY because the container is the
 * security boundary (same rationale as the Claude adapter). MCP treatment
 * config lives in `~/.codex/config.toml` in-container — Codex has no
 * per-project MCP file. Auth: the OPENAI_API_KEY env var is injected at
 * container create.
 */

import type { McpServerConfig } from "../isolation/mcp.ts";
import { parseCodexStream } from "./parse.ts";
import type { AttemptMetrics, ContainerAgentAdapter, ContainerAttemptContext } from "./types.ts";

/** Container path of the Codex config (containers run as root). */
export const CODEX_CONFIG_PATH = "/root/.codex/config.toml";

/**
 * `config.toml` MCP table rendered from the runtime's MCP servers (url-based,
 * credential-free — authed servers already point at the token-proxy sidecar).
 * Server names outside TOML's bare-key charset get quoted.
 */
function renderCodexMcpToml(servers: Readonly<Record<string, McpServerConfig>> = {}): string {
  const blocks = Object.entries(servers).map(([name, spec]) => {
    const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
    return `[mcp_servers.${key}]\nurl = ${JSON.stringify(spec.url)}\n`;
  });
  return blocks.length > 0 ? blocks.join("\n") : "[mcp_servers]\n";
}

export class CodexAdapter implements ContainerAgentAdapter {
  readonly kind = "container" as const;
  readonly name: string;
  readonly identity;
  readonly versionCommand = ["codex", "--version"] as const;
  readonly requiredHostEnv = ["OPENAI_API_KEY"] as const;
  /**
   * Egress-proxy allowlist (harness-default layer). Codex is reqwest-based;
   * reqwest honors HTTP_PROXY/HTTPS_PROXY env by default (system proxies) —
   * verified live by the egress-proxy regression check (the CONNECT tunnel
   * to api.openai.com round-tripped). chatgpt.com came from that run's
   * denial log: codex probes its ChatGPT-auth endpoints even under key auth.
   * (Its github.com update-check denials are left denied on purpose.)
   */
  readonly egressHosts = ["api.openai.com", "auth.openai.com", "chatgpt.com", "*.chatgpt.com"] as const;

  constructor(name = "codex", config: { model?: string; reasoning?: string } = {}) {
    this.name = name;
    this.identity = {
      provider: "openai",
      model: config.model ?? "UNPINNED",
      reasoning: config.reasoning ?? "UNPINNED",
      cliVersion: "unknown",
      surfacePolicies: {
        docs: 'web_search="live"',
        mcp: 'web_search="disabled"; MCP configured',
        cli: 'web_search="disabled"',
      },
      nativeWebControl: "controlled" as const,
      reproducible: true,
    };
  }

  keyProbe(env: Record<string, string>): { url: string; headers: Record<string, string> } {
    return {
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: `Bearer ${env["OPENAI_API_KEY"] ?? ""}` },
    };
  }

  setupFiles(ctx: ContainerAttemptContext): Record<string, string> {
    if (ctx.mcpServers === undefined) return {};
    return { [CODEX_CONFIG_PATH]: renderCodexMcpToml(ctx.mcpServers) };
  }

  command(ctx: ContainerAttemptContext): string[] {
    return [
      "codex",
      "exec",
      "--json",
      "--model",
      this.identity.model,
      "--config",
      `model_reasoning_effort=${JSON.stringify(this.identity.reasoning)}`,
      "--config",
      `web_search=${JSON.stringify(ctx.webPolicy === "native-web-allowed" ? "live" : "disabled")}`,
      // The container is the boundary; codex's own sandbox would fight the
      // fixture's build tooling for no additional isolation.
      "--dangerously-bypass-approvals-and-sandbox",
      ctx.prompt,
    ];
  }

  parseStream(raw: string): AttemptMetrics {
    return parseCodexStream(raw);
  }
}
