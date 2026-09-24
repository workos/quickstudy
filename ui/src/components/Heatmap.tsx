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
  /** "model (reasoning)" from manifest identity; null = no model pinned. */
  agentLabel: string | null;
  /** Full identity line for the header tooltip; null = no model pinned. */
  agentTitle: string | null;
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
  /** Named checks passed / run over the scored attempts; null when nothing was scored. */
  checks: { passed: number; total: number } | null;
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
  /** Band label naming this matrix region when the rows are one band's slice. */
  band?: string;
}

/**
 * Group header spans: consecutive columns sharing a comparison group. The
 * span leads with the members' shared model identity (the axis that matters)
 * and demotes the group name to a sublabel; when members mix models (a
 * withheld group) or none is pinned, the group name stays the label.
 */
function groupSpans(
  columns: HeatColumn[],
): Array<{ label: string; sub: string | null; title: string | null; span: number }> {
  // Groupless columns span by model instead, so a model header still renders.
  const spans: Array<{ key: string; group: string | null; columns: HeatColumn[] }> = [];
  for (const column of columns) {
    const key = column.group !== null ? `group:${column.group}` : `agent:${column.agentLabel ?? ""}`;
    const last = spans.at(-1);
    if (last && last.key === key) last.columns.push(column);
    else spans.push({ key, group: column.group, columns: [column] });
  }
  return spans.map(({ group, columns: members }) => {
    const labels = new Set(members.map((member) => member.agentLabel));
    const shared = labels.size === 1 ? [...labels][0] ?? null : null;
    return {
      label: shared ?? group ?? "",
      sub: shared !== null && group !== null ? group : null,
      title: shared !== null ? members[0]?.agentTitle ?? null : null,
      span: members.length,
    };
  });
}

export function Heatmap({ cells, rows, columns, onCellClick, band }: HeatmapProps): ReactNode {
  const byKey = new Map(cells.map((cell) => [`${cell.evalId}|${cell.experimentId}`, cell]));
  const hasGroups = columns.some((column) => column.group !== null || column.agentLabel !== null);
  return (
    <div className="matrix-region">
      <div className="scroll-hint" aria-hidden="true">Scroll horizontally to see every experiment →</div>
      <div className="matrix-scroll" role="region" aria-label={band === undefined ? "Pass-rate matrix" : `Pass-rate matrix — ${band}`} tabIndex={0}>
      <table className="matrix">
        <thead>
          {hasGroups && (
            <tr>
              <th aria-hidden="true" />
              {groupSpans(columns).map((span, index) => (
                <th
                  key={`${span.label}-${index}`}
                  colSpan={span.span}
                  className="matrix-group-head"
                  title={span.title ?? undefined}
                >
                  {span.label}
                  {span.sub !== null && <span className="matrix-group-sub">{span.sub}</span>}
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
                  `${cell.checks ? `; ${cell.checks.passed} of ${cell.checks.total} checks passed` : ""}` +
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
                        {cell.checks ? ` · ${cell.checks.passed}/${cell.checks.total} checks` : ""}
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
