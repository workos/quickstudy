import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeAdapter, CLAUDE_MCP_CONFIG_PATH } from "../src/adapters/claude.ts";
import { CodexAdapter, CODEX_CONFIG_PATH, CODEX_DEFAULT_ENDPOINT, CODEX_GATEWAY_PROVIDER } from "../src/adapters/codex.ts";
import { parseClaudeStream, parseCodexStream, parseJsonlLines } from "../src/adapters/parse.ts";
import type { ContainerAttemptContext } from "../src/adapters/types.ts";
import { keyProbeIdentity } from "../src/runner/execute.ts";

const STREAMS_DIR = join(import.meta.dir, "__fixtures__", "streams");

function stream(name: string): string {
  return readFileSync(join(STREAMS_DIR, name), "utf8");
}

/** Vendor-agnostic MCP servers, as the runner injects on MCP-treatment attempts. */
const MCP_SERVERS = { acme: { url: "https://mcp.acme.test/mcp" } } as const;

/** The three treatment shapes the runner composes contexts for. */
function ctxFor(treatment: "web" | "mcp" | "none"): ContainerAttemptContext {
  return {
    runId: "run-1",
    attemptId: "attempt-1",
    prompt: "Add a NOTES.md describing how to integrate widgets into an alpha application.",
    trialIndex: 0,
    // The runner passes the runtime's (credential-free) servers on the MCP
    // treatment only, and the runtime's web policy always.
    ...(treatment === "mcp" ? { mcpServers: MCP_SERVERS } : {}),
    webPolicy: treatment === "web" ? "native-web-allowed" : "native-web-blocked",
  };
}

describe("parse", () => {
  test("parseJsonlLines skips non-JSON noise without throwing", () => {
    const objects = parseJsonlLines(stream("malformed.jsonl"));
    expect(objects).toHaveLength(1); // only the one intact assistant event
  });

  test("claude stream: result event is the authoritative telemetry source", () => {
    const metrics = parseClaudeStream(stream("claude.jsonl"));
    // input 12 + cache_creation 2048 + cache_read 10240
    expect(metrics.tokensIn).toBe(12300);
    expect(metrics.tokensOut).toBe(345);
    expect(metrics.turns).toBe(3);
    expect(metrics.costUsd).toBe(0.0231);
  });

  test("claude stream that died before its result event still counts visible turns", () => {
    const metrics = parseClaudeStream(stream("claude-truncated.jsonl"));
    expect(metrics.turns).toBe(2); // two intact assistant events
    expect(metrics.tokensIn).toBeNull(); // no usage data seen — unavailable, not 0
    expect(metrics.tokensOut).toBeNull();
    expect(metrics.costUsd).toBeUndefined();
  });

  test("codex thread-event stream: per-turn usage accumulates (cached is a subset, never added)", () => {
    const metrics = parseCodexStream(stream("codex-turns.jsonl"));
    expect(metrics.tokensIn).toBe(2400); // 900 + 1500 — cached_input_tokens is already included
    expect(metrics.tokensOut).toBe(100); // 40 + 60
    expect(metrics.turns).toBe(2);
  });

  test("codex legacy protocol stream: cumulative token_count totals win", () => {
    const metrics = parseCodexStream(stream("codex-legacy.jsonl"));
    expect(metrics.tokensIn).toBe(3000); // total input; cached is a subset of it
    expect(metrics.tokensOut).toBe(150);
    expect(metrics.turns).toBe(1); // one agent_message
  });

  test("malformed streams degrade to null telemetry (unavailable, never zeros), never a crash", () => {
    for (const parse of [parseClaudeStream, parseCodexStream]) {
      const metrics = parse("total garbage\nnot json\n");
      expect(metrics.tokensIn).toBeNull();
      expect(metrics.tokensOut).toBeNull();
      expect(metrics.turns).toBe(0);
      expect(metrics.costUsd).toBeUndefined();
    }
  });

  test("empty stream is tolerated", () => {
    for (const parse of [parseClaudeStream, parseCodexStream]) {
      expect(parse("")).toEqual({ tokensIn: null, tokensOut: null, turns: 0 });
    }
  });
});

describe("claude adapter", () => {
  const adapter = new ClaudeCodeAdapter("claude", { model: "claude-versioned", reasoning: "high" });

  test("composes the headless invocation with the prompt byte-identical", () => {
    const ctx = ctxFor("web");
    const command = adapter.command(ctx);
    expect(command[0]).toBe("claude");
    expect(command).toContain("-p");
    expect(command[command.indexOf("-p") + 1]).toBe(ctx.prompt);
    expect(command).toContain("--output-format");
    expect(command).toContain("stream-json");
    expect(command).toContain("--verbose"); // stream-json requires it in print mode
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command).toContain("claude-versioned");
    expect(command).toContain("high");
    expect(command).not.toContain("--disallowedTools");
  });

  test("web-blocked treatments explicitly disable native web tools", () => {
    const command = adapter.command(ctxFor("none"));
    expect(command.slice(command.indexOf("--disallowedTools"), command.indexOf("--disallowedTools") + 2))
      .toEqual(["--disallowedTools", "WebSearch,WebFetch"]);
  });

  test("mcp treatment renders the runtime's servers into .mcp.json and points the CLI at it; others place nothing", () => {
    const mcpFiles = adapter.setupFiles(ctxFor("mcp"));
    expect(Object.keys(mcpFiles)).toEqual([CLAUDE_MCP_CONFIG_PATH]);
    const parsed = JSON.parse(mcpFiles[CLAUDE_MCP_CONFIG_PATH] as string);
    expect(parsed.mcpServers.acme).toEqual({ type: "http", url: MCP_SERVERS.acme.url });
    expect(adapter.command(ctxFor("mcp"))).toContain("--mcp-config");

    for (const treatment of ["web", "none"] as const) {
      expect(adapter.setupFiles(ctxFor(treatment))).toEqual({});
      expect(adapter.command(ctxFor(treatment))).not.toContain("--mcp-config");
    }
  });

  test("mcp treatment with an empty server map degrades to an empty registry", () => {
    const files = adapter.setupFiles({ ...ctxFor("none"), mcpServers: {} });
    expect(JSON.parse(files[CLAUDE_MCP_CONFIG_PATH] as string)).toEqual({ mcpServers: {} });
  });

  test("declares its provider key and parses its own stream format", () => {
    expect(adapter.requiredHostEnv).toEqual(["ANTHROPIC_API_KEY"]);
    expect(adapter.parseStream(stream("claude.jsonl")).tokensOut).toBe(345);
  });
});

describe("codex adapter", () => {
  const adapter = new CodexAdapter("codex", { model: "gpt-versioned", reasoning: "high" });

  test("composes the headless invocation behind the login shim", () => {
    const ctx = ctxFor("web");
    const command = adapter.command(ctx);
    // codex >= 0.144 ignores the OPENAI_API_KEY env var: the shim pipes it
    // into `codex login --with-api-key` (stdin, never argv) before exec.
    expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(command[2]).toContain("codex login --with-api-key");
    expect(command[2]).not.toContain("$OPENAI_API_KEY");
    expect(command.slice(4, 7)).toEqual(["codex", "exec", "--json"]);
    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command[command.length - 1]).toBe(ctx.prompt);
  });

  test("mcp treatment renders the runtime's servers into ~/.codex/config.toml; others place nothing", () => {
    const mcpFiles = adapter.setupFiles(ctxFor("mcp"));
    expect(Object.keys(mcpFiles)).toEqual([CODEX_CONFIG_PATH]);
    expect(mcpFiles[CODEX_CONFIG_PATH]).toContain("[mcp_servers.acme]");
    expect(mcpFiles[CODEX_CONFIG_PATH]).toContain(`url = ${JSON.stringify(MCP_SERVERS.acme.url)}`);

    for (const treatment of ["web", "none"] as const) {
      expect(adapter.setupFiles(ctxFor(treatment))).toEqual({});
    }
  });

  test("pins model/reasoning and makes the web policy explicit", () => {
    const web = adapter.command(ctxFor("web"));
    const blocked = adapter.command(ctxFor("none"));
    expect(web).toContain("gpt-versioned");
    expect(web).toContain('model_reasoning_effort="high"');
    expect(web).toContain('web_search="live"');
    expect(blocked).toContain('web_search="disabled"');
  });

  test("declares its provider key and parses both codex stream shapes", () => {
    expect(adapter.requiredHostEnv).toEqual(["OPENAI_API_KEY"]);
    expect(adapter.parseStream(stream("codex-turns.jsonl")).turns).toBe(2);
    expect(adapter.parseStream(stream("codex-legacy.jsonl")).tokensIn).toBe(3000);
  });
});

describe("endpoint overrides (LLM gateway routing)", () => {
  test("claude: declares its overrides; the probe follows ANTHROPIC_BASE_URL and carries the custom headers", () => {
    const adapter = new ClaudeCodeAdapter("claude", { model: "m", reasoning: "r" });
    expect(adapter.optionalHostEnv).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"]);
    expect(adapter.keyProbe({ ANTHROPIC_API_KEY: "k" }).url).toBe("https://api.anthropic.com/v1/models");

    const probe = adapter.keyProbe({
      ANTHROPIC_API_KEY: "cf-token",
      ANTHROPIC_BASE_URL: "https://gateway.example/v1/acct/gw/anthropic/",
      ANTHROPIC_CUSTOM_HEADERS: 'cf-aig-authorization: Bearer cf-token\ncf-aig-metadata: {"app":"evals"}',
    });
    expect(probe.url).toBe("https://gateway.example/v1/acct/gw/anthropic/v1/models");
    expect(probe.headers).toEqual({
      "cf-aig-authorization": "Bearer cf-token",
      "cf-aig-metadata": '{"app":"evals"}',
      "x-api-key": "cf-token",
      "anthropic-version": "2023-06-01",
    });
  });

  test("codex: declares its overrides; the probe follows OPENAI_BASE_URL and carries the custom headers", () => {
    const adapter = new CodexAdapter("codex", { model: "m", reasoning: "r" });
    expect(adapter.optionalHostEnv).toEqual(["OPENAI_BASE_URL", "OPENAI_CUSTOM_HEADERS"]);
    expect(adapter.keyProbe({ OPENAI_API_KEY: "k" })).toEqual({
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: "Bearer k" },
    });
    const probe = adapter.keyProbe({
      OPENAI_API_KEY: "k",
      OPENAI_BASE_URL: "https://gateway.example/v1/acct/gw/openai",
      OPENAI_CUSTOM_HEADERS: 'cf-aig-metadata: {"app":"evals"}',
    });
    expect(probe.url).toBe("https://gateway.example/v1/acct/gw/openai/models");
    expect(probe.headers).toEqual({ "cf-aig-metadata": '{"app":"evals"}', Authorization: "Bearer k" });
  });

  test("codex: OPENAI_CUSTOM_HEADERS lands on the custom provider as http_headers; alone it keeps the vendor endpoint", () => {
    const adapter = new CodexAdapter("codex", { model: "m", reasoning: "r" });
    const base = "https://gateway.example/v1/acct/gw/openai";
    const bundle = 'cf-aig-metadata: {"app":"evals"}\nx-team: dax';

    const both = adapter.setupFiles({ ...ctxFor("none"), overrides: { OPENAI_BASE_URL: base, OPENAI_CUSTOM_HEADERS: bundle } })[CODEX_CONFIG_PATH] as string;
    expect(both).toContain(`base_url = ${JSON.stringify(base)}`);
    // JSON escapes double as TOML basic-string escapes, so the JSON metadata value survives verbatim.
    expect(both).toContain('http_headers = { "cf-aig-metadata" = "{\\"app\\":\\"evals\\"}", "x-team" = "dax" }');

    const headersOnly = adapter.setupFiles({ ...ctxFor("none"), overrides: { OPENAI_CUSTOM_HEADERS: bundle } })[CODEX_CONFIG_PATH] as string;
    expect(headersOnly).toContain('base_url = "https://api.openai.com/v1"');
    expect(headersOnly).toContain("http_headers = {");

    // A base URL alone renders no http_headers line; nothing set renders nothing.
    const baseOnly = adapter.setupFiles({ ...ctxFor("none"), overrides: { OPENAI_BASE_URL: base } })[CODEX_CONFIG_PATH] as string;
    expect(baseOnly).not.toContain("http_headers");
    expect(adapter.setupFiles(ctxFor("none"))).toEqual({});
  });

  test("codex: an OPENAI_BASE_URL override renders as a custom model provider, ahead of any MCP table", () => {
    const adapter = new CodexAdapter("codex", { model: "m", reasoning: "r" });
    const base = "https://gateway.example/v1/acct/gw/openai";

    const files = adapter.setupFiles({ ...ctxFor("none"), overrides: { OPENAI_BASE_URL: base } });
    expect(Object.keys(files)).toEqual([CODEX_CONFIG_PATH]);
    const toml = files[CODEX_CONFIG_PATH] as string;
    // codex 0.149 ignores the env var; the provider entry is what routes it.
    expect(toml.startsWith(`model_provider = ${JSON.stringify(CODEX_GATEWAY_PROVIDER)}`)).toBeTrue();
    expect(toml).toContain(`[model_providers.${CODEX_GATEWAY_PROVIDER}]`);
    expect(toml).toContain(`base_url = ${JSON.stringify(base)}`);
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');

    // TOML: the top-level key stays first; the provider table precedes the MCP tables.
    const withMcp = adapter.setupFiles({ ...ctxFor("mcp"), overrides: { OPENAI_BASE_URL: base } })[CODEX_CONFIG_PATH] as string;
    expect(withMcp.indexOf("model_provider = ")).toBe(0);
    expect(withMcp.indexOf("[model_providers.")).toBeLessThan(withMcp.indexOf("[mcp_servers.acme]"));

    // Other overrides (or none) change nothing.
    expect(adapter.setupFiles({ ...ctxFor("none"), overrides: { ANTHROPIC_BASE_URL: base } })).toEqual({});
  });
});

describe("per-experiment endpoint routing (agent.endpoint)", () => {
  const endpoint = {
    apiKeyEnv: "GATEWAY_API_TOKEN",
    baseUrlEnv: "GATEWAY_BASE_URL",
    headersEnv: "GATEWAY_HEADERS",
  } as const;
  const base = "https://gateway.example/v1/acct/ai/v1";

  test("codex: the experiment's variables replace the vendor's for the host, the probe and the login shim", () => {
    const adapter = new CodexAdapter("codex", { model: "acme/coder-9", reasoning: "high", provider: "acme", endpoint: { ...endpoint, wireApi: "chat" } });
    expect(adapter.endpoint).toEqual({ ...endpoint, wireApi: "chat" });
    expect(adapter.requiredHostEnv).toEqual(["GATEWAY_API_TOKEN"]);
    expect(adapter.optionalHostEnv).toEqual(["GATEWAY_BASE_URL", "GATEWAY_HEADERS"]);
    expect(adapter.identity.provider).toBe("acme");

    // The probe reads the experiment's variables; the vendor's are ignored.
    const probe = adapter.keyProbe({
      OPENAI_API_KEY: "vendor",
      OPENAI_BASE_URL: "https://vendor.example",
      GATEWAY_API_TOKEN: "gw",
      GATEWAY_BASE_URL: base,
      GATEWAY_HEADERS: "cf-aig-gateway-id: evals",
    });
    expect(probe.url).toBe(`${base}/models`);
    expect(probe.headers).toEqual({ "cf-aig-gateway-id": "evals", Authorization: "Bearer gw" });

    // The shim pipes the experiment's key variable into login — by name, never value.
    const command = adapter.command(ctxFor("none"));
    expect(command[2]).toContain("printenv GATEWAY_API_TOKEN | codex login --with-api-key");
    expect(command[2]).not.toContain("OPENAI_API_KEY");
  });

  test("codex: the custom provider renders the experiment's key variable and wire, from the overrides it named", () => {
    const adapter = new CodexAdapter("codex", { model: "acme/coder-9", reasoning: "high", endpoint: { ...endpoint, wireApi: "chat" } });
    const files = adapter.setupFiles({
      ...ctxFor("none"),
      overrides: { GATEWAY_BASE_URL: base, GATEWAY_HEADERS: "cf-aig-gateway-id: evals", OPENAI_BASE_URL: "https://ignored.example" },
    });
    const toml = files[CODEX_CONFIG_PATH] as string;
    expect(toml).toContain(`base_url = ${JSON.stringify(base)}`);
    expect(toml).toContain('env_key = "GATEWAY_API_TOKEN"');
    expect(toml).toContain('wire_api = "chat"');
    expect(toml).toContain('http_headers = { "cf-aig-gateway-id" = "evals" }');
    expect(toml).not.toContain("ignored.example");

    // A custom key variable or wire alone still needs the provider: the built-in one cannot express either.
    const keyOnly = new CodexAdapter("codex", { model: "m", reasoning: "r", endpoint: { apiKeyEnv: "GATEWAY_API_TOKEN" } });
    const keyToml = keyOnly.setupFiles(ctxFor("none"))[CODEX_CONFIG_PATH] as string;
    expect(keyToml).toContain('env_key = "GATEWAY_API_TOKEN"');
    expect(keyToml).toContain('base_url = "https://api.openai.com/v1"');
    expect(keyToml).toContain('wire_api = "responses"');
    const chatOnly = new CodexAdapter("codex", { model: "m", reasoning: "r", endpoint: { wireApi: "chat" } });
    expect(chatOnly.setupFiles(ctxFor("none"))[CODEX_CONFIG_PATH]).toContain('wire_api = "chat"');

    // Vendor defaults with nothing set render nothing, exactly as before.
    expect(new CodexAdapter("codex", { model: "m", reasoning: "r" }).setupFiles(ctxFor("none"))).toEqual({});
  });

  test("claude: custom variables are re-exported under the vendor names by a shim; the default argv is untouched", () => {
    const plain = new ClaudeCodeAdapter("claude", { model: "m", reasoning: "r" });
    expect(plain.command(ctxFor("none"))[0]).toBe("claude");

    const adapter = new ClaudeCodeAdapter("claude", { model: "acme/coder-9", reasoning: "high", provider: "acme", endpoint });
    expect(adapter.requiredHostEnv).toEqual(["GATEWAY_API_TOKEN"]);
    expect(adapter.optionalHostEnv).toEqual(["GATEWAY_BASE_URL", "GATEWAY_HEADERS"]);
    expect(adapter.identity.provider).toBe("acme");
    expect(adapter.keyProbe({ GATEWAY_API_TOKEN: "gw", GATEWAY_BASE_URL: base }).url).toBe(`${base}/v1/models`);
    expect(adapter.keyProbe({ GATEWAY_API_TOKEN: "gw" }).headers["x-api-key"]).toBe("gw");

    const ctx = ctxFor("mcp");
    const command = adapter.command(ctx);
    expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
    const shim = command[2] as string;
    // The custom key goes out as both x-api-key and a bearer: gateways differ on which they read.
    expect(shim).toContain('export ANTHROPIC_API_KEY="$GATEWAY_API_TOKEN"; export ANTHROPIC_AUTH_TOKEN="$GATEWAY_API_TOKEN"');
    expect(shim).toContain('[ -n "${GATEWAY_BASE_URL:-}" ] && export ANTHROPIC_BASE_URL="$GATEWAY_BASE_URL"');
    expect(shim).toContain('[ -n "${GATEWAY_HEADERS:-}" ] && export ANTHROPIC_CUSTOM_HEADERS="$GATEWAY_HEADERS"');
    expect(shim.endsWith('exec "$@"')).toBeTrue();
    // The argv after the shim is the plain invocation, prompt byte-identical.
    expect(command.slice(3)).toEqual(["sh", ...plain.command(ctx).map((arg) => (arg === "m" ? "acme/coder-9" : arg === "r" ? "high" : arg))]);

    // Only the names that differ are re-exported.
    const keyOnly = new ClaudeCodeAdapter("claude", { model: "m", reasoning: "r", endpoint: { apiKeyEnv: "GATEWAY_API_TOKEN" } });
    const keyShim = keyOnly.command(ctxFor("none"))[2] as string;
    expect(keyShim).toBe('export ANTHROPIC_API_KEY="$GATEWAY_API_TOKEN"; export ANTHROPIC_AUTH_TOKEN="$GATEWAY_API_TOKEN"; exec "$@"');
  });

  test("both adapters refuse an endpoint the harness cannot route safely", () => {
    expect(() => new CodexAdapter("codex", { model: "m", reasoning: "r", endpoint: { apiKeyEnv: "lower" } })).toThrow(/env var name/);
    expect(() => new ClaudeCodeAdapter("claude", { model: "m", reasoning: "r", endpoint: { wireApi: "chat" } })).toThrow(/codex adapter only/);
    expect(() => new ClaudeCodeAdapter("claude", { model: "m", reasoning: "r", endpoint: { baseUrlEnv: "GATEWAY_SECRET_URL" } })).toThrow(/must not be secret-named/);
  });

  test("a vendor variable cannot be borrowed for another role: the shim would read it, then overwrite it", () => {
    // Swapped roles pass the name-shape checks (both secret-named) but would clobber each other.
    expect(
      () => new ClaudeCodeAdapter("claude", { model: "m", reasoning: "r", endpoint: { apiKeyEnv: "ANTHROPIC_CUSTOM_HEADERS", headersEnv: "ANTHROPIC_API_KEY" } }),
    ).toThrow(/apiKeyEnv ANTHROPIC_CUSTOM_HEADERS is the claude adapter's headersEnv variable/);
    // One borrowed name with the other role left at its default collides on resolution.
    expect(() => new ClaudeCodeAdapter("claude", { model: "m", reasoning: "r", endpoint: { apiKeyEnv: "ANTHROPIC_CUSTOM_HEADERS" } })).toThrow(
      /is the claude adapter's headersEnv variable/,
    );
    expect(() => new CodexAdapter("codex", { model: "m", reasoning: "r", endpoint: { headersEnv: "OPENAI_API_KEY" } })).toThrow(
      /headersEnv OPENAI_API_KEY is the codex adapter's apiKeyEnv variable/,
    );
    // The vendor name for its OWN role is simply the default, spelled out.
    const explicit = new CodexAdapter("codex", { model: "m", reasoning: "r", endpoint: { apiKeyEnv: "OPENAI_API_KEY" } });
    expect(explicit.endpoint).toEqual(CODEX_DEFAULT_ENDPOINT);
  });

  test("key probes are deduplicated per endpoint, not per adapter", () => {
    const vendor = new CodexAdapter("codex", { model: "m", reasoning: "r" });
    const vendorAgain = new CodexAdapter("codex", { model: "m2", reasoning: "r" });
    const gateway = new CodexAdapter("codex", { model: "acme/coder-9", reasoning: "r", endpoint });
    const gatewayChat = new CodexAdapter("codex", { model: "acme/coder-9", reasoning: "r", endpoint: { ...endpoint, wireApi: "chat" } });
    // Same variables ⇒ one probe; the wire does not change what the probe reads.
    expect(keyProbeIdentity(vendor)).toBe(keyProbeIdentity(vendorAgain));
    expect(keyProbeIdentity(gateway)).toBe(keyProbeIdentity(gatewayChat));
    // Different variables ⇒ a probe each, so a rejected gateway token still stops the run.
    expect(keyProbeIdentity(vendor)).not.toBe(keyProbeIdentity(gateway));
    expect(keyProbeIdentity(new ClaudeCodeAdapter("claude", { model: "m", reasoning: "r" }))).not.toBe(keyProbeIdentity(vendor));
  });
});
