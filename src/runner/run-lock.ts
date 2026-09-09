import { mkdirSync, openSync, readFileSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
/** Refuse simultaneous writers; recover a lock only when its process is gone. */
export function acquireRunLock(root: string, runId: string): () => void {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "runner.lock");
  const create = () => {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    create();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isInteger(pid) || pid < 1) throw new Error(`invalid run lock for ${runId}`);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) throw new Error(`run ${runId} is already active (pid ${pid})`);
    unlinkSync(path);
    create();
  }
  return () => {
    unlinkSync(path);
  };
}
