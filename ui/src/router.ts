/**
 * Minimal hash router. Hash-based routing is one of the three file://
 * disciplines: the document URL never changes, so no server-side routes and
 * no history API are needed.
 *
 * Route grammar (v3):
 *   #/                                          -> matrix (newest run)
 *   #/run/<runId>                               -> matrix for a run
 *   #/run/<runId>/cell/<evalId>/<experimentId>  -> matrix + drill-down
 *   #/run/<runId>/attempt/<attemptId>/<artifact>[/L<start>-<end>]
 *                                               -> transcript/diff viewer
 *   #/compare[/<runId>]                         -> comparison groups
 *   #/report[/<runId>]                          -> report
 *   #/diagnosis[/<runId>]                       -> diagnosis
 *
 * Published v2 sites minted three-segment cell links and `#/trend` — those
 * hashes live forever in old links, so old-shaped hashes fall back to the
 * matrix WITH an explicit "link format changed" notice, never a blank page.
 */

import { useSyncExternalStore } from "react";

export interface MatrixRoute {
  view: "matrix";
  runId?: string;
  cell?: { evalId: string; experimentId: string };
  /** The hash used a retired (pre-v3) link format — render the notice. */
  legacyLink?: boolean;
}

export interface AttemptRoute {
  view: "attempt";
  runId: string;
  attemptId: string;
  artifact: "transcript" | "diff";
  /** 1-indexed inclusive line range from an `L<start>-<end>` segment. */
  lines?: [number, number];
}

export interface CompareRoute {
  view: "compare";
  runId?: string;
  legacyLink?: boolean;
}

export interface ReportRoute {
  view: "report";
  runId?: string;
}

export interface DiagnosisRoute {
  view: "diagnosis";
  runId?: string;
}

export type Route = MatrixRoute | AttemptRoute | CompareRoute | ReportRoute | DiagnosisRoute;

function segmentsOf(hash: string): string[] {
  return hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeURIComponent);
}

const LINE_RANGE = /^L(\d+)-(\d+)$/;

/** Parse a location hash. Unknown routes fall back to the matrix view. */
export function parseRoute(hash: string): Route {
  const segments = segmentsOf(hash);
  const [head] = segments;

  if (head === "compare") {
    const [, runId, legacyRunB] = segments;
    // v2 compare links carried TWO run ids (run-vs-run deltas). The view is
    // now comparison groups within one run — flag the old shape.
    if (legacyRunB !== undefined) {
      return { view: "compare", ...(runId !== undefined ? { runId } : {}), legacyLink: true };
    }
    return { view: "compare", ...(runId !== undefined ? { runId } : {}) };
  }

  if (head === "report") {
    const [, runId] = segments;
    return { view: "report", ...(runId !== undefined ? { runId } : {}) };
  }

  if (head === "diagnosis") {
    const [, runId] = segments;
    return { view: "diagnosis", ...(runId !== undefined ? { runId } : {}) };
  }

  if (head === "trend") {
    // The Trend view was retired with the five-axis model.
    return { view: "matrix", legacyLink: true };
  }

  if (head === "run") {
    const [, runId, kind] = segments;
    if (runId === undefined) return { view: "matrix" };
    if (kind === "cell") {
      const [, , , evalId, experimentId, legacyThird] = segments;
      if (legacyThird !== undefined) {
        // v2 cell links had three segments (scenario/framework/surface).
        return { view: "matrix", runId, legacyLink: true };
      }
      if (evalId !== undefined && experimentId !== undefined) {
        return { view: "matrix", runId, cell: { evalId, experimentId } };
      }
      return { view: "matrix", runId };
    }
    if (kind === "attempt") {
      const [, , , attemptId, artifact, range] = segments;
      if (attemptId !== undefined && (artifact === "transcript" || artifact === "diff")) {
        const match = range === undefined ? null : LINE_RANGE.exec(range);
        const lines: [number, number] | undefined = match
          ? [Number(match[1]), Number(match[2])]
          : undefined;
        return { view: "attempt", runId, attemptId, artifact, ...(lines ? { lines } : {}) };
      }
      return { view: "matrix", runId };
    }
    return { view: "matrix", runId };
  }

  return { view: "matrix" };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function snapshot(): string {
  return window.location.hash;
}

/** The current parsed route, re-rendering on hashchange. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot);
  return parseRoute(hash);
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

const enc = encodeURIComponent;

/** Hash builders — every internal link goes through these. */
export const links = {
  matrix: (runId?: string): string => (runId === undefined ? "#/" : `#/run/${enc(runId)}`),
  cell: (runId: string, cell: { evalId: string; experimentId: string }): string =>
    `#/run/${enc(runId)}/cell/${enc(cell.evalId)}/${enc(cell.experimentId)}`,
  attempt: (runId: string, attemptId: string, artifact: "transcript" | "diff", lines?: [number, number]): string =>
    `#/run/${enc(runId)}/attempt/${enc(attemptId)}/${artifact}` + (lines ? `/L${lines[0]}-${lines[1]}` : ""),
  compare: (runId?: string): string => (runId === undefined ? "#/compare" : `#/compare/${enc(runId)}`),
  report: (runId?: string): string => (runId === undefined ? "#/report" : `#/report/${enc(runId)}`),
  diagnosis: (runId?: string): string => (runId === undefined ? "#/diagnosis" : `#/diagnosis/${enc(runId)}`),
};
