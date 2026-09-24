/**
 * Deterministic artifact excerpting: same input, same window — which is what
 * makes every evidence line range in diagnosis.json mechanically verifiable.
 * The model never proposes line numbers; these windows are the only ranges
 * evidence can carry.
 *
 * Line-based and shape-agnostic on purpose: `transcript.jsonl` holds either a
 * raw vendor JSONL stream (container attempts) or host `TranscriptEvent`
 * JSONL, and both excerpt the same way.
 */

import { readFileSync } from "node:fs";

/** Lines of context around the error-marker span in a transcript. */
export const EXCERPT_CONTEXT_LINES = 4;
/** Ceiling on excerpt window size. */
export const EXCERPT_MAX_LINES = 40;
/**
 * Per-line character cap. JSONL transcript lines can carry entire API
 * payloads (megabytes each), so a line count alone does not bound the
 * bundle — one uncapped pair blew past the model's 1M-token context.
 * Truncating within lines keeps the 1-indexed evidence ranges exact.
 */
export const EXCERPT_MAX_LINE_CHARS = 2_000;
/** Fallback tail size when a transcript has no error markers. */
export const EXCERPT_TAIL_LINES = 12;
/** Character cap on a bundled diff. */
export const BUNDLE_DIFF_CAP = 3_000;

/**
 * Heuristic error scan. Matches benign prose too ("failed" in discussion) —
 * accepted: the window stays deterministic and human-verifiable, and
 * anchoring on the last marker cluster keeps an early false positive from
 * pinning the window to the transcript's head.
 */
export const ERROR_MARKER = /"is_error"\s*:\s*true|error:|failed|unauthorized|timed out|not found|exited [1-9]/i;

export interface ArtifactExcerpt {
  text: string;
  /** 1-indexed inclusive range of `text` within the full artifact. */
  lines: [number, number];
  totalLines: number;
}

/**
 * Deterministically select the excerpt window: context around the last
 * cluster of error markers (walking back from the final marker while the
 * window stays within {@link EXCERPT_MAX_LINES}), or the tail when nothing
 * matches. Earlier markers that do not fit are dropped; the window always
 * ends at the last marker plus context.
 */
export function excerptTranscript(content: string): ArtifactExcerpt {
  const lines = content.split("\n");
  // A trailing newline yields a phantom empty last element; drop it.
  if (lines.at(-1) === "") lines.pop();
  const totalLines = lines.length;
  if (totalLines === 0) return { text: "", lines: [1, 1], totalLines: 0 };

  const matches: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (ERROR_MARKER.test(lines[i] as string)) matches.push(i);
  }

  let start: number;
  let end: number;
  if (matches.length === 0) {
    start = Math.max(0, totalLines - EXCERPT_TAIL_LINES);
    end = totalLines - 1;
  } else {
    // Anchor on the last marker cluster: walk back from the final marker while
    // the span plus context still fits the window. Early markers (often
    // system-prompt prose) no longer pin the window to the transcript's head.
    const last = matches.at(-1) as number;
    let first = last;
    for (let i = matches.length - 2; i >= 0; i -= 1) {
      const candidate = matches[i] as number;
      if (last - candidate + 2 * EXCERPT_CONTEXT_LINES + 1 > EXCERPT_MAX_LINES) break;
      first = candidate;
    }
    start = Math.max(0, first - EXCERPT_CONTEXT_LINES);
    end = Math.min(totalLines - 1, last + EXCERPT_CONTEXT_LINES);
  }

  return {
    text: lines
      .slice(start, end + 1)
      .map((line) =>
        line.length > EXCERPT_MAX_LINE_CHARS
          ? `${line.slice(0, EXCERPT_MAX_LINE_CHARS)}[... line truncated ...]`
          : line,
      )
      .join("\n"),
    lines: [start + 1, end + 1],
    totalLines,
  };
}

/** Cap a diff at {@link BUNDLE_DIFF_CAP} characters; ranges cover the whole artifact. */
export function excerptDiff(content: string): ArtifactExcerpt {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const totalLines = lines.length;
  if (totalLines === 0) return { text: "", lines: [1, 1], totalLines: 0 };
  const text =
    content.length > BUNDLE_DIFF_CAP ? `${content.slice(0, BUNDLE_DIFF_CAP)}\n[... diff truncated ...]` : content;
  return { text, lines: [1, totalLines], totalLines };
}

/** Tolerant artifact read: a missing or unreadable file is `undefined`, never a throw. */
export function readArtifact(path: string | null | undefined): string | undefined {
  if (path === undefined || path === null) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
