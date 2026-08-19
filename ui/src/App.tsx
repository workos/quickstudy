/**
 * App shell: loads the data index once, then dispatches on the hash route.
 * Empty data dir renders a friendly getting-started state; a schemaVersion
 * mismatch renders the loud banner (see ErrorPanel); a retired (pre-v3) link
 * format renders the matrix with an explicit notice, never a blank page.
 */

import type { ReactNode } from "react";
import type { DataMeta } from "../../src/export-types.ts";
import { ErrorPanel, ViewErrorBoundary } from "./components/ErrorPanel.tsx";
import { loadMeta } from "./data.ts";
import { useAsync } from "./hooks.ts";
import { links, useRoute, type Route } from "./router.ts";
import { AttemptView } from "./views/Attempt.tsx";
import { Compare } from "./views/Compare.tsx";
import { Diagnosis } from "./views/Diagnosis.tsx";
import { Matrix } from "./views/Matrix.tsx";
import { Report } from "./views/Report.tsx";

function EmptyState(): ReactNode {
  return (
    <div className="empty-state" data-testid="empty-state">
      <h2>No runs in this data directory yet</h2>
      <p>Execute a sweep, then re-export (or restart) the UI:</p>
      <pre>
        <code>
          quickstudy run --eval my-eval --experiment my-experiment{"\n"}
          quickstudy ui
        </code>
      </pre>
      <p>
        The matrix, compare, report, and diagnosis views light up as soon as a run exists.
      </p>
    </div>
  );
}

function NavTabs({ route, meta }: { route: Route; meta: DataMeta }): ReactNode {
  const newestRun = meta.runs[0]?.id;
  const isMatrix = route.view === "matrix" || route.view === "attempt";
  return (
    <nav className="tabs" aria-label="Views">
      <a href={links.matrix()} className={isMatrix ? "tab active" : "tab"} aria-current={isMatrix ? "page" : undefined}>
        Matrix
      </a>
      <a href={links.compare()} className={route.view === "compare" ? "tab active" : "tab"} aria-current={route.view === "compare" ? "page" : undefined}>
        Compare
      </a>
      <a href={links.report(newestRun)} className={route.view === "report" ? "tab active" : "tab"} aria-current={route.view === "report" ? "page" : undefined}>
        Report
      </a>
      <a href={links.diagnosis(newestRun)} className={route.view === "diagnosis" ? "tab active" : "tab"} aria-current={route.view === "diagnosis" ? "page" : undefined}>
        Diagnosis
      </a>
    </nav>
  );
}

function View({ route, meta }: { route: Route; meta: DataMeta }): ReactNode {
  const newestRun = meta.runs[0]?.id;
  switch (route.view) {
    case "matrix":
      return <Matrix meta={meta} runId={route.runId ?? newestRun ?? ""} cell={route.cell} />;
    case "attempt":
      return <AttemptView runId={route.runId} attemptId={route.attemptId} artifact={route.artifact} lines={route.lines} />;
    case "compare":
      return <Compare meta={meta} runId={route.runId ?? newestRun} />;
    case "report":
      return <Report meta={meta} runId={route.runId ?? newestRun ?? ""} />;
    case "diagnosis":
      return <Diagnosis meta={meta} runId={route.runId ?? newestRun ?? ""} />;
  }
}

export function App(): ReactNode {
  const route = useRoute();
  const meta = useAsync(() => loadMeta(), []);
  const legacyLink = (route.view === "matrix" || route.view === "compare") && route.legacyLink === true;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          quickstudy
        </div>
        {meta.status === "ready" && <NavTabs route={route} meta={meta.value} />}
      </header>
      <main className="content">
        {legacyLink && (
          <div className="notice" data-testid="legacy-link-notice">
            This link uses a URL format from an earlier quickstudy version — showing the closest current view.
          </div>
        )}
        {meta.status === "loading" && <div className="loading">Loading data index…</div>}
        {meta.status === "error" && <ErrorPanel error={meta.error} />}
        {meta.status === "ready" &&
          (meta.value.runs.length === 0 ? (
            <EmptyState />
          ) : (
            <ViewErrorBoundary key={JSON.stringify(route)}>
              <View route={route} meta={meta.value} />
            </ViewErrorBoundary>
          ))}
      </main>
    </div>
  );
}
