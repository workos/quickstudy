/**
 * Eval discovery: scan each `<root>/<dir>/PROMPT.md`, pair it with its EVAL.ts, and
 * detect the optional `local/` starting-state directory. Discovery is dumb on
 * purpose — one visible expansion (a `frameworks:` frontmatter list yields
 * one eval per framework, id `<dirname>-<framework>`), no placeholders, no
 * binding — and loud: the first error aborts the scan.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { EvalLoadError, parsePrompt } from "./prompt.ts";
import type { EvalScorer, LoadedEval } from "./types.ts";

/** One collected eval; `framework` is set for variant-expanded entries. */
interface CollectedEval {
  loaded: LoadedEval;
  framework?: string;
}

/**
 * Discover every eval under `root`. A subdirectory containing a PROMPT.md is
 * an eval; it must also carry an EVAL.ts, its frontmatter `id` must equal the
 * directory name, and ids must be unique across the root.
 *
 * A `frameworks:` frontmatter list expands the directory into one eval per
 * framework: id `<dirname>-<framework>`, `metadata.framework` set, prompt and
 * scorer shared verbatim, starting state resolved per framework from
 * `local/<framework>` — or `<local:>/<framework>` when the eval points at a
 * shared fixture root. Everything downstream consumes the expanded
 * {@link LoadedEval}s exactly like single-directory ones.
 */
export function discoverEvals(root: string): LoadedEval[] {
  const rootDir = resolve(root);
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    throw new Error(`evals root "${root}" is not a directory`);
  }

  const collected: CollectedEval[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(rootDir, entry.name);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) continue;

    const { metadata, promptBody, frameworks, local } = parsePrompt(readFileSync(promptPath, "utf8"), promptPath);

    const scorerPath = join(dir, "EVAL.ts");
    if (!existsSync(scorerPath)) {
      throw new EvalLoadError(promptPath, 1, `eval "${metadata.id}" has no EVAL.ts next to its PROMPT.md (expected ${scorerPath})`);
    }

    if (frameworks === undefined) {
      const localDir = join(dir, "local");
      const hasLocal = existsSync(localDir) && statSync(localDir).isDirectory();
      collected.push({
        loaded: { metadata, dir, promptPath, promptBody, scorerPath, localDir: hasLocal ? localDir : null },
      });
      continue;
    }

    // Variant form: one eval per framework. The starting-state base is the
    // conventional local/ directory or the explicit `local:` path (shared
    // fixtures), resolved from the eval directory. hashTree receives the
    // resolved per-framework root, so unchanged fixture trees keep
    // byte-stable hashes wherever they live.
    const localBase = local === undefined ? join(dir, "local") : resolve(dir, local);
    const hasBase = existsSync(localBase) && statSync(localBase).isDirectory();
    if (local !== undefined) {
      const rootParent = dirname(rootDir);
      const escape = relative(rootParent, localBase);
      if (escape === ".." || escape.startsWith(`..${sep}`)) {
        throw new EvalLoadError(
          promptPath,
          1,
          `"local" path ${JSON.stringify(local)} resolves to ${localBase}, ` +
            `outside the evals root's parent (${rootParent})`,
        );
      }
      if (!hasBase) {
        throw new EvalLoadError(
          promptPath,
          1,
          `"local" path ${JSON.stringify(local)} resolves to ${localBase}, which is not a directory`,
        );
      }
    }
    // No starting state at all (no local/ and no `local:`) is valid — every
    // variant starts from an empty workspace, like a tools-only eval.
    for (const framework of frameworks) {
      let localDir: string | null = null;
      if (hasBase) {
        const frameworkDir = join(localBase, framework);
        if (!existsSync(frameworkDir) || !statSync(frameworkDir).isDirectory()) {
          throw new EvalLoadError(
            promptPath,
            1,
            `eval "${metadata.id}" lists framework "${framework}" but has no starting state for it ` +
              `(expected ${frameworkDir})`,
          );
        }
        localDir = frameworkDir;
      }
      collected.push({
        loaded: {
          metadata: { ...metadata, id: `${metadata.id}-${framework}`, framework },
          dir,
          promptPath,
          promptBody,
          scorerPath,
          localDir,
        },
        framework,
      });
    }
  }

  // Duplicates are checked BEFORE the id/dirname match so two directories
  // claiming one id — or a variant expansion colliding with a literal
  // directory — fail with both paths named, not with a mismatch message
  // that points at only one of them.
  const byId = new Map<string, CollectedEval>();
  for (const entry of collected) {
    const existing = byId.get(entry.loaded.metadata.id);
    if (existing) {
      throw new EvalLoadError(
        entry.loaded.promptPath,
        1,
        `duplicate eval id "${entry.loaded.metadata.id}" — also declared by ${existing.loaded.promptPath}`,
      );
    }
    byId.set(entry.loaded.metadata.id, entry);
  }
  for (const entry of collected) {
    const dirName = basename(entry.loaded.dir);
    const expected = entry.framework === undefined ? dirName : `${dirName}-${entry.framework}`;
    if (entry.loaded.metadata.id !== expected) {
      throw new EvalLoadError(
        entry.loaded.promptPath,
        1,
        entry.framework === undefined
          ? `frontmatter id "${entry.loaded.metadata.id}" must equal the directory name "${dirName}" (prevents silent aliasing)`
          : `expanded eval id "${entry.loaded.metadata.id}" must equal "<dirname>-<framework>" ("${expected}") — ` +
            `a variant eval's frontmatter id must equal its directory name (prevents silent aliasing)`,
      );
    }
  }

  return collected.map((entry) => entry.loaded).sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
}

/**
 * Import an eval's scorer module and validate its default export is a
 * function. Called by `validate` (so a broken EVAL.ts fails before any
 * attempt runs) and by the runner at score time.
 */
export async function importEvalScorer(scorerPath: string): Promise<EvalScorer> {
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(resolve(scorerPath)).href)) as Record<string, unknown>;
  } catch (err) {
    throw new EvalLoadError(scorerPath, 1, `EVAL.ts failed to import: ${err instanceof Error ? err.message : String(err)}`);
  }
  const scorer = module["default"];
  if (typeof scorer !== "function") {
    throw new EvalLoadError(
      scorerPath,
      1,
      `EVAL.ts must default-export an async scorer function (ctx) => EvalResult; got ${typeof scorer}`,
    );
  }
  return scorer as EvalScorer;
}
