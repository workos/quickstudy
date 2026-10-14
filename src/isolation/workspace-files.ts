import type { WorkspaceFiles, WorkspaceFilesIdentity } from "../runtime/workspace-files.ts";

/** The same program runs in the container and offline filesystem tests. No shell or payload in argv. */
export const WORKSPACE_FILES_PROGRAM = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
function apply(root, request) {
  const { files, absent } = request.declaration;
  const fail = () => { throw new Error('unsafe workspace state'); };
  const stat = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  if (!stat(root)?.isDirectory() || stat(root).isSymbolicLink()) fail();
  // No processes controlled by the agent run during preparation. On Linux,
  // directory descriptors also anchor traversal against concurrent renames.
  const descriptors = [];
  const directory = (p) => {
    const s = stat(p);
    if (!s?.isDirectory() || s.isSymbolicLink()) fail();
    const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    descriptors.push(fd);
    return process.platform === 'linux' ? '/proc/self/fd/' + fd : p;
  };
  const base = directory(root);
  const leaf = (relative, create = false) => {
    while (descriptors.length > 1) fs.closeSync(descriptors.pop());
    const parts = relative.split('/');
    let parent = base;
    for (const part of parts.slice(0, -1)) {
      const next = parent + '/' + part;
      if (!stat(next)) {
        if (!create) return null;
        fs.mkdirSync(next, { mode: 0o755 });
      }
      parent = directory(next);
    }
    return parent + '/' + parts.at(-1);
  };
  const checkAbsent = (relative) => { const p = leaf(relative); if (p !== null && stat(p)) fail(); };
  try {
    // Setup paths may be outside the workspace, but cannot alias it through
    // symlinks. Lexical overlap is separately rejected before any write.
    for (const target of request.setupPaths) {
      const absolute = path.resolve(root, target);
      let current = '/';
      for (const part of absolute.split('/').filter(Boolean)) {
        current = path.join(current, part);
        const s = stat(current);
        if (!s) break;
        if (s.isSymbolicLink()) fail();
      }
    }
    for (const relative of absent) checkAbsent(relative);
    if (request.phase === 'stage') {
      // Validate the entire inventory before writing even the first file.
      for (const file of files) checkAbsent(file.path);
      for (const file of files) {
        const p = leaf(file.path, true);
        const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
        try { fs.writeFileSync(fd, Buffer.from(file.content, 'base64')); fs.fchmodSync(fd, 0o644); }
        finally { fs.closeSync(fd); }
      }
    }
    const inventory = files.map((file) => {
      const p = leaf(file.path);
      if (!p) fail();
      const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const s = fs.fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o644 || s.size > 262144) fail();
        const bytes = fs.readFileSync(fd);
        return { path: file.path, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), source: file.source };
      } finally { fs.closeSync(fd); }
    });
    return { version: 1, files: inventory, absent };
  } finally { for (const fd of descriptors.reverse()) fs.closeSync(fd); }
}
try {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(apply(process.argv[1], request)));
} catch { process.stderr.write('workspaceFiles: filesystem validation/write/read-back failed'); process.exitCode = 1; }
`;

export interface WorkspaceFilesRequest {
  declaration: WorkspaceFiles;
  phase: "stage" | "verify";
  setupPaths: string[];
}
export interface WorkspaceFilesEvidence {
  version: 1;
  verified: WorkspaceFilesIdentity;
  verifiedAt: number;
}
