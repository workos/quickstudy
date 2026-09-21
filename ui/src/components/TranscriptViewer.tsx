/**
 * Transcript viewer: JSONL parsed into collapsible turn blocks. One JSONL
 * line = one turn = one line number, which is exactly the coordinate system
 * attempt deep links use (`L<start>-<end>` ranges), so a
 * `#…/transcript/L120-140` link highlights lines 120-140 here.
 *
 * Huge transcripts stay responsive via lazy collapse: blocks render collapsed
 * and only a capped window renders initially (centered on the anchor when one
 * is present), with an explicit "load all" action.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** Initial render cap — beyond this, the viewer offers "load all". */
const INITIAL_TURN_CAP = 250;
/** Turns rendered around an anchor when the transcript is capped. */
const ANCHOR_CONTEXT_TURNS = 120;

type Role = "system" | "user" | "assistant" | "tool" | "raw";

interface Turn {
  /** 1-indexed transcript line number. */
  line: number;
  role: Role;
  summary: string;
  detail: string;
  isError: boolean;
}

interface ContentItem {
  type?: string;
  text?: string;
  name?: string;
  content?: unknown;
  is_error?: boolean;
}

function contentItems(value: unknown): ContentItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ContentItem => typeof item === "object" && item !== null);
}

function truncate(text: string, max = 160): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** Tolerant per-line classification: vendor stream-json, simple role events, or raw text. */
export function parseTurn(line: string, lineNumber: number): Turn {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { line: lineNumber, role: "raw", summary: truncate(line), detail: line, isError: false };
  }
  const detail = JSON.stringify(parsed, null, 2);
  const isError = /"is_error"\s*:\s*true/.test(line) || parsed["subtype"] === "error";

  // Simple TranscriptEvent shape ({role, content, at}) from in-process adapters.
  const role = parsed["role"];
  if (typeof role === "string" && typeof parsed["content"] === "string") {
    const known: Role =
      role === "system" || role === "user" || role === "assistant" || role === "tool" ? role : "raw";
    return { line: lineNumber, role: known, summary: truncate(parsed["content"]), detail, isError };
  }

  const type = parsed["type"];
  if (type === "system") {
    const subtype = typeof parsed["subtype"] === "string" ? parsed["subtype"] : "event";
    return { line: lineNumber, role: "system", summary: `system · ${subtype}`, detail, isError };
  }
  if (type === "assistant" || type === "user") {
    const message = parsed["message"] as Record<string, unknown> | undefined;
    const items = contentItems(message?.["content"]);
    const toolUse = items.find((item) => item.type === "tool_use");
    const toolResult = items.find((item) => item.type === "tool_result");
    const text = items.find((item) => item.type === "text" && typeof item.text === "string");
    if (toolResult) {
      const flagged = toolResult.is_error === true;
      return {
        line: lineNumber,
        role: "tool",
        summary: flagged ? "tool_result · ERROR" : "tool_result",
        detail,
        isError: isError || flagged,
      };
    }
    if (toolUse) {
      return {
        line: lineNumber,
        role: type === "assistant" ? "assistant" : "user",
        summary: `tool_use · ${toolUse.name ?? "?"}`,
        detail,
        isError,
      };
    }
    if (text?.text !== undefined) {
      return { line: lineNumber, role: type, summary: truncate(text.text), detail, isError };
    }
    return { line: lineNumber, role: type, summary: `${type} message`, detail, isError };
  }
  if (type === "result") {
    return { line: lineNumber, role: "system", summary: "result", detail, isError };
  }

  // Codex `exec --json`: `item.*` events carry the payload (item.type splits
  // text from tool calls); `thread.*`/`turn.*`/`error` are lifecycle.
  if (typeof type === "string" && type.startsWith("item.")) {
    const item = (parsed["item"] ?? {}) as Record<string, unknown>;
    const itemType = typeof item["type"] === "string" ? item["type"] : "item";
    const text = typeof item["text"] === "string" ? item["text"] : "";
    if (itemType === "agent_message") {
      return { line: lineNumber, role: "assistant", summary: truncate(text), detail, isError };
    }
    if (itemType === "reasoning") {
      return { line: lineNumber, role: "assistant", summary: `reasoning · ${truncate(text)}`, detail, isError };
    }
    if (itemType === "error") {
      return { line: lineNumber, role: "system", summary: `error · ${truncate(String(item["message"] ?? ""))}`, detail, isError: true };
    }
    const target = item["command"] ?? item["tool"] ?? item["query"];
    const failed = (typeof item["exit_code"] === "number" && item["exit_code"] !== 0) || item["status"] === "failed";
    return {
      line: lineNumber,
      role: "tool",
      summary: `${itemType}${failed ? " · ERROR" : ""}${target === undefined ? "" : ` · ${truncate(String(target), 120)}`}`,
      detail,
      isError: isError || failed,
    };
  }
  if (type === "error" || (typeof type === "string" && /^(thread|turn)\./.test(type))) {
    const failed = type === "error" || type === "turn.failed";
    return { line: lineNumber, role: "system", summary: type, detail, isError: isError || failed };
  }
  return { line: lineNumber, role: "raw", summary: truncate(line), detail, isError };
}

export function parseTranscript(text: string): Turn[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => parseTurn(line, index + 1));
}

function TurnBlock({ turn, highlighted, defaultExpanded }: { turn: Turn; highlighted: boolean; defaultExpanded: boolean }): ReactNode {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className={highlighted ? "turn highlight" : "turn"} id={`L${turn.line}`} data-line={turn.line}>
      <button type="button" className="turn-head" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <span className="line-no">L{turn.line}</span>
        <span className={`role role-${turn.role}`}>{turn.role}</span>
        <span className="summary">
          {turn.isError && "⚠ "}
          {turn.summary}
        </span>
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="turn-body">
          <pre>{turn.detail}</pre>
        </div>
      )}
    </div>
  );
}

export interface TranscriptViewerProps {
  text: string;
  /** 1-indexed inclusive highlight range (from an L<start>-<end> anchor). */
  lines?: [number, number];
}

export function TranscriptViewer({ text, lines }: TranscriptViewerProps): ReactNode {
  const turns = useMemo(() => parseTranscript(text), [text]);
  const [loadAll, setLoadAll] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const capped = !loadAll && turns.length > INITIAL_TURN_CAP;
  let visible = turns;
  let windowNote: string | null = null;
  if (capped) {
    if (lines) {
      const anchorIndex = Math.min(Math.max(lines[0] - 1, 0), turns.length - 1);
      const start = Math.max(0, anchorIndex - ANCHOR_CONTEXT_TURNS);
      const end = Math.min(turns.length, Math.max(anchorIndex + ANCHOR_CONTEXT_TURNS, lines[1]) + 1);
      visible = turns.slice(start, end);
      windowNote = `showing turns ${start + 1}–${end} of ${turns.length} (window around L${lines[0]})`;
    } else {
      visible = turns.slice(0, INITIAL_TURN_CAP);
      windowNote = `showing the first ${INITIAL_TURN_CAP} of ${turns.length} turns`;
    }
  }

  // Scroll the anchor into view once the (possibly re-windowed) list renders.
  useEffect(() => {
    if (!lines) return;
    const target = containerRef.current?.querySelector(`#L${lines[0]}`);
    target?.scrollIntoView({ block: "center" });
  }, [lines, loadAll, text]);

  const inRange = (line: number): boolean => lines !== undefined && line >= lines[0] && line <= lines[1];

  return (
    <div className="quickstudy-viewer viewer" ref={containerRef} data-testid="transcript-viewer">
      {windowNote !== null && (
        <div className="viewer-note">
          <span>{windowNote}</span>
          <button type="button" onClick={() => setLoadAll(true)} data-testid="load-all">
            Load all {turns.length} turns
          </button>
        </div>
      )}
      {visible.map((turn) => (
        <TurnBlock key={turn.line} turn={turn} highlighted={inRange(turn.line)} defaultExpanded={inRange(turn.line)} />
      ))}
    </div>
  );
}
