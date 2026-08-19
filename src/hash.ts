/**
 * Content-hashing primitives for the v3 run manifest. Extracted from the
 * legacy experiment-identity module (deleted with the v2 stack) as a
 * byte-for-byte behavior match, so digests recorded by v2 runs stay
 * comparable with v3 ones.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join, relative } from "node:path";

/** A content digest plus the file accounting that produced it. */
export interface ContentIdentity {
  sha256: string;
  files?: number;
  excluded?: number;
}

/**
 * Basenames that look like credentials never enter a content digest.
 * (The legacy scenario loader's sidecar filename guard shared this exact
 * regex before its deletion; it stays exported for tests and any future
 * consumer with the same "invisible to the digest ⇒ carries no behavior"
 * invariant.)
 */
export const SECRET_FILE = /(?:^|[._-])(?:env|credentials?|tokens?|secrets?|private[._-]?keys?|mcp[._-]?auth)(?:$|[._-])|\.(?:pem|key|p12|pfx)$/i;
const SKIP_DIR = new Set([".git", "node_modules", "vendor", ".venv", "results", "dist"]);

/** SHA-256 hex digest of a string or byte buffer. */
export function hashString(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Hash a directory exactly by relative path, type, executable bit and bytes.
 * Secret-looking files are rejected before read and represented only by an
 * exclusion count; their names and contents never enter the digest.
 */
export function hashTree(root: string): ContentIdentity {
  const hash = createHash("sha256");
  let files = 0;
  let excluded = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).split("\\").join("/");
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        if (SKIP_DIR.has(name) || SECRET_FILE.test(name)) {
          excluded += 1;
          continue;
        }
        walk(path);
        continue;
      }
      if (SECRET_FILE.test(basename(path))) {
        excluded += 1;
        continue;
      }
      if (stat.isSymbolicLink()) {
        hash.update(`L\0${rel}\0${readlinkSync(path)}\0`);
        files += 1;
        continue;
      }
      if (!stat.isFile()) continue;
      hash.update(`F\0${rel}\0${stat.mode & 0o111 ? "x" : "-"}\0`);
      hash.update(readFileSync(path));
      hash.update("\0");
      files += 1;
    }
  };
  walk(root);
  return { sha256: hash.digest("hex"), files, excluded };
}
