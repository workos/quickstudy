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
      // Live group members by /proc, the way the stop itself finds them (zombies excluded).
      const members = async () =>
        (
          await realExec([
            "sh",
            "-c",
            `for d in /proc/[0-9]*; do set -- $(sed "s/^.*) //" "$d/stat" 2>/dev/null); [ "$3" = "${pid}" ] && [ "$1" != "Z" ] && echo "\${d#/proc/}"; done; true`,
          ])
        ).stdout
          .trim()
          .split("\n")
          .filter(Boolean);
      const settle = async (): Promise<string[]> => {
        const deadline = Date.now() + 5_000;
        let left = await members();
        while (left.length > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          left = await members();
        }
        return left;
      };
      try {
        expect(pid).toMatch(/^\d+$/);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect((await members()).length).toBeGreaterThanOrEqual(2);

        const started = Date.now();
        await stopBackgroundApp(realExec);
        expect(Date.now() - started).toBeLessThan(15_000);
        // SIGKILL does not wait for the exit to land; give the kernel a moment.
        expect(await settle()).toEqual([]);
      } finally {
        // Whatever the assertions did, leave no stubborn group or script behind.
        const left = await members();
        if (left.length > 0) await realExec(["sh", "-c", `kill -s KILL ${left.join(" ")} 2>/dev/null; true`]);
        await realExec(["rm", "-f", script, APP_PID_PATH]);
      }
    },
    30_000,
  );
});
