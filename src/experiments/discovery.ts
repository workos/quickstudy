/**
 * Experiment discovery: import every `<root>/*.ts` module and collect its
 * default-exported experiment. Loud on the first problem — a module without
 * a valid default export, or two modules claiming one id, aborts the scan.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Experiment, LoadedExperiment } from "./types.ts";

/** An experiment module failed to import or its exported shape is invalid. */
export class ExperimentLoadError extends Error {
  readonly file: string;

  constructor(file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = "ExperimentLoadError";
    this.file = file;
  }
}

function isExperimentShaped(value: unknown): value is Experiment {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<Experiment>;
  return (
    typeof candidate.id === "string" &&
    candidate.id !== "" &&
    typeof candidate.agent?.adapter === "string" &&
    (candidate.runtime?.kind === "host" || candidate.runtime?.kind === "container")
  );
}

/** Discover every experiment under `root`, sorted by id. */
export async function discoverExperiments(root: string): Promise<LoadedExperiment[]> {
  const rootDir = resolve(root);
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    throw new Error(`experiments root "${root}" is not a directory`);
  }

  const loaded: LoadedExperiment[] = [];
  const files = readdirSync(rootDir)
    .filter((name) => name.endsWith(".ts"))
    .sort((a, b) => a.localeCompare(b));
  for (const name of files) {
    const path = join(rootDir, name);
    let module: Record<string, unknown>;
    try {
      module = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    } catch (err) {
      throw new ExperimentLoadError(path, `failed to import: ${err instanceof Error ? err.message : String(err)}`);
    }
    const experiment = module["default"];
    if (!isExperimentShaped(experiment)) {
      throw new ExperimentLoadError(
        path,
        `must default-export defineExperiment({ id, agent, runtime }); got ${experiment === undefined ? "no default export" : "an invalid shape"}`,
      );
    }
    loaded.push({ experiment, path });
  }

  const byId = new Map<string, LoadedExperiment>();
  for (const entry of loaded) {
    const existing = byId.get(entry.experiment.id);
    if (existing) {
      throw new ExperimentLoadError(
        entry.path,
        `duplicate experiment id "${entry.experiment.id}" — also declared by ${existing.path}`,
      );
    }
    byId.set(entry.experiment.id, entry);
  }

  return loaded.sort((a, b) => a.experiment.id.localeCompare(b.experiment.id));
}
