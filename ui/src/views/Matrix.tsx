/**
 * Matrix view: eval × experiment heatmap. Rows are evals (filterable by
 * product/framework/topic from eval metadata — joined for display, never part
 * of run identity); columns are experiments, grouped by comparison group —
 * the columns ARE the treatment arms, so there is no surface toggle. Clicking
 * a cell opens a URL-addressable slide-over drill-down with per-trial checks,
 * telemetry, surface usage, and transcript/diff links. When the run's report
 * carries eval bands, rows split into discriminating / solved-by-all /
 * failed-by-all sections (uniform bands collapsed) under a scorer-health
 * banner; older reports or a failed report load render one unbanded grid.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DataAttempt, DataMeta, DataRun } from "../../../src/export-types.ts";
import type { EvalBand, ReportJson } from "../../../src/report/report.ts";
import { agentLabelOf, agentTitleOf } from "../agent-label.ts";
import { countGradedChecks, isGraded, UNGRADED_TITLE } from "../checks.ts";
import { PublicationNotice } from "../components/PublicationNotice.tsx";
import { ErrorPanel } from "../components/ErrorPanel.tsx";
import { Heatmap, HeatmapLegend, formatRate, type HeatCell, type HeatColumn } from "../components/Heatmap.tsx";
import { OutcomeBadges, StatBadge, displayStatus, statusTone } from "../components/StatBadge.tsx";
import { AttemptSurfaceUsage } from "../components/SurfaceUsage.tsx";
import { loadReport, loadRun } from "../data.ts";
import { fmtTokens, incompleteReason } from "../format.ts";
import { useAsync } from "../hooks.ts";
import { links, navigate } from "../router.ts";

const ALL = "all";
const SUITES = ["benchmark", "regression", "other"] as const;

interface MatrixProps {
  meta: DataMeta;
  runId: string;
  cell?: { evalId: string; experimentId: string };
}

interface Filters {
  product: string;
  framework: string;
  topic: string;
}

function metadataOf(run: DataRun, evalId: string): { product?: string; framework?: string; topics?: string[] } {
  return run.manifest.evals[evalId]?.metadata ?? {};
}

function groupOf(run: DataRun, experimentId: string): string | null {
  for (const group of run.groups) {
    if (group.experimentIds.includes(experimentId)) return group.group;
  }
  return null;
}

function buildColumns(run: DataRun, attempts: DataAttempt[]): HeatColumn[] {
  const ids = [...new Set(attempts.map((attempt) => attempt.experiment_id))];
  return ids
    .map((experimentId) => ({
      experimentId,
      treatment: run.manifest.experiments[experimentId]?.components.treatment ?? null,
      group: groupOf(run, experimentId),
      agentLabel: agentLabelOf(run, experimentId),
      agentTitle: agentTitleOf(run, experimentId),
    }))
    .sort(
      (a, b) =>
        (a.group ?? "￿").localeCompare(b.group ?? "￿") ||
        (a.treatment ?? "").localeCompare(b.treatment ?? "") ||
        a.experimentId.localeCompare(b.experimentId),
    );
}

function buildCells(attempts: DataAttempt[], expectedTrials: number): HeatCell[] {
  const byPair = new Map<string, DataAttempt[]>();
  for (const attempt of attempts) {
    const key = `${attempt.eval_id}|${attempt.experiment_id}`;
    const list = byPair.get(key);
    if (list) list.push(attempt);
    else byPair.set(key, [attempt]);
  }
  const cells: HeatCell[] = [];
  for (const group of byPair.values()) {
    const first = group[0] as DataAttempt;
    const completed = group.filter((attempt) => attempt.status === "completed");
    const passed = completed.filter((attempt) => attempt.passed === true).length;
    const scored = completed.length;
    const outcomes = new Set(completed.map((attempt) => attempt.passed === true));
    const checks = countGradedChecks(completed.flatMap((attempt) => attempt.checks ?? []));
    cells.push({
      evalId: first.eval_id,
      experimentId: first.experiment_id,
      rate: scored > 0 ? passed / scored : null,
      passed,
      scored,
      flaky: outcomes.size > 1,
      incomplete: group.length < expectedTrials || group.some((attempt) => attempt.status === "incomplete"),
      errors: group.filter((attempt) => attempt.status === "error").length,
      checks: checks.total > 0 ? checks : null,
    });
  }
  return cells;
}

function fmtDuration(attempt: DataAttempt): string {
  if (attempt.started_at === null || attempt.finished_at === null) return "—";
  const totalSeconds = Math.round((Date.parse(attempt.finished_at) - Date.parse(attempt.started_at)) / 1000);
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}

// What an adapter's `turns` counts. Claude reports API turns (dozens per attempt); codex
// `exec` reports thread turns — one per prompt — so a bare "turns 1" beside "turns 80" reads
// as 80× the efficiency when it is a different unit.
const TURN_UNIT: Record<string, { label: string; title: string }> = {
  codex: { label: "thread turns", title: "codex exec reports one thread turn per prompt, not per agent step — not comparable to Claude's turn count" },
};

/** A timeout recorded before graded timeouts existed: incomplete, never scored. */
function isUnscoredTimeout(attempt: DataAttempt): boolean {
  return attempt.status === "incomplete" && attempt.error?.startsWith("attempt timed out") === true;
}

function AttemptRow({ attempt, runId, adapter }: { attempt: DataAttempt; runId: string; adapter: string | null }): ReactNode {
  const status = displayStatus(attempt);
  const turnUnit = (adapter !== null && TURN_UNIT[adapter]) || { label: "turns", title: "agent turns, as counted by the adapter" };
  return (
    <div className="attempt-row" data-testid="drill-attempt">
      <div className="attempt-line">
        <span className="kpi-meta">trial {attempt.trial_index + 1}</span>
        <StatBadge tone={statusTone(status)}>{status}</StatBadge>
        <OutcomeBadges attempt={attempt} />
        <span className="spacer" />
        {attempt.transcript !== null && <a href={links.attempt(runId, attempt.id, "transcript")}>transcript</a>}
        {attempt.diff !== null && <a href={links.attempt(runId, attempt.id, "diff")}>diff</a>}
      </div>
      {attempt.checks !== null && attempt.checks.length > 0 && (
        <div className="attempt-line">
          {attempt.checks.map((check) => (
            <span key={check.name} className={check.passed ? "crit pass" : "crit fail"} title={check.notes ?? check.name}>
              {check.passed ? "✓" : "✗"} {check.name}
              {!isGraded(check) && (
                <span className="tag" data-testid="ungraded-tag" title={UNGRADED_TITLE}>
                  recorded
                </span>
              )}
            </span>
          ))}
        </div>
      )}
      {attempt.error !== null && (
        <div className="attempt-line">
          <code>{attempt.error}</code>
        </div>
      )}
      <div className="telemetry">
        <span>wall {fmtDuration(attempt)}</span>
        <span>
          tokens {fmtTokens(attempt.tokens_in)} in / {fmtTokens(attempt.tokens_out)} out
        </span>
        <span>cost {attempt.cost_usd === null ? "—" : `$${attempt.cost_usd.toFixed(2)}`}</span>
        <span title={turnUnit.title}>
          {turnUnit.label} {attempt.turns ?? "—"}
        </span>
      </div>
      <AttemptSurfaceUsage treatment={attempt.treatment} usage={attempt.surface_usage} />
    </div>
  );
}

function DrillDown({
  runId,
  run,
  cell,
  attempts,
}: {
  runId: string;
  run: DataRun;
  cell: { evalId: string; experimentId: string };
  attempts: DataAttempt[];
}): ReactNode {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  const labelId = useId();
  const relevant = attempts
    .filter((attempt) => attempt.eval_id === cell.evalId && attempt.experiment_id === cell.experimentId)
    .sort((a, b) => a.trial_index - b.trial_index);
  const treatment = run.manifest.experiments[cell.experimentId]?.components.treatment ?? null;
  const completed = relevant.filter((attempt) => attempt.status === "completed");
  const passed = completed.filter((attempt) => attempt.passed === true).length;
  const returnTestId = `cell-${cell.evalId}-${cell.experimentId}`;
  const close = useCallback((): void => {
    returnFocus.current = true;
    navigate(links.matrix(runId));
  }, [runId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => !element.hasAttribute("hidden"));
    focusable()[0]?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (candidates.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = candidates[0] as HTMLElement;
      const last = candidates.at(-1) as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = priorOverflow;
      if (!returnFocus.current) return;
      const restore = (): boolean => {
        const target = [...document.querySelectorAll<HTMLElement>("[data-testid]")].find(
          (element) => element.dataset["testid"] === returnTestId,
        );
        target?.focus();
        return target !== undefined;
      };
      requestAnimationFrame(() => {
        if (!restore()) window.setTimeout(restore, 0);
      });
    };
  }, [close, returnTestId]);

  const keepOverlayOutOfKeyboardFlow = (event: KeyboardEvent<HTMLDivElement>): void => event.preventDefault();

  return (
    <>
      <div className="drill-overlay" aria-hidden="true" onClick={close} onKeyDown={keepOverlayOutOfKeyboardFlow} />
      <aside
        ref={dialogRef}
        className="drill"
        data-testid="drill-down"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
      >
        <button type="button" className="drill-close" onClick={close} data-testid="drill-close">
          Close ✕
        </button>
        <h2 id={labelId}>
          {cell.evalId} · {cell.experimentId}
          {treatment !== null ? ` · ${treatment}` : ""}
        </h2>
        <p className="sub">
          {relevant.length} attempt(s) · {passed}/{completed.length} scored passed · {formatRate(completed.length > 0 ? passed / completed.length : null)}
        </p>
        {relevant.length === 0 && <div className="viewer-note">No attempts in this cell.</div>}
        {relevant.map((attempt) => (
          <AttemptRow
            key={attempt.id}
            attempt={attempt}
            runId={runId}
            adapter={run.manifest.experiments[attempt.experiment_id]?.components.agent?.adapter ?? null}
          />
        ))}
      </aside>
    </>
  );
}

function FilterControl({
  id,
  label,
  values,
  value,
  onChange,
}: {
  id: string;
  label: string;
  values: string[];
  value: string;
  onChange: (next: string) => void;
}): ReactNode {
  if (values.length === 0) return null;
  return (
    <div className="control">
      <label htmlFor={id}>{label}</label>
      <select id={id} data-testid={id} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        <option value={ALL}>all</option>
        {values.map((candidate) => (
          <option key={candidate} value={candidate}>
            {candidate}
          </option>
        ))}
      </select>
    </div>
  );
}

const plural = (count: number): string => (count === 1 ? "" : "s");

export function Matrix({ meta, runId, cell }: MatrixProps): ReactNode {
  const run = useAsync(() => loadRun(runId), [runId]);
  // Bands and scorer health are optional: any report load failure (missing,
  // invalid, offline) degrades to the unbanded matrix, never an error.
  const report = useAsync(
    () =>
      loadReport(runId).then(
        (value): ReportJson | null => value,
        () => null,
      ),
    [runId],
  );

  // Regression evals never blend into the benchmark grid — the toggle only
  // renders when the run has more than one suite.
  const [selectedSuite, setSuite] = useState<string>("benchmark");
  const availableSuites = run.status === "ready"
    ? SUITES.filter((candidate) => run.value.attempts.some((attempt) => attempt.suite === candidate))
    : [];
  const suite = availableSuites.includes(selectedSuite as typeof SUITES[number])
    ? selectedSuite : (availableSuites[0] ?? "benchmark");
  const [filters, setFilters] = useState<Filters>({ product: ALL, framework: ALL, topic: ALL });

  useEffect(() => {
    setFilters({ product: ALL, framework: ALL, topic: ALL });
  }, [runId]);

  const grid = useMemo(() => {
    if (run.status !== "ready") return null;
    const value = run.value;
    const suiteAttempts = value.attempts.filter((attempt) => attempt.suite === suite);
    const filtered = suiteAttempts.filter((attempt) => {
      const metadata = metadataOf(value, attempt.eval_id);
      if (filters.product !== ALL && metadata.product !== filters.product) return false;
      if (filters.framework !== ALL && metadata.framework !== filters.framework) return false;
      if (filters.topic !== ALL && !(metadata.topics ?? []).includes(filters.topic)) return false;
      return true;
    });
    const rows = [...new Set(filtered.map((attempt) => attempt.eval_id))]
      .sort((a, b) => a.localeCompare(b))
      .map((evalId) => ({ evalId, ...(metadataOf(value, evalId).framework !== undefined ? { framework: metadataOf(value, evalId).framework as string } : {}) }));
    return {
      rows,
      columns: buildColumns(value, filtered),
      cells: buildCells(filtered, value.run.trials),
      attempts: filtered,
    };
  }, [run, suite, filters]);

  if (run.status === "error") return <ErrorPanel error={run.error} />;
  if (run.status === "loading" || report.status === "loading" || grid === null) return <div className="loading">Loading run…</div>;

  const value = run.value;
  const summary = value.run;
  const suites = SUITES.filter((candidate) => value.attempts.some((attempt) => attempt.suite === candidate));
  const products = [...new Set(value.attempts.map((attempt) => metadataOf(value, attempt.eval_id).product).filter((p): p is string => p !== undefined))].sort();
  const frameworkValues = [...new Set(value.attempts.map((attempt) => metadataOf(value, attempt.eval_id).framework).filter((f): f is string => f !== undefined))].sort();
  const topics = [...new Set(value.attempts.flatMap((attempt) => metadataOf(value, attempt.eval_id).topics ?? []))].sort();

  const totals = {
    attempts: value.attempts.length,
    passed: value.attempts.filter((attempt) => attempt.status === "completed" && attempt.passed === true).length,
    failed: value.attempts.filter((attempt) => attempt.status === "completed" && attempt.passed !== true).length,
    incomplete: value.attempts.filter((attempt) => attempt.status === "incomplete").length,
    // Graded timeouts (completed, limit "timeout") plus legacy unscored ones.
    timedOut: value.attempts.filter((attempt) => (attempt.status === "completed" && attempt.limit === "timeout") || isUnscoredTimeout(attempt)).length,
    // Only unscored timeouts explain an incomplete run; graded ones are complete.
    unscoredTimedOut: value.attempts.filter(isUnscoredTimeout).length,
    errors: value.attempts.filter((attempt) => attempt.status === "error").length,
  };
  const scored = totals.passed + totals.failed;

  // Bands come from the whole run's report; section membership and counts
  // come from the filtered rows. An eval absent from the report (publication
  // omitted) is unbanded, like a single-arm eval. Schema < 8 reports carry no
  // band at all → the unbanded grid.
  const reportValue = report.status === "ready" ? report.value : null;
  const reportPairs = Array.isArray(reportValue?.pairs) ? reportValue.pairs : [];
  const banded = reportPairs.some((pair) => pair.band !== undefined);
  const bandOf = new Map<string, EvalBand | null>(reportPairs.map((pair) => [pair.eval_id, pair.band ?? null]));
  const rowsIn = (band: EvalBand | null) => grid.rows.filter((row) => (bandOf.get(row.evalId) ?? null) === band);
  const discriminatingRows = grid.rows.filter((row) => {
    const band = bandOf.get(row.evalId) ?? null;
    return band === null || band === "discriminating";
  });
  const unbandedCount = rowsIn(null).length;
  const solvedRows = rowsIn("solved-by-all");
  const failedRows = rowsIn("failed-by-all");
  const suspects = reportValue?.scorer_health?.suspects ?? [];
  const openCell = (clicked: HeatCell): void =>
    navigate(links.cell(runId, { evalId: clicked.evalId, experimentId: clicked.experimentId }));

  const selectSuite = (next: string): void => {
    setSuite(next);
    // Suite is part of cell identity: an open drill-down would show the wrong rows.
    if (cell) navigate(links.matrix(runId));
  };

  const setFilter = (key: keyof Filters) => (next: string): void => {
    setFilters((current) => ({ ...current, [key]: next }));
    if (cell) navigate(links.matrix(runId));
  };

  return (
    <div data-testid="matrix-view">
      <PublicationNotice coverage={value.publication} />
      <div className="page-head">
        <div>
          <h1>Eval × experiment matrix</h1>
          <p className="sub">
            Pass rate over scored attempts per cell; experiment columns are the treatment arms, grouped by comparison
            group. Select a cell for attempt evidence.
          </p>
        </div>
        <div className="controls">
          <div className="control">
            <label htmlFor="run-select">Run</label>
            <select
              id="run-select"
              data-testid="run-select"
              value={runId}
              onChange={(event) => navigate(links.matrix(event.currentTarget.value))}
            >
              {meta.runs.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.id.slice(0, 10)}… · {candidate.started_at.slice(0, 10)} · {candidate.attempts} attempts
                </option>
              ))}
            </select>
          </div>
          <FilterControl id="filter-product" label="Product" values={products} value={filters.product} onChange={setFilter("product")} />
          <FilterControl id="filter-framework" label="Framework" values={frameworkValues} value={filters.framework} onChange={setFilter("framework")} />
          <FilterControl id="filter-topic" label="Topic" values={topics} value={filters.topic} onChange={setFilter("topic")} />
          {suites.length > 1 && (
            <div className="control">
              <label>Suite</label>
              <div className="seg" role="group" aria-label="Suite">
                {suites.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    className={suite === candidate ? "active" : ""}
                    aria-pressed={suite === candidate}
                    data-testid={`suite-${candidate}`}
                    onClick={() => selectSuite(candidate)}
                  >
                    {candidate}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {(summary.finished_at === null || summary.incomplete) && (
        <div className="notice" data-testid="incomplete-banner">
          Incomplete run — {incompleteReason({ unfinished: summary.finished_at === null, incomplete: totals.incomplete, errors: totals.errors, timedOut: totals.unscoredTimedOut })}. Numbers are partial.
        </div>
      )}

      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Overall pass rate{suites.length > 1 ? " (all suites)" : ""}</div>
          <div className="kpi-val">{scored === 0 ? "—" : `${Math.round((totals.passed / scored) * 100)}%`}</div>
          <div className="kpi-meta">
            <StatBadge tone="green">{totals.passed} passed</StatBadge> <StatBadge tone="red">{totals.failed} failed</StatBadge>{" "}
            <StatBadge tone="gray">{totals.incomplete} incomplete</StatBadge> <StatBadge tone="amber">{totals.errors} errored</StatBadge>
            {totals.timedOut > 0 && <> <StatBadge tone="gray">{totals.timedOut} timed out</StatBadge></>}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Evals × experiments</div>
          <div className="kpi-val">
            {summary.eval_ids.length} × {summary.experiment_ids.length}
          </div>
          <div className="kpi-meta">{summary.attempts} attempts</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Trials per pair</div>
          <div className="kpi-val">{summary.trials}</div>
          <div className="kpi-meta">manifest {summary.manifest_hash.slice(0, 10)}…</div>
        </div>
      </div>

      <div className="card">
        <div className="head">
          <h3>
            Pass rate per eval × experiment
            {suite === "regression" && (
              <>
                {" "}
                <StatBadge tone="amber" title="Known failure modes — tracked separately from benchmark results.">
                  regression suite
                </StatBadge>
              </>
            )}
          </h3>
          <HeatmapLegend />
        </div>
        {suspects.length > 0 && reportValue?.scorer_health && (
          <div className="notice band-notice" data-testid="scorer-health-banner">
            {reportValue.scorer_health.summary}
            <ul>
              {suspects.map((suspect) => (
                <li key={`${suspect.eval_id}|${suspect.check}`}>
                  <code>{suspect.eval_id}</code> · <code>{suspect.check}</code> failed in {suspect.attempts} attempts under{" "}
                  {suspect.experiments.length} arms · passing: {suspect.passing_checks.join(", ")}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!banded ? (
          <Heatmap cells={grid.cells} rows={grid.rows} columns={grid.columns} onCellClick={openCell} />
        ) : (
          <>
            {discriminatingRows.length > 0 && (
              <section className="band" data-testid="matrix-band-discriminating">
                <h4>
                  Discriminating ({discriminatingRows.length} eval{plural(discriminatingRows.length)}) — arms disagree
                  {unbandedCount > 0 && ` (${unbandedCount} eval${plural(unbandedCount)} with one scored arm)`}
                </h4>
                <Heatmap cells={grid.cells} rows={discriminatingRows} columns={grid.columns} onCellClick={openCell} band="discriminating" />
              </section>
            )}
            {/* Uncontrolled <details>: the reader's toggle survives re-renders. */}
            {solvedRows.length > 0 && (
              <details className="band" data-testid="matrix-band-solved">
                <summary>
                  Solved by every arm ({solvedRows.length} eval{plural(solvedRows.length)})
                </summary>
                <Heatmap cells={grid.cells} rows={solvedRows} columns={grid.columns} onCellClick={openCell} band="solved by every arm" />
              </details>
            )}
            {failedRows.length > 0 && (
              <details className="band" data-testid="matrix-band-failed">
                <summary>
                  Failed by every arm ({failedRows.length} eval{plural(failedRows.length)}) — suspect the eval
                </summary>
                <Heatmap cells={grid.cells} rows={failedRows} columns={grid.columns} onCellClick={openCell} band="failed by every arm" />
              </details>
            )}
          </>
        )}
      </div>

      {/* The cell key (evalId × experimentId) is unambiguous across suites, so
          the drill-down reads ALL attempts — a deep link to a regression cell
          works regardless of the current suite toggle. */}
      {cell && <DrillDown runId={runId} run={value} cell={cell} attempts={value.attempts} />}
    </div>
  );
}
