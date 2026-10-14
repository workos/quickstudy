import { hashString, SECRET_FILE } from "../hash.ts";
import { EXCLUDED_WORKSPACE_DIRS } from "../store/artifacts.ts";

/** Non-secret, regular, non-executable files. Source labels are declarations, not attestations. */
export interface WorkspaceFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  source: { id: string; version: string };
}

/** v1: create-only, no symlinks/hardlinks, 0644 files, final read-back, no deletion. */
export interface WorkspaceFiles {
  version: 1;
  files: readonly WorkspaceFile[];
  absent: readonly string[];
}

export interface WorkspaceFilesIdentity {
  version: 1;
  files: readonly { path: string; size: number; sha256: string; source: { id: string; version: string } }[];
  absent: readonly string[];
}

export const WORKSPACE_FILES_LIMITS = Object.freeze({ files: 128, absent: 128, fileBytes: 262144, totalBytes: 1048576, pathBytes: 240, depth: 16, timeoutMs: 30000 });

function invalid(reason: string): never {
  // Never interpolate consumer data: even malformed metadata may contain secrets.
  throw new Error(`workspaceFiles: ${reason}`);
}

function pathCheck(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.length > WORKSPACE_FILES_LIMITS.pathBytes) invalid("invalid relative path");
  const parts = path.split("/");
  if (parts.length > WORKSPACE_FILES_LIMITS.depth || parts.some((part) =>
    !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === ".." || part.endsWith(".") ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) ||
    EXCLUDED_WORKSPACE_DIRS.includes(part.toLowerCase()) || SECRET_FILE.test(part) ||
    /^\.(?:git|hg|svn)/i.test(part) || /^\.quickstudy/i.test(part)
  )) invalid("unsafe or reserved relative path");
}

export function pathsOverlap(a: string, b: string): boolean {
  a = a.toLowerCase(); b = b.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Validate, copy, canonicalize to base64, and freeze without retaining mutable caller state. */
export function defineWorkspaceFiles(input: WorkspaceFiles): WorkspaceFiles {
  if (!input || input.version !== 1) invalid("unsupported staging version");
  if (!Array.isArray(input.files) || !Array.isArray(input.absent) ||
      input.files.length > WORKSPACE_FILES_LIMITS.files || input.absent.length > WORKSPACE_FILES_LIMITS.absent) invalid("invalid inventory or count limit exceeded");
  let total = 0;
  const files = input.files.map((file) => {
    if (!file || typeof file.content !== "string" || file.content.length > WORKSPACE_FILES_LIMITS.fileBytes * 4) invalid("invalid or oversized payload");
    pathCheck(file.path);
    if (!file.source || ![file.source.id, file.source.version].every((v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,159}$/.test(v))) invalid("invalid source id/version (use opaque labels, not paths or URLs)");
    if (file.encoding !== "utf8" && file.encoding !== "base64") invalid("unsupported encoding");
    const bytes = Buffer.from(file.content, file.encoding === "utf8" ? "utf8" : "base64");
    if (file.encoding === "base64" && bytes.toString("base64") !== file.content) invalid("base64 must be canonical padded RFC 4648");
    if (file.encoding === "utf8" && bytes.toString("utf8") !== file.content) invalid("utf8 must not contain unpaired surrogates");
    total += bytes.length;
    if (bytes.length > WORKSPACE_FILES_LIMITS.fileBytes || total > WORKSPACE_FILES_LIMITS.totalBytes) invalid("payload size limit exceeded");
    return Object.freeze({ path: file.path, content: bytes.toString("base64"), encoding: "base64" as const, source: Object.freeze({ id: file.source.id, version: file.source.version }) });
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const absent = [...input.absent];
  for (const path of absent) pathCheck(path);
  const paths = [...files.map((file) => file.path), ...absent];
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (pathsOverlap(paths[i]!, paths[j]!)) invalid("duplicate or overlapping destinations/absence assertions");
  }
  return Object.freeze({ version: 1, files: Object.freeze(files), absent: Object.freeze(absent.sort()) });
}

export function workspaceFilesIdentity(input: WorkspaceFiles): WorkspaceFilesIdentity {
  const declaration = defineWorkspaceFiles(input);
  return {
    version: declaration.version,
    files: declaration.files.map((file) => {
      const bytes = Buffer.from(file.content, "base64");
      return { path: file.path, size: bytes.length, sha256: hashString(bytes), source: file.source };
    }),
    absent: declaration.absent,
  };
}

export function validateWorkspaceFilesRuntime(runtime: { kind: string; command?: string[]; workspaceFiles?: WorkspaceFiles }): void {
  if (runtime.workspaceFiles === undefined) return;
  defineWorkspaceFiles(runtime.workspaceFiles);
  if (runtime.kind !== "container" || (runtime.command?.length ?? 0) > 0) invalid("requires a container adapter; host and scripted commands are unsupported");
}
