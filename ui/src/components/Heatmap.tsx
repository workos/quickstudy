/**
 * Eval × experiment heatmap: pass-rate color per cell, flaky corner marker,
 * incomplete indicator. Experiment columns are grouped by their declared
 * comparison group — the columns ARE the arms, so there is no surface toggle.
 *
 * Color scale is FIXED 0-100% with threshold ticks (80/90/95) — min-max
 * normalization would make a uniformly-bad sweep look fine, which is a spec
 * failure mode.
 */

import type { ReactNode } from "react";

/** One experiment column, pre-sorted and group-annotated by the caller. */
export interface HeatColumn {
  experimentId: string;
  treatment: string | null;
  group: string | null;
}

/** One rendered heatmap cell (pass rate over SCORED attempts). */
export interface HeatCell {
  evalId: string;
  experimentId: string;
  /** null = nothing scored (no attempts, or all incomplete/errored). */
  rate: number | null;
  passed: number;
  scored: number;
  flaky: boolean;
  incomplete: boolean;
  errors: number;
}

export const RATE_THRESHOLDS = [0.8, 0.9, 0.95] as const;

export interface RateColor {
  bg: string;
  fg: string;
}

/** Fixed-scale color for a pass rate; null renders neutral. */
export function rateColor(rate: number | null): RateColor {
  if (rate === null) return { bg: "var(--gray-bg)", fg: "var(--muted)" };
  if (rate >= 0.95) return { bg: "#1a7f37", fg: "#ffffff" };
  if (rate >= 0.9) return { bg: "#7ecb8f", fg: "#0f3d1e" };
  if (rate >= 0.8) return { bg: "#ffdf80", fg: "#5c3d00" };
  if (rate >= 0.5) return { bg: "#ffb066", fg: "#5c2800" };
  if (rate > 0) return { bg: "#f28b82", fg: "#520f08" };
  return { bg: "#d93025", fg: "#ffffff" };
}

export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

export function HeatmapLegend(): ReactNode {
  return (
    <div className="legend" aria-label="Pass-rate color scale (fixed 0-100%)">
      <span>0%</span>
      {[0, 0.5, 0.8, 0.9, 0.95].map((value) => {
        const color = rateColor(value);
        return <span key={value} className="legend-sw" style={{ background: color.bg }} title={`≥ ${Math.round(value * 100)}%`} />;
      })}
      <span>100%</span>
      <span style={{ marginLeft: 8 }}>ticks: 80 / 90 / 95</span>
    </div>
  );
}

export interface HeatmapProps {
  /** Row-major cells: one entry per eval × experiment with attempts. */
  cells: HeatCell[];
  rows: Array<{ evalId: string; framework?: string }>;
  columns: HeatColumn[];
  onCellClick: (cell: HeatCell) => void;
}

/** Group header spans: consecutive columns sharing a comparison group. */
function groupSpans(columns: HeatColumn[]): Array<{ label: string; span: number }> {
  const spans: Array<{ label: string; span: number }> = [];
  for (const column of columns) {
    const label = column.group ?? "";
    const last = spans.at(-1);
    if (last && last.label === label) last.span += 1;
    else spans.push({ label, span: 1 });
  }
  return spans;
}

export function Heatmap({ cells, rows, columns, onCellClick }: HeatmapProps): ReactNode {
  const byKey = new Map(cells.map((cell) => [`${cell.evalId}|${cell.experimentId}`, cell]));
  const hasGroups = columns.some((column) => column.group !== null);
  return (
    <div className="matrix-region">
      <div className="scroll-hint" aria-hidden="true">Scroll horizontally to see every experiment →</div>
      <div className="matrix-scroll" role="region" aria-label="Pass-rate matrix" tabIndex={0}>
      <table className="matrix">
        <thead>
          {hasGroups && (
            <tr>
              <th aria-hidden="true" />
              {groupSpans(columns).map((span, index) => (
                <th key={`${span.label}-${index}`} colSpan={span.span} className="matrix-group-head">
                  {span.label}
                </th>
              ))}
            </tr>
          )}
          <tr>
            <th>eval</th>
            {columns.map((column) => (
              <th key={column.experimentId}>
                <code>{column.experimentId}</code>
                {column.treatment !== null && <span className="matrix-row-feature">{column.treatment}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.evalId}>
              <th>
                <code>{row.evalId}</code>
                {row.framework !== undefined && <span className="matrix-row-feature">{row.framework}</span>}
              </th>
              {columns.map((column) => {
                const cell = byKey.get(`${row.evalId}|${column.experimentId}`);
                if (!cell) {
                  // Zero-attempt pairs are ABSENT, never 0%.
                  return (
                    <td key={column.experimentId} className="cell" style={{ background: "var(--gray-bg)", color: "var(--muted)" }}>
                      <div className="cell-rate">—</div>
                    </td>
                  );
                }
                const color = rateColor(cell.rate);
                const accessibleLabel =
                  `${cell.evalId}, ${cell.experimentId}: ${formatRate(cell.rate)}, ` +
                  `${cell.passed} of ${cell.scored} scored passed` +
                  `${cell.errors > 0 ? `; ${cell.errors} errored` : ""}` +
                  `${cell.flaky ? "; flaky trials" : ""}${cell.incomplete ? "; incomplete" : ""}`;
                return (
                  <td
                    key={column.experimentId}
                    className="cell"
                    style={{ background: color.bg, color: color.fg }}
                  >
                    <button
                      type="button"
                      className="cell-button"
                      aria-label={accessibleLabel}
                      data-testid={`cell-${cell.evalId}-${cell.experimentId}`}
                      data-rate={cell.rate === null ? "" : String(Math.round(cell.rate * 100))}
                      data-flaky={cell.flaky ? "true" : "false"}
                      data-incomplete={cell.incomplete ? "true" : "false"}
                      onClick={() => onCellClick(cell)}
                    >
                      {cell.flaky && <span className="flaky-marker" title="flaky: trials disagreed" aria-hidden="true" />}
                      <span className="cell-rate">{formatRate(cell.rate)}</span>
                      <span className="cell-sub">
                        {cell.passed}/{cell.scored}
                        {cell.errors > 0 ? ` · ${cell.errors} err` : ""}
                      </span>
                      {cell.incomplete && (
                        <span className="incomplete-marker" title="incomplete: fewer attempts than planned" aria-hidden="true">
                          ◌
                        </span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
