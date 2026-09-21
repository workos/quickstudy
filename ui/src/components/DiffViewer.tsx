/**
 * Minimal hand-rolled unified-diff renderer. Chosen over diff2html on bundle
 * budget (spec open item): the diffs here are plain `diff.patch` artifacts
 * and only need add/del/hunk/file coloring plus line-range highlighting —
 * ~60 lines beats a dependency, and nothing loads from a CDN.
 */

import { useEffect, useRef, type ReactNode } from "react";

type DiffLineKind = "file" | "hunk" | "add" | "del" | "context";

function classify(line: string): DiffLineKind {
  if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff ")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

const KIND_CLASS: Record<DiffLineKind, string> = {
  file: "diff-file",
  hunk: "diff-hunk",
  add: "diff-add",
  del: "diff-del",
  context: "",
};

export interface DiffViewerProps {
  text: string;
  /** 1-indexed inclusive highlight range within the raw patch file. */
  lines?: [number, number];
}

export function DiffViewer({ text, lines }: DiffViewerProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();

  useEffect(() => {
    if (!lines) return;
    const target = containerRef.current?.querySelector(`#L${lines[0]}`);
    target?.scrollIntoView({ block: "center" });
  }, [lines, text]);

  const inRange = (line: number): boolean => lines !== undefined && line >= lines[0] && line <= lines[1];

  if (rows.length === 0) {
    return <div className="viewer-note">This attempt produced an empty diff.</div>;
  }

  return (
    <div className="quickstudy-viewer viewer diff" ref={containerRef} data-testid="diff-viewer">
      {rows.map((row, index) => {
        const line = index + 1;
        const kind = classify(row);
        const highlight = inRange(line) ? " highlight" : "";
        return (
          <div key={line} id={`L${line}`} className={`diff-line ${KIND_CLASS[kind]}${highlight}`}>
            <span className="line-no">{line}</span>
            <span className="text">{row === "" ? " " : row}</span>
          </div>
        );
      })}
    </div>
  );
}
