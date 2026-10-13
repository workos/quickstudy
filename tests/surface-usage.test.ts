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
    // A web search naming the product is a docs EVENT (the docs surface was
    // reached for), but a query is not a page: it counts, it is never a URL.
    expect(usage.docs).toEqual({ count: 1, urls: [] });
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

  test("a docs URL inside a file the agent WRITES is not a page it opened", () => {
    const raw = [
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "w1", name: "Write", input: { file_path: "README.md", content: "See https://workos.com/docs/authkit for details" } },
        { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "app.rb", old_string: "x", new_string: "# https://workos.com/docs/sso" } },
        { type: "tool_use", id: "b1", name: "Bash", input: { command: "cat <<'EOF' > notes.md\nhttps://workos.com/docs/webhooks\nEOF" } },
      ] } }),
    ].join("\n");
    expect(extractSurfaceUsage("claude", raw, config).docs).toEqual({ count: 0, urls: [] });
  });

  test("shell fetchers count; API calls to the same domain do not when the target carries a path prefix", () => {
    const raw = [
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "b1", name: "Bash", input: { command: "curl -sL https://workos.com/docs/authkit/nextjs?utm=x | head" } },
        { type: "tool_use", id: "b2", name: "Bash", input: { command: "curl -H 'Authorization: Bearer sk_secret' https://api.workos.com/organizations" } },
        { type: "tool_use", id: "b3", name: "Bash", input: { command: "echo https://workos.com/docs/not-fetched" } },
      ] } }),
    ].join("\n");
    const usage = extractSurfaceUsage("claude", raw, { ...config, docsHosts: ["workos.com/docs"] });
    expect(usage.docs).toEqual({ count: 1, urls: ["https://workos.com/docs/authkit/nextjs"] });
    expect(JSON.stringify(usage)).not.toContain("sk_secret");
  });

  test("a web search naming the product counts once per search; a fetch of an unrelated page never does", () => {
    const claude = [
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "s1", name: "WebSearch", input: { query: "workos authkit django sealed session" } },
        { type: "tool_use", id: "s2", name: "WebSearch", input: { query: "django csrf exempt decorator" } },
        { type: "tool_use", id: "f1", name: "WebFetch", input: { url: "https://example.com/workos-blog" } },
      ] } }),
    ].join("\n");
    expect(extractSurfaceUsage("claude", claude, config).docs).toEqual({ count: 1, urls: [] });
    // Codex emits the query only on completion; the started phase is empty and must not count.
    const codex = [
      JSON.stringify({ type: "item.started", item: { id: "item_1", type: "web_search", query: "", action: { type: "other" } } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "web_search", query: "WorkOS webhooks signature", action: { type: "search" } } }),
    ].join("\n");
    expect(extractSurfaceUsage("codex", codex, config).docs).toEqual({ count: 1, urls: [] });
  });

  test("a heredoc line or an assignment that starts with the CLI name is not an invocation", () => {
    const codex = JSON.stringify({ type: "item.completed", item: { id: "c1", type: "command_execution",
      command: "bash -lc 'cat <<EOF > app/client.py\nworkos = WorkOSClient(api_key=key)\nEOF\nworkos = 1'" } });
    expect(extractSurfaceUsage("codex", codex, config).cli).toEqual({ count: 0, commands: [] });
    const real = JSON.stringify({ type: "item.completed", item: { id: "c2", type: "command_execution", command: "bash -lc 'workos --help'" } });
    expect(extractSurfaceUsage("codex", real, config).cli).toEqual({ count: 1, commands: ["workos"] });
  });

  test("written examples, prompts and MCP searches are never docs evidence", () => {
    const raw = [
      JSON.stringify({ type: "assistant", message: { content: [
        // the fetcher appears inside an echo, a heredoc body, and a written file: no page was opened
        { type: "tool_use", id: "b1", name: "Bash", input: { command: "echo \"run: curl https://workos.com/docs/start\"" } },
        { type: "tool_use", id: "b2", name: "Bash", input: { command: "cat <<'EOF' > README.md\ncurl https://workos.com/docs/start\nEOF" } },
        // an MCP docs search is MCP use, not web docs use
        { type: "tool_use", id: "m1", name: "mcp__workos__search_docs", input: { query: "workos login" } },
        // a docs URL mentioned in a fetch PROMPT (the page fetched is unrelated) or in a search QUERY is not a fetched page
        { type: "tool_use", id: "f1", name: "WebFetch", input: { url: "https://example.com/blog", prompt: "compare with https://workos.com/docs/sso" } },
        { type: "tool_use", id: "s1", name: "WebSearch", input: { query: "workos https://workos.com/docs/authkit sessions" } },
      ] } }),
    ].join("\n");
    const usage = extractSurfaceUsage("claude", raw, config);
    expect(usage.mcp).toEqual({ count: 1, tools: ["mcp__workos__search_docs"] });
    // exactly one docs event: the product-naming search; no URL was ever fetched
    expect(usage.docs).toEqual({ count: 1, urls: [] });
  });

  test("continuation lines, chained heredoc openers and multi-part domains are handled", () => {
    const raw = [
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", id: "b1", name: "Bash", input: { command: "curl -sL \\\n  https://workos.com/docs/start" } },
        { type: "tool_use", id: "b2", name: "Bash", input: { command: "cat <<EOF > README.md && workos --help\nhello\nEOF" } },
      ] } }),
    ].join("\n");
    const usage = extractSurfaceUsage("claude", raw, config);
    expect(usage.docs).toEqual({ count: 1, urls: ["https://workos.com/docs/start"] });
    expect(usage.cli).toEqual({ count: 1, commands: ["workos"] });
    // a path prefix keeps its case; a multi-part suffix still yields the product token
    const cased = extractSurfaceUsage("claude", JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "f1", name: "WebFetch", input: { url: "https://acme.co.uk/Docs/start" } },
      { type: "tool_use", id: "s1", name: "WebSearch", input: { query: "acme sessions" } },
    ] } }), { docsHosts: ["acme.co.uk/Docs"] });
    expect(cased.docs).toEqual({ count: 2, urls: ["https://acme.co.uk/Docs/start"] });
    // a TLD is never a product: "cloud deployment" is not an acme docs search, "acme sessions" is
    const tld = { docsHosts: ["acme.cloud"] };
    expect(extractSurfaceUsage("claude", JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "s2", name: "WebSearch", input: { query: "cloud deployment best practices" } },
      { type: "tool_use", id: "s3", name: "WebSearch", input: { query: "acme sessions" } },
    ] } }), tld).docs).toEqual({ count: 1, urls: [] });
    // `command curl …` and a curl used as an `if` condition are still fetches
    const prefixed = JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "p1", name: "Bash", input: { command: "command curl -s https://workos.com/docs/a" } },
      { type: "tool_use", id: "p2", name: "Bash", input: { command: "if curl -fsS https://workos.com/docs/b >/dev/null; then echo ok; fi" } },
    ] } });
    expect(extractSurfaceUsage("claude", prefixed, config).docs).toEqual({ count: 2, urls: ["https://workos.com/docs/a", "https://workos.com/docs/b"] });
    // `command -v workos` only looks the CLI up; `which workos` runs `which`: neither is CLI use
    const lookups = JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "l1", name: "Bash", input: { command: "command -v workos && which workos && type workos" } },
    ] } });
    expect(extractSurfaceUsage("claude", lookups, config).cli).toEqual({ count: 0, commands: [] });
    // hosted docs keep the product label; explicit search tokens override the derivation
    const hosted = JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "s4", name: "WebSearch", input: { query: "acme sessions" } },
      { type: "tool_use", id: "s5", name: "WebSearch", input: { query: "readthedocs theming" } },
    ] } });
    expect(extractSurfaceUsage("claude", hosted, { docsHosts: ["acme.readthedocs.io"] }).docs.count).toBe(2);
    expect(extractSurfaceUsage("claude", hosted, { docsHosts: ["acme.readthedocs.io"], searchTokens: ["acme"] }).docs.count).toBe(1);
    // Codex reports an opened page as a search item carrying action.url
    const opened = JSON.stringify({ type: "item.completed", item: { id: "w1", type: "web_search", query: "", action: { type: "open_page", url: "https://workos.com/docs/events" } } });
    expect(extractSurfaceUsage("codex", opened, config).docs).toEqual({ count: 1, urls: ["https://workos.com/docs/events"] });
  });

  test("returns observed zeroes for a supported stream with no configured surface use", () => {
    expect(extractSurfaceUsage("claude", '{"type":"result"}\n', config)).toEqual({
      docs: { count: 0, urls: [] },
      mcp: { count: 0, tools: [] },
      cli: { count: 0, commands: [] },
    });
  });
});
