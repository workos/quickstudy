/**
 * The probe runner's app lifecycle: a dev server that shrugs off SIGTERM
 * must still be gone after stopBackgroundApp, or the next probe boots on
 * another port while the stale server keeps answering. The shell contract
 * is pinned offline; the behavioural case runs where `setsid` exists (Linux,
 * the sandbox images) and skips elsewhere.
 */

import { describe, expect, test } from "bun:test";
import { APP_PID_PATH, startAppInBackground, stopBackgroundApp, type ProbeExecFn } from "../src/probe.ts";

const realExec: ProbeExecFn = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), opts?.timeoutMs ?? 30_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut: false };
};

describe("stopBackgroundApp", () => {
  test("terms the group, waits, then kills what is left — never only a polite TERM", async () => {
    const commands: string[][] = [];
    await stopBackgroundApp(async (cmd) => {
      commands.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    expect(commands).toHaveLength(1);
    const script = commands[0]![2]!;
    expect(script).toContain(`cat ${APP_PID_PATH}`);
    expect(script).toContain('kill -TERM -- "-$pid"');
    expect(script).toContain('kill -0 -- "-$pid"');
    expect(script).toContain('kill -KILL -- "-$pid"');
    expect(script.indexOf("kill -TERM")).toBeLessThan(script.indexOf("kill -KILL"));
  });

  test.skipIf(Bun.which("setsid") === null)(
    "a server that ignores SIGTERM is gone after stop",
    async () => {
      // A process group that traps TERM and keeps a child alive, like a dev
      // server whose worker outlives the parent.
      await startAppInBackground(realExec, `sh -c 'trap "" TERM; sh -c "trap \\"\\" TERM; sleep 300" & wait'`);
      const pid = (await Bun.file(APP_PID_PATH).text()).trim();
      expect(pid).toMatch(/^\d+$/);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await realExec(["sh", "-c", `kill -0 -- "-${pid}"`])).exitCode).toBe(0);

      const started = Date.now();
      await stopBackgroundApp(realExec);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect((await realExec(["sh", "-c", `kill -0 -- "-${pid}"`])).exitCode).not.toBe(0);
    },
    30_000,
  );
});
