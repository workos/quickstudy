import { posix } from "node:path";
import { canonicalJson } from "../identity-diff.ts";
import type { AttemptContainer } from "../isolation/docker.ts";
import type { WorkspaceFilesEvidence } from "../isolation/workspace-files.ts";
import { pathsOverlap, WORKSPACE_FILES_LIMITS, type WorkspaceFiles, type WorkspaceFilesIdentity } from "../runtime/workspace-files.ts";

/** No race-to-timeout: await cancelled transport, then let the attempt's finally tear down. */
export async function stageWorkspaceFiles(
  container: AttemptContainer,
  declaration: WorkspaceFiles,
  intended: WorkspaceFilesIdentity,
  setup: Record<string, string>,
  parentSignal?: AbortSignal,
): Promise<WorkspaceFilesEvidence> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, WORKSPACE_FILES_LIMITS.timeoutMs);
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) abort();
  const signal = controller.signal;
  try {
    const setupPaths = Object.keys(setup);
    for (const path of setupPaths) {
      const relative = posix.relative("/workspace", posix.resolve("/workspace", path));
      if ([...intended.files.map((file) => file.path), ...intended.absent].some((target) => relative === "" || pathsOverlap(relative, target))) {
        throw new Error("workspaceFiles: adapter setup collision");
      }
    }
    const check = async (phase: "stage" | "verify") => {
      signal.throwIfAborted();
      const actual = await container.workspaceFiles({ declaration, phase, setupPaths }, signal);
      signal.throwIfAborted();
      if (canonicalJson(actual) !== canonicalJson(intended)) throw new Error("workspaceFiles: read-back/absence verification mismatch");
      return actual;
    };
    await check("stage");
    for (const [path, content] of Object.entries(setup)) {
      signal.throwIfAborted();
      await container.writeFile(path, content, { signal });
    }
    const verified = await check("verify");
    return { version: 1, verified, verifiedAt: Date.now() };
  } catch (err) {
    if (signal.aborted) throw new Error("workspaceFiles: staging cancelled or timed out");
    // Only our own fixed diagnostics survive; transport/setup errors may carry payloads.
    if (err instanceof Error && ["workspaceFiles: adapter setup collision", "workspaceFiles: read-back/absence verification mismatch"].includes(err.message)) throw err;
    throw new Error("workspaceFiles: staging filesystem/setup operation failed");
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}
