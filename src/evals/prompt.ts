/**
 * PROMPT.md parser: YAML frontmatter (the eval's metadata) followed by the
 * task body, which is passed through verbatim. The frontmatter schema is
 * deliberately tiny and closed — unknown keys are rejected with a pointer at
 * the offending line, because new metadata fields require a proven
 * filtering/reporting use case before they exist. Two keys are control flow
 * for discovery rather than metadata: `frameworks` (expand the directory
 * into one eval per framework) and `local` (a shared per-framework
 * starting-state root for variant evals). Both are consumed by discovery
 * and never appear on the expanded metadata.
 */

import { isAbsolute } from "node:path";
import YAML from "yaml";
import { EVAL_SUITES, type EvalMetadata, type EvalSuite } from "./types.ts";

/** A PROMPT.md failed to parse or validate. Carries file + 1-based line. */
export class EvalLoadError extends Error {
  readonly file: string;
  readonly line: number;

  constructor(file: string, line: number, detail: string) {
    super(`${file}:${line}: ${detail}`);
    this.name = "EvalLoadError";
    this.file = file;
    this.line = line;
  }
}

export interface ParsedPrompt {
  metadata: EvalMetadata;
  /** Everything after the closing frontmatter fence, verbatim. */
  promptBody: string;
  /** `frameworks:` variant list — discovery expands one eval per entry. */
  frameworks?: string[];
  /** `local:` shared starting-state root, relative to the eval directory. */
  local?: string;
}

const KNOWN_KEYS = ["id", "suite", "product", "framework", "frameworks", "local", "topics"] as const;

/** Framework tokens become id suffixes (`<dirname>-<fw>`), so they must be kebab-case. */
const FRAMEWORK_TOKEN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Parse a PROMPT.md source string. `file` is used for error messages only. */
export function parsePrompt(source: string, file: string): ParsedPrompt {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new EvalLoadError(
      file,
      1,
      `expected YAML frontmatter opening "---", found ${JSON.stringify(lines[0] ?? "<empty file>")}`,
    );
  }
  const fmClose = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (fmClose === -1) {
    throw new EvalLoadError(file, lines.length, `frontmatter never closed: expected a "---" line`);
  }

  let raw: unknown;
  try {
    raw = YAML.parse(lines.slice(1, fmClose).join("\n"));
  } catch (err) {
    const yamlLine = err instanceof YAML.YAMLParseError ? (err.linePos?.[0]?.line ?? 1) : 1;
    throw new EvalLoadError(file, 1 + yamlLine, `invalid YAML in frontmatter: ${(err as Error).message.split("\n")[0]}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EvalLoadError(file, 2, `frontmatter must be a YAML mapping (id, suite, ...)`);
  }
  const fm = raw as Record<string, unknown>;

  // 1-based line of the `key:` line, for precise errors.
  const keyLine = (key: string): number => {
    const idx = lines.findIndex((l, index) => index > 0 && index < fmClose && l.startsWith(`${key}:`));
    return idx === -1 ? 2 : idx + 1;
  };

  for (const key of Object.keys(fm)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      throw new EvalLoadError(
        file,
        keyLine(key),
        `unknown frontmatter key "${key}" (allowed: ${KNOWN_KEYS.join(", ")}); ` +
          `new metadata fields need a proven filtering or reporting use case first`,
      );
    }
  }

  const id = fm["id"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new EvalLoadError(file, keyLine("id"), `"id" must be a non-empty string`);
  }
  const suite = fm["suite"];
  if (typeof suite !== "string" || !(EVAL_SUITES as readonly string[]).includes(suite)) {
    throw new EvalLoadError(
      file,
      keyLine("suite"),
      `"suite" must be one of: ${EVAL_SUITES.join(", ")}${suite === undefined ? " (missing)" : ` (got ${JSON.stringify(suite)})`}`,
    );
  }
  const optionalString = (key: "product" | "framework"): string | undefined => {
    const value = fm[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      throw new EvalLoadError(file, keyLine(key), `"${key}" must be a non-empty string`);
    }
    return value;
  };
  const product = optionalString("product");
  const framework = optionalString("framework");
  let frameworks: string[] | undefined;
  if (fm["frameworks"] !== undefined) {
    const value = fm["frameworks"];
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
      throw new EvalLoadError(file, keyLine("frameworks"), `"frameworks" must be a non-empty list of framework tokens`);
    }
    const tokens = value as string[];
    for (const token of tokens) {
      if (!FRAMEWORK_TOKEN.test(token)) {
        throw new EvalLoadError(
          file,
          keyLine("frameworks"),
          `"frameworks" entry ${JSON.stringify(token)} must be a kebab-case token ` +
            `(lowercase letters, digits, hyphens — it becomes the "<dirname>-<framework>" id suffix)`,
        );
      }
    }
    if (new Set(tokens).size !== tokens.length) {
      throw new EvalLoadError(file, keyLine("frameworks"), `"frameworks" entries must be unique`);
    }
    if (framework !== undefined) {
      throw new EvalLoadError(
        file,
        keyLine("framework"),
        `"framework" cannot be set alongside "frameworks" — expansion sets framework per variant`,
      );
    }
    frameworks = tokens;
  }
  let local: string | undefined;
  if (fm["local"] !== undefined) {
    const value = fm["local"];
    if (typeof value !== "string" || value.trim() === "") {
      throw new EvalLoadError(file, keyLine("local"), `"local" must be a non-empty relative path`);
    }
    if (isAbsolute(value)) {
      throw new EvalLoadError(
        file,
        keyLine("local"),
        `"local" must be a relative path (resolved from the eval directory), got an absolute path`,
      );
    }
    if (frameworks === undefined) {
      throw new EvalLoadError(
        file,
        keyLine("local"),
        `"local" requires "frameworks" — it points at per-framework starting states ` +
          `(<local>/<framework>); a single-directory eval uses its local/ directory`,
      );
    }
    local = value;
  }
  let topics: string[] | undefined;
  if (fm["topics"] !== undefined) {
    const value = fm["topics"];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
      throw new EvalLoadError(file, keyLine("topics"), `"topics" must be a list of non-empty strings`);
    }
    topics = value as string[];
  }

  const promptBody = lines.slice(fmClose + 1).join("\n");
  if (promptBody.trim() === "") {
    throw new EvalLoadError(file, fmClose + 1, `PROMPT.md has no task body after the frontmatter`);
  }

  const metadata: EvalMetadata = {
    id,
    suite: suite as EvalSuite,
    ...(product !== undefined ? { product } : {}),
    ...(framework !== undefined ? { framework } : {}),
    ...(topics !== undefined ? { topics } : {}),
  };
  return {
    metadata,
    promptBody,
    ...(frameworks !== undefined ? { frameworks } : {}),
    ...(local !== undefined ? { local } : {}),
  };
}
