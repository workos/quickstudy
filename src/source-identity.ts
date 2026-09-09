import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { hashString, hashTree, SECRET_FILE } from "./hash.ts";
import { canonicalJson } from "./identity-diff.ts";

const LOCKS = ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
function packageRoot(path: string): string {
  let dir = dirname(path);
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (dir === parent) return dirname(path);
    dir = parent;
  }
  return dir;
}

/** Literal local imports plus explicitly declared dynamic resources and package resolutions.
 * Never evaluates consumer code. No credential bytes or absolute paths enter the manifest.
 */
export function sourceIdentity(entry: string): string {
  const root = packageRoot(entry);
  const hashes: Record<string, string> = {};
  const seen = new Set<string>();
  const walk = (file: string): void => {
    file = resolve(file);
    if (seen.has(file)) return;
    seen.add(file);
    if (SECRET_FILE.test(basename(file)) && !/\.[cm]?[jt]sx?$/.test(file)) return;
    const bytes = readFileSync(file);
    hashes[relative(root, file)] = hashString(bytes);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const loader = extname(file).endsWith("x") ? "tsx" : "ts";
    const imports = new Bun.Transpiler({ loader }).scanImports(bytes.toString());
    for (const item of imports) {
      if (item.path.startsWith("node:") || item.path.startsWith("bun:")) continue;
      if (item.path.startsWith(".")) walk(Bun.resolveSync(item.path, dirname(file)));
      else {
        // Lockfiles record transitive resolutions; package metadata also covers
        // installed versions when a consumer uses a local file dependency.
        let resolved: string;
        try {
          resolved = Bun.resolveSync(item.path, dirname(file));
        } catch {
          continue;
        }
        if (!resolved.startsWith("/")) continue; // built-in module
        const metadata = join(packageRoot(resolved), "package.json");
        if (existsSync(metadata)) hashes[`package:${item.path}`] = hashString(readFileSync(metadata));
      }
    }
  };
  walk(entry);
  for (const lock of LOCKS) {
    if (existsSync(join(root, lock))) hashes[lock] = hashString(readFileSync(join(root, lock)));
  }
  const declaration = join(root, "quickstudy.identity.json");
  if (existsSync(declaration)) {
    const config = JSON.parse(readFileSync(declaration, "utf8"));
    if (config.version !== 1 || !Array.isArray(config.sources))
      throw new Error("invalid quickstudy.identity.json (expected version 1 and sources array)");
    for (const source of config.sources) {
      if (
        typeof source !== "string" ||
        source === "" ||
        source.split(/[\\/]/).some((part) => part === ".." || SECRET_FILE.test(part))
      )
        throw new Error("invalid identity source path");
      const path = resolve(root, source);
      if (!path.startsWith(`${root}/`)) throw new Error("identity sources must be inside the consumer package");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("identity source roots must not be symlinks");
      hashes[`declared:${source}`] = stat.isDirectory() ? hashTree(path).sha256 : hashString(readFileSync(path));
    }
  }
  return hashString(canonicalJson(hashes));
}
