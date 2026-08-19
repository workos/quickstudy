import { describe, expect, test } from "bun:test";
import { extractSurfaceUsage } from "../src/surface-usage.ts";

const config = {
  docsHosts: ["workos.com"],
  cliCommands: ["workos"],
  mcpServers: ["workos"],
} as const;

describe("surface-use telemetry", () => {
  test("extracts Claude MCP, CLI, and sanitized documentation evidence", () => {
    const raw = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__workos__search_docs", input: { query: "AuthKit" } },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "workos widgets list --api-key should-not-be-stored" },
            },
            {
              type: "tool_use",
              name: "WebFetch",
              input: { url: "https://workos.com/docs/authkit?token=secret#callback" },
            },
          ],
        },
      }),
    ].join("\n");

    expect(extractSurfaceUsage("claude", raw, config)).toEqual({
      docs: { count: 1, urls: ["https://workos.com/docs/authkit"] },
      mcp: { count: 1, tools: ["mcp__workos__search_docs"] },
      cli: { count: 1, commands: ["workos widgets"] },
    });
  });

  test("deduplicates Codex item phases and does not retain command arguments", () => {
    const item = { id: "1", type: "command_execution", command: "bash -lc 'workos env list --token secret'" };
    const raw = [
      JSON.stringify({ type: "item.started", item }),
      JSON.stringify({ type: "item.completed", item: { ...item, status: "completed" } }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "2", type: "mcp_tool_call", server: "workos", tool: "search_docs", arguments: {} },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "3", type: "web_search", query: "site:workos.com AuthKit" },
      }),
    ].join("\n");

    const usage = extractSurfaceUsage("codex", raw, config);
    expect(usage.cli).toEqual({ count: 1, commands: ["workos env"] });
    expect(usage.mcp).toEqual({ count: 1, tools: ["workos__search_docs"] });
    // A search query is not evidence that a documentation page was opened.
    expect(usage.docs).toEqual({ count: 0, urls: [] });
    expect(JSON.stringify(usage)).not.toContain("secret");
  });

  test("extracts Cursor started calls once", () => {
    const raw = [
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "a",
        tool_call: { shellToolCall: { args: { command: "workos users list" } } },
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "a",
        tool_call: { shellToolCall: { args: { command: "workos users list" }, result: { success: {} } } },
      }),
    ].join("\n");

    expect(extractSurfaceUsage("cursor", raw, config).cli).toEqual({ count: 1, commands: ["workos users"] });
  });

  test("retains evidence for a Codex tool that started before a truncated stream", () => {
    const raw = JSON.stringify({
      type: "item.started",
      item: { id: "only-start", type: "command_execution", command: "workos users list" },
    });
    expect(extractSurfaceUsage("codex", raw, config).cli).toEqual({
      count: 1,
      commands: ["workos users"],
    });
  });

  test("does not mistake a mention of the CLI for an invocation", () => {
    const raw = JSON.stringify({
      type: "item.completed",
      item: { id: "echo", type: "command_execution", command: "echo 'try workos users list'" },
    });
    expect(extractSurfaceUsage("codex", raw, config).cli).toEqual({ count: 0, commands: [] });
  });

  test("extracts Gemini tool uses and ignores unrelated domains and binaries", () => {
    const raw = [
      JSON.stringify({
        type: "tool_use",
        tool_name: "run_shell_command",
        parameters: { command: "curl https://docs.workos.com/sso?key=secret && other-cli run" },
      }),
      JSON.stringify({
        type: "tool_use",
        tool_name: "web_fetch",
        parameters: { url: "https://example.com/workos" },
      }),
    ].join("\n");

    expect(extractSurfaceUsage("gemini", raw, config)).toEqual({
      docs: { count: 1, urls: ["https://docs.workos.com/sso"] },
      mcp: { count: 0, tools: [] },
      cli: { count: 0, commands: [] },
    });
  });

  test("returns observed zeroes for a supported stream with no configured surface use", () => {
    expect(extractSurfaceUsage("claude", '{"type":"result"}\n', config)).toEqual({
      docs: { count: 0, urls: [] },
      mcp: { count: 0, tools: [] },
      cli: { count: 0, commands: [] },
    });
  });
});
