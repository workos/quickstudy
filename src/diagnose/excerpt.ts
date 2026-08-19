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
/** Fallback tail size when a transcript has no error markers. */
export const EXCERPT_TAIL_LINES = 12;
/** Character cap on a bundled diff. */
export const BUNDLE_DIFF_CAP = 3_000;

/**
 * Heuristic error scan. Matches benign prose too ("failed" in discussion) —
 * accepted: the window stays deterministic and human-verifiable, and the
 * tail fallback bounds the damage.
 */
export const ERROR_MARKER = /"is_error"\s*:\s*true|error:|failed|unauthorized|timed out|not found|exited [1-9]/i;

export interface ArtifactExcerpt {
  text: string;
  /** 1-indexed inclusive range of `text` within the full artifact. */
  lines: [number, number];
  totalLines: number;
}

/**
 * Deterministically select the excerpt window: context around the span of
 * error markers (capped), or the tail when nothing matches.
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
    start = Math.max(0, (matches[0] as number) - EXCERPT_CONTEXT_LINES);
    end = Math.min(totalLines - 1, (matches.at(-1) as number) + EXCERPT_CONTEXT_LINES);
    if (end - start + 1 > EXCERPT_MAX_LINES) {
      end = start + EXCERPT_MAX_LINES - 1;
    }
  }

  return {
    text: lines.slice(start, end + 1).join("\n"),
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
