/**
 * Content-addressed artifacts directory for everything too bulky for SQLite.
 *
 * Layout, per attempt:
 *
 *   results/<run>/<attempt>/
 *     transcript.jsonl   one JSON event per line
 *     diff.patch         unified diff of the workspace against the fixture
 *     graders.json       per-check booleans + any grader errors
 *     error.txt          only when the attempt itself errored
 *     workspace/         the exported post-run workspace
 *
 * Attempt directories are append-only: the orchestrator writes each artifact
 * once and never rewrites it.
 *
 * Disk-fill mitigation: a full sweep is dozens of workspaces, and dependency
 * directories (node_modules, vendor, .venv) would multiply that by orders of
 * magnitude and kill the run late and expensively. Workspace export therefore
 * excludes them — the diff and transcript suffice to reconstruct what the
 * agent actually did.
 */

import { cp, mkdir, writeFile, lstat, realpath, readlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { WorkspaceFilesEvidence } from "../isolation/workspace-files.ts";
import type { TranscriptEvent } from "../adapters/types.ts";

/** Dependency directories never copied into an exported workspace. */
export const EXCLUDED_WORKSPACE_DIRS: readonly string[] = ["node_modules", "vendor", ".venv", ".git", ".next", ".cache", "__pycache__"];

export interface AttemptArtifactPaths {
  attemptDir: string;
  transcript: string;
  diff: string;
  graders: string;
  error: string;
  /** Egress-proxy denials for this attempt (JSON lines) — proxied runs only. */
  egressDenials: string;
  workspace: string;
}

/** The grading report persisted as `graders.json`. */
export interface GraderReport {
  /** check name -> pass/fail boolean, for every grader that completed. */
  checks: Record<string, boolean>;
  /** check name -> captured error, for every grader that threw. */
  errors: Record<string, string>;
}

export class ArtifactsStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  paths(runId: string, attemptId: string): AttemptArtifactPaths {
    const attemptDir = join(this.rootDir, runId, attemptId);
    return {
      attemptDir,
      transcript: join(attemptDir, "transcript.jsonl"),
      diff: join(attemptDir, "diff.patch"),
      graders: join(attemptDir, "graders.json"),
      error: join(attemptDir, "error.txt"),
      egressDenials: join(attemptDir, "egress-denials.log"),
      workspace: join(attemptDir, "workspace"),
    };
  }

  /** Create the attempt directory (idempotent) and return its paths. */
  async prepareAttempt(runId: string, attemptId: string): Promise<AttemptArtifactPaths> {
    const paths = this.paths(runId, attemptId);
    await mkdir(paths.attemptDir, { recursive: true });
    return paths;
  }

  /** Placement evidence, distinct from intended identity; proves no model use. */
  async writeWorkspaceFilesEvidence(runId: string, attemptId: string, evidence: WorkspaceFilesEvidence): Promise<void> {
    const paths = await this.prepareAttempt(runId, attemptId);
    await writeFile(join(paths.attemptDir, "workspace-files.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }

  async writeTranscript(runId: string, attemptId: string, events: TranscriptEvent[]): Promise<string> {
    const paths = await this.prepareAttempt(runId, attemptId);
    const jsonl = events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(paths.transcript, jsonl === "" ? "" : `${jsonl}\n`, "utf8");
    return paths.transcript;
  }

  /**
   * Persist a raw agent output stream as the transcript artifact. Container
   * adapters' vendor CLIs already emit JSONL — storing the raw stream (after
   * secret redaction, which the orchestrator applies) preserves evidence even
   * when telemetry parsing fails.
   */
  async writeTranscriptRaw(runId: string, attemptId: string, raw: string): Promise<string> {
    const paths = await this.prepareAttempt(runId, attemptId);
    await writeFile(paths.transcript, raw === "" || raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
    return paths.transcript;
  }

  async writeDiff(runId: string, attemptId: string, patch: string): Promise<string> {
    const paths = await this.prepareAttempt(runId, attemptId);
    await writeFile(paths.diff, patch, "utf8");
    return paths.diff;
  }

  async writeGraderReport(runId: string, attemptId: string, report: GraderReport): Promise<string> {
    const paths = await this.prepareAttempt(runId, attemptId);
    await writeFile(paths.graders, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return paths.graders;
  }

  /**
   * Persist an attempt's egress denials (one proxy decision JSON line each).
   * Written only when denials occurred — and denials are SIGNAL, not just
   * security: an agent reaching for an undocumented host is a DX finding.
   */
  async writeEgressDenials(runId: string, attemptId: string, lines: readonly string[]): Promise<string> {
    const paths = await this.prepareAttempt(runId, attemptId);
    await writeFile(paths.egressDenials, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
    return paths.egressDenials;
  }

  /** Capture a failed attempt's error (message + stack / stderr) to `error.txt`. */
  async writeError(runId: string, attemptId: string, text: string): Promise<string> {
    const paths = await this.prepareAttempt(runId, attemptId);
    await writeFile(paths.error, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    return paths.error;
  }

  /**
   * Copy a post-run workspace into the attempt directory, excluding
   * dependency directories (see EXCLUDED_WORKSPACE_DIRS). Returns the
   * exported workspace path.
   */
  async exportWorkspace(runId: string, attemptId: string, sourceDir: string): Promise<string> {
    const paths = await this.prepareAttempt(runId, attemptId);
    const canonicalSource = await realpath(sourceDir);
    await cp(sourceDir, paths.workspace, {
      recursive: true,
      verbatimSymlinks: true,
      filter: async (source) => {
        if (EXCLUDED_WORKSPACE_DIRS.includes(basename(source)) || /^\.env(?:\.|$)/.test(basename(source))) return false;
        if (!(await lstat(source)).isSymbolicLink()) return true;
        if ((await readlink(source)).startsWith("/")) return false;
        const destination = await realpath(source).catch(() => "");
        return destination.startsWith(`${canonicalSource}/`) || destination === resolve(canonicalSource);
      },
    });
    return paths.workspace;
  }
}
