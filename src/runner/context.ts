/**
 * Builds the {@link EvalContext} a scorer receives.
 *
 * File helpers read the EXPORTED workspace — stable on disk after the run.
 * `exec` is proxied into the live sandbox when the experiment ran in a
 * container (the runner keeps the container alive until the scorer resolves);
 * host experiments exec in the exported workspace directory. Capability slots
 * (`query`, `getClient`) are wired by experiment runtimes in a later phase —
 * until a runtime provides one, calling it throws a precise error instead of
 * failing mysteriously downstream.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { EvalContext, EvalExecResult } from "../evals/types.ts";

export interface BuildEvalContextOptions {
  evalId: string;
  experimentId: string;
  trialIndex: number;
  /** The eval's framework (metadata.framework); omitted for framework-neutral evals. */
  framework?: string;
  /** Absolute path of the exported workspace. */
  workspaceDir: string;
  /** Container-provided exec; omitted = host exec in the workspace dir. */
  exec?: (cmd: string[], opts?: { timeoutMs?: number }) => Promise<EvalExecResult>;
  /** Runtime capability slots (phase 2 wires these). */
  query?: (request: unknown) => Promise<unknown>;
  getClient?: (name: string) => unknown;
}

/** Resolve a workspace-relative path, refusing escapes. */
function insideWorkspace(workspaceDir: string, path: string): string {
  const abs = resolve(workspaceDir, path);
  const rel = relative(workspaceDir, abs);
  if (rel === ".." || rel.startsWith("../")) {
    throw new Error(`eval context paths must stay inside the workspace; got "${path}"`);
  }
  return abs;
}

async function hostExec(cwd: string, cmd: string[], opts?: { timeoutMs?: number }): Promise<EvalExecResult> {
  const [command, ...args] = cmd;
  if (command === undefined) throw new Error("exec: command must not be empty");
  const proc = Bun.spawn([command, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts?.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs);
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

export function buildEvalContext(options: BuildEvalContextOptions): EvalContext {
  const { workspaceDir } = options;
  return {
    evalId: options.evalId,
    experimentId: options.experimentId,
    trialIndex: options.trialIndex,
    ...(options.framework !== undefined ? { framework: options.framework } : {}),
    workspaceDir,
    fileExists: (path) => Promise.resolve(existsSync(insideWorkspace(workspaceDir, path))),
    readFile: (path) => readFile(insideWorkspace(workspaceDir, path), "utf8"),
    exec: options.exec ?? ((cmd, opts) => hostExec(workspaceDir, cmd, opts)),
    query:
      options.query ??
      (() => {
        throw new Error(`this experiment runtime does not provide query() (experiment "${options.experimentId}")`);
      }),
    getClient:
      options.getClient ??
      (() => {
        throw new Error(`this experiment runtime does not provide getClient() (experiment "${options.experimentId}")`);
      }),
  };
}
