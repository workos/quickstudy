import { describe, expect, test } from "bun:test";
import { parseTurn } from "./TranscriptViewer.tsx";

const line = (value: unknown): string => JSON.stringify(value);

describe("parseTurn · Codex exec --json", () => {
  test("labels items by item.type instead of falling through to raw", () => {
    const turns = [
      { type: "thread.started", thread_id: "th_1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "0", type: "reasoning", text: "Plan: create hello.txt" } },
      { type: "item.started", item: { id: "1", type: "command_execution", command: "echo hi > hello.txt", status: "in_progress" } },
      { type: "item.completed", item: { id: "1", type: "command_execution", command: "echo hi > hello.txt", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "2", type: "mcp_tool_call", server: "docs", tool: "search", status: "failed" } },
      { type: "item.completed", item: { id: "3", type: "agent_message", text: "Created hello.txt." } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      { type: "turn.failed", error: { message: "boom" } },
    ].map((event, index) => parseTurn(line(event), index + 1));

    expect(turns.map((turn) => turn.role)).toEqual([
      "system", "system", "assistant", "tool", "tool", "tool", "assistant", "system", "system",
    ]);
    expect(turns.map((turn) => turn.summary)).toEqual([
      "thread.started",
      "turn.started",
      "reasoning · Plan: create hello.txt",
      "command_execution · echo hi > hello.txt",
      "command_execution · echo hi > hello.txt",
      "mcp_tool_call · ERROR · search",
      "Created hello.txt.",
      "turn.completed",
      "turn.failed",
    ]);
    expect(turns.map((turn) => turn.isError)).toEqual([false, false, false, false, false, true, false, false, true]);
  });

  test("flags a non-zero exit code as an error", () => {
    const turn = parseTurn(line({ type: "item.completed", item: { type: "command_execution", command: "false", exit_code: 1 } }), 1);
    expect(turn.isError).toBe(true);
    expect(turn.summary).toBe("command_execution · ERROR · false");
  });

  test("still classifies Claude stream-json and unknown lines", () => {
    expect(parseTurn(line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }), 1).role).toBe("assistant");
    expect(parseTurn(line({ type: "something.else" }), 2).role).toBe("raw");
    expect(parseTurn("not json", 3).role).toBe("raw");
  });
});
