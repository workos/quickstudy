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
    // The group is enumerated from /proc: dash's builtin kill cannot signal a
    // negative pid, so `kill -- -<pgid>` is only the no-/proc fallback.
    expect(script).toContain("/proc/[0-9]*");
    expect(script).toContain("signal TERM");
    expect(script).toContain("signal KILL");
    expect(script.indexOf("signal TERM")).toBeLessThan(script.indexOf("signal KILL"));
  });

  test.skipIf(Bun.which("setsid") === null)(
    "a server that ignores SIGTERM is gone after stop",
    async () => {
      // A process group that traps TERM and keeps a child alive, like a dev
      // server whose worker outlives the parent. A script file keeps the
      // start command free of quotes (startAppInBackground wraps it in `sh -c '…'`).
      const script = `/tmp/quickstudy-stubborn-${process.pid}.sh`;
      await Bun.write(script, 'trap "" TERM\nsh -c \'trap "" TERM; sleep 300\' &\nwait\n');
      await startAppInBackground(realExec, `sh ${script}`);
      const pid = (await Bun.file(APP_PID_PATH).text()).trim();
      expect(pid).toMatch(/^\d+$/);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Group members by /proc, the way the stop itself finds them.
      const members = async () =>
        (await realExec(["sh", "-c", `for d in /proc/[0-9]*; do pg=$(sed "s/^.*) //" "$d/stat" 2>/dev/null | cut -d" " -f3); [ "$pg" = "${pid}" ] && echo "\${d#/proc/}"; done`])).stdout.trim().split("\n").filter(Boolean);
      expect((await members()).length).toBeGreaterThanOrEqual(2);

      const started = Date.now();
      await stopBackgroundApp(realExec);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(await members()).toEqual([]);
    },
    30_000,
  );
});
