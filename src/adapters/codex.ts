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
 * Endpoint overrides: an OPENAI_BASE_URL set on the host (an LLM gateway) is
 * rendered into the same config.toml as a custom model provider — codex
 * 0.149 ignores the env var for its built-in provider (verified live: it
 * still dialed api.openai.com), while a `[model_providers.*]` entry with
 * `env_key = "OPENAI_API_KEY"` routes every request through the override.
 * OPENAI_CUSTOM_HEADERS (`Name: Value` lines, the Codex counterpart of Claude
 * Code's ANTHROPIC_CUSTOM_HEADERS) becomes that provider's `http_headers` —
 * e.g. `cf-aig-metadata` so a gateway can attribute the traffic. Codex has
 * no env-var channel for extra headers, so the values land in config.toml
 * inside the attempt container: the same trust boundary as the env that
 * already carries them, written over stdin, destroyed with the container.
 * With neither override set nothing is rendered and the built-in provider
 * talks to api.openai.com — vendor-direct stays the default.
 */

import type { McpServerConfig } from "../isolation/mcp.ts";
import { endpointUrl, parseHeaderLines } from "../secrets.ts";
import { parseCodexStream } from "./parse.ts";
import type { AttemptMetrics, ContainerAgentAdapter, ContainerAttemptContext } from "./types.ts";

/** Container path of the Codex config (containers run as root). */
export const CODEX_CONFIG_PATH = "/root/.codex/config.toml";

/** The config.toml model provider id the OPENAI_* overrides are rendered as. */
export const CODEX_GATEWAY_PROVIDER = "quickstudy-gateway";

/** Codex's own default for the built-in provider; the probe and a headers-only override use it. */
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * A custom model provider pointing at `baseUrl` (the Responses API, which
 * codex requires), carrying `headers` on every request, selected as the
 * default. Top-level keys must precede any table, so this block always
 * renders first in the file. JSON string escapes are valid TOML basic-string
 * escapes, which keeps header values such as JSON metadata intact.
 */
function renderCodexProviderToml(baseUrl: string, headers: Readonly<Record<string, string>>): string {
  const entries = Object.entries(headers);
  return [
    `model_provider = ${JSON.stringify(CODEX_GATEWAY_PROVIDER)}`,
    "",
    `[model_providers.${CODEX_GATEWAY_PROVIDER}]`,
    'name = "OpenAI (quickstudy endpoint overrides)"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    ...(entries.length > 0
      ? [`http_headers = { ${entries.map(([name, value]) => `${JSON.stringify(name)} = ${JSON.stringify(value)}`).join(", ")} }`]
      : []),
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
   * Endpoint overrides, forwarded only when set: OPENAI_BASE_URL (vendor
   * default https://api.openai.com/v1) — e.g. Cloudflare AI Gateway's
   * `/openai` endpoint, where the gateway token doubles as OPENAI_API_KEY —
   * and OPENAI_CUSTOM_HEADERS (`Name: Value` lines) for whatever else the
   * endpoint wants on each request, such as `cf-aig-metadata`. Both are
   * rendered into config.toml by setupFiles (see the module comment); the
   * key probe follows them.
   */
  readonly optionalHostEnv = ["OPENAI_BASE_URL", "OPENAI_CUSTOM_HEADERS"] as const;
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
      url: endpointUrl(env["OPENAI_BASE_URL"], OPENAI_DEFAULT_BASE_URL, "models"),
      headers: { ...parseHeaderLines(env["OPENAI_CUSTOM_HEADERS"]), Authorization: `Bearer ${env["OPENAI_API_KEY"] ?? ""}` },
    };
  }

  setupFiles(ctx: ContainerAttemptContext): Record<string, string> {
    const sections: string[] = [];
    const baseUrl = ctx.overrides?.["OPENAI_BASE_URL"];
    const headers = parseHeaderLines(ctx.overrides?.["OPENAI_CUSTOM_HEADERS"]);
    // Either override needs the custom provider; headers alone keep the vendor endpoint.
    if (baseUrl !== undefined || Object.keys(headers).length > 0) {
      sections.push(renderCodexProviderToml(baseUrl ?? OPENAI_DEFAULT_BASE_URL, headers));
    }
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
