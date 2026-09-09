/**
 * Typed loaders for the exported data directory.
 *
 * Source order per document: the inlined `window.__QS_DATA__` index (present
 * in exported sites, required for file:// where fetch of local JSON is
 * blocked), then relative `./data/*` fetches (dev server, `quickstudy ui`,
 * any static host). Text assets (transcripts, diffs) are ALWAYS lazy
 * fetches — under file:// they degrade to a named, actionable error instead
 * of a blank page.
 */

import type { DiagnosisJson } from "../../src/diagnose/types.ts";
import { DATA_SCHEMA_VERSION, type DataMeta, type DataRun, type InlineData } from "../../src/export-types.ts";
import type { ReportJson } from "../../src/report/report.ts";

export type DataErrorKind = "missing" | "invalid" | "schema" | "offline-asset";

/** Every loader failure names the path that failed — per-view error surfaces render it. */
export class DataError extends Error {
  readonly kind: DataErrorKind;
  readonly path: string;

  constructor(kind: DataErrorKind, path: string, message: string) {
    super(message);
    this.name = "DataError";
    this.kind = kind;
    this.path = path;
  }
}

declare global {
  interface Window {
    __QS_DATA__?: InlineData;
  }
}

function inlineData(): InlineData | undefined {
  return typeof window === "undefined" ? undefined : window.__QS_DATA__;
}

const IS_FILE_PROTOCOL = typeof window !== "undefined" && window.location.protocol === "file:";

async function fetchJson<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path);
  } catch {
    throw new DataError(
      IS_FILE_PROTOCOL ? "offline-asset" : "missing",
      path,
      IS_FILE_PROTOCOL
        ? `${path} cannot be fetched from a file:// page — serve this directory (e.g. \`quickstudy ui\`) to load it`
        : `failed to fetch ${path} — is the data directory being served?`,
    );
  }
  if (!response.ok) {
    throw new DataError("missing", path, `${path} responded ${response.status}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new DataError("invalid", path, `${path} is not valid JSON`);
  }
}

/** Load and version-check the data index. A schema mismatch is an explicit, banner-able error. */
export async function loadMeta(): Promise<DataMeta> {
  const inline = inlineData();
  const meta = inline ? inline.meta : await fetchJson<DataMeta>("data/meta.json");
  if (typeof meta !== "object" || meta === null || !Array.isArray(meta.runs)) {
    throw new DataError("invalid", "data/meta.json", "data/meta.json does not look like a quickstudy data index");
  }
  if (meta.schemaVersion !== DATA_SCHEMA_VERSION) {
    throw new DataError(
      "schema",
      "data/meta.json",
      `data schemaVersion ${meta.schemaVersion} does not match this UI build (expects ${DATA_SCHEMA_VERSION}) — ` +
        "re-export the site with the matching quickstudy version",
    );
  }
  return meta;
}

async function runDataPath(runId: string): Promise<string> {
  const meta = await loadMeta();
  return `data/${meta.run_paths?.[runId] ?? `runs/${encodeURIComponent(runId)}`}`;
}

export async function loadRun(runId: string): Promise<DataRun> {
  const inline = inlineData();
  const fromInline = inline?.runs[runId];
  if (fromInline) return fromInline;
  return fetchJson<DataRun>(`${await runDataPath(runId)}/run.json`);
}

export async function loadReport(runId: string): Promise<ReportJson> {
  const inline = inlineData();
  const fromInline = inline?.reports[runId];
  if (fromInline) return fromInline;
  return fetchJson<ReportJson>(`${await runDataPath(runId)}/report.json`);
}

/**
 * loadReport's twin with one deliberate divergence: a diagnosis is optional
 * (export embeds it only when `quickstudy diagnose` produced one), so absence
 * returns null — the view owns the "how to produce one" empty state — and the
 * offline file:// fetch block degrades the same way, never to an error panel.
 */
export async function loadDiagnosis(runId: string): Promise<DiagnosisJson | null> {
  const inline = inlineData();
  const fromInline = inline?.diagnoses?.[runId];
  if (fromInline) return fromInline;
  try {
    return await fetchJson<DiagnosisJson>(`${await runDataPath(runId)}/diagnosis.json`);
  } catch (error) {
    if (error instanceof DataError && (error.kind === "missing" || error.kind === "offline-asset")) return null;
    throw error;
  }
}

/**
 * Fetch a lazy text asset (transcript/diff) by its run-relative path from
 * `DataAttempt.transcript` / `.diff`. Never inlined — these are the bulky
 * artifacts the inline index deliberately leaves out.
 */
export async function loadTextAsset(runId: string, relativePath: string): Promise<string> {
  const path = `data/runs/${encodeURIComponent(runId)}/${relativePath}`;
  let response: Response;
  try {
    response = await fetch(path);
  } catch {
    throw new DataError(
      IS_FILE_PROTOCOL ? "offline-asset" : "missing",
      path,
      IS_FILE_PROTOCOL
        ? "transcripts and diffs cannot be loaded from a file:// page — serve this directory (e.g. `bunx serve`, `python3 -m http.server`, or `quickstudy ui`) to view them"
        : `failed to fetch ${path}`,
    );
  }
  if (!response.ok) {
    throw new DataError("missing", path, `${path} responded ${response.status}`);
  }
  return response.text();
}
