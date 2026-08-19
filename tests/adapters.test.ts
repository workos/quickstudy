import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeAdapter, CLAUDE_MCP_CONFIG_PATH } from "../src/adapters/claude.ts";
import { CodexAdapter, CODEX_CONFIG_PATH } from "../src/adapters/codex.ts";
import { parseClaudeStream, parseCodexStream, parseJsonlLines } from "../src/adapters/parse.ts";
import type { ContainerAttemptContext } from "../src/adapters/types.ts";

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

  test("composes the headless invocation", () => {
    const ctx = ctxFor("web");
    const command = adapter.command(ctx);
    expect(command.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
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
