/**
 * Codex CLI adapter: drives `codex exec --json` headless inside the attempt
 * container.
 *
 * Sandbox/approval bypass is acceptable ONLY because the container is the
 * security boundary (same rationale as the Claude adapter). MCP treatment
 * config lives in `~/.codex/config.toml` in-container — Codex has no
 * per-project MCP file. Auth: the OPENAI_API_KEY env var is injected at
 * container create, but codex >= 0.144 no longer reads it directly — the
 * command wrapper pipes it into `codex login --with-api-key` (stdin, never
 * argv) to write the auth.json the CLI requires.
 *
 * Endpoint override: an OPENAI_BASE_URL set on the host (an LLM gateway) is
 * rendered into the same config.toml as a custom model provider — codex
 * 0.149 ignores the env var for its built-in provider (verified live: it
 * still dialed api.openai.com), while a `[model_providers.*]` entry with
 * `env_key = "OPENAI_API_KEY"` routes every request through the override.
 */

import type { McpServerConfig } from "../isolation/mcp.ts";
import { endpointUrl } from "../secrets.ts";
import { parseCodexStream } from "./parse.ts";
import type { AttemptMetrics, ContainerAgentAdapter, ContainerAttemptContext } from "./types.ts";

/** Container path of the Codex config (containers run as root). */
export const CODEX_CONFIG_PATH = "/root/.codex/config.toml";

/** The config.toml model provider id an OPENAI_BASE_URL override is rendered as. */
export const CODEX_GATEWAY_PROVIDER = "quickstudy-gateway";

/**
 * A custom model provider pointing at `baseUrl` (the Responses API, which
 * codex requires), selected as the default. Top-level keys must precede any
 * table, so this block always renders first in the file.
 */
function renderCodexProviderToml(baseUrl: string): string {
  return [
    `model_provider = ${JSON.stringify(CODEX_GATEWAY_PROVIDER)}`,
    "",
    `[model_providers.${CODEX_GATEWAY_PROVIDER}]`,
    'name = "OpenAI (via OPENAI_BASE_URL)"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    "",
  ].join("\n");
}

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
   * Endpoint override, forwarded only when set: OPENAI_BASE_URL (vendor
   * default https://api.openai.com/v1) — e.g. Cloudflare AI Gateway's
   * `/openai` endpoint, where the gateway token doubles as OPENAI_API_KEY.
   * Rendered into config.toml by setupFiles (see the module comment); the
   * key probe follows it.
   */
  readonly optionalHostEnv = ["OPENAI_BASE_URL"] as const;
  /**
   * Egress-proxy allowlist (harness-default layer). Codex is reqwest-based;
   * reqwest honors HTTP_PROXY/HTTPS_PROXY env by default (system proxies) —
   * verified live by the egress-proxy regression check (the CONNECT tunnel
   * to api.openai.com round-tripped). chatgpt.com came from that run's
   * denial log: codex probes its ChatGPT-auth endpoints even under key auth.
   * (Its github.com update-check denials are left denied on purpose.) An
   * OPENAI_BASE_URL override adds its own host at run time.
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
      url: endpointUrl(env["OPENAI_BASE_URL"], "https://api.openai.com/v1", "models"),
      headers: { Authorization: `Bearer ${env["OPENAI_API_KEY"] ?? ""}` },
    };
  }

  setupFiles(ctx: ContainerAttemptContext): Record<string, string> {
    const sections: string[] = [];
    const baseUrl = ctx.overrides?.["OPENAI_BASE_URL"];
    if (baseUrl !== undefined) sections.push(renderCodexProviderToml(baseUrl));
    if (ctx.mcpServers !== undefined) sections.push(renderCodexMcpToml(ctx.mcpServers));
    if (sections.length === 0) return {};
    return { [CODEX_CONFIG_PATH]: sections.join("\n") };
  }

  command(ctx: ContainerAttemptContext): string[] {
    return [
      "sh",
      "-c",
      // codex 0.144+ ignores the OPENAI_API_KEY env var; mint auth.json from
      // it in-container. Login chatter is silenced so stdout stays pure JSONL
      // for parseStream; the key reaches login via stdin, never argv.
      'printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1 && exec "$@"',
      "sh",
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
