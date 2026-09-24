/**
 * Workspace-source preparation shared by both runner paths (host and
 * container) and by `validate --oracle`: build the attempt's starting tree in
 * a fresh temp directory. The host path copies it into the attempt scratch
 * dir; the container path `docker cp`s it whole into /workspace.
 */

import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartingState } from "../adapters/types.ts";
import type { LoadedEval } from "../evals/types.ts";

export type { StartingState } from "../adapters/types.ts";

/**
 * Prepare the attempt's starting state: a copy of `local/`, or empty
 * (tools-only evals). With `startingState: "solution"` the eval's
 * `solution/` is then copied over it — solution files win; solutions are
 * additive overlays and cannot delete fixture files.
 */
export async function prepWorkspaceSource(loadedEval: LoadedEval, startingState: StartingState = "fixture"): Promise<string> {
  const sourceDir = await mkdtemp(join(tmpdir(), "quickstudy-v3-source-"));
  if (loadedEval.localDir !== null) {
    await cp(loadedEval.localDir, sourceDir, { recursive: true });
  }
  if (startingState === "solution") {
    if (loadedEval.solutionDir === null) {
      throw new Error(`eval "${loadedEval.metadata.id}" has no solution/ — the oracle adapter needs one`);
    }
    await cp(loadedEval.solutionDir, sourceDir, { recursive: true, force: true });
  }
  return sourceDir;
}
