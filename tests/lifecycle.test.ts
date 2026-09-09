import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverEvals } from "../src/evals/discovery.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { ResultsStore } from "../src/store/db.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { createAttemptContainer, dockerDaemonReachable, imageExists } from "../src/isolation/docker.ts";
const enabled = (await dockerDaemonReachable()) && (await imageExists("alpine:3"));
if (!enabled && process.env.QUICKSTUDY_REQUIRE_DOCKER === "1") throw new Error("lifecycle Docker gate unavailable");
const dockerTest = enabled ? test : test.skip;
dockerTest("hung provision and cleanup are bounded and accounted without agent work", async () => {
  const root = mkdtempSync(join(tmpdir(), "qs-lifecycle-"));
  const dir = join(root, "evals/test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PROMPT.md"), "---\nid: test\nsuite: benchmark\n---\nDo something");
  writeFileSync(join(dir, "EVAL.ts"), "export default async () => ({passed:true,checks:[]});");
  const path = join(root, "experiment.ts");
  writeFileSync(path, "export default {};");
  const store = new ResultsStore(join(root, "results.db"));
  let aborted = false;
  let cleanup = 0;
  const runtime = {
    kind: "container" as const,
    image: "alpine:3",
    command: ["false"],
    provision: async (ctx: { signal?: AbortSignal }) => {
      ctx.signal!.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<never>(() => {});
    },
    teardown: async () => {
      cleanup++;
      return new Promise<void>(() => {});
    },
  };
  try {
    const run = await executeRunV3({
      evals: discoverEvals(join(root, "evals")),
      experiments: [{ path, experiment: { id: "hung", agent: { adapter: "scripted" }, runtime } }],
      plan: [{ evalId: "test", experimentId: "hung", trialIndex: 0 }],
      store,
      artifacts: new ArtifactsStore(join(root, "results")),
      budgets: { provisionMs: 20, cleanupMs: 20 },
      log: () => {},
    });
    expect(run.errors).toBe(1);
    expect(aborted).toBe(true);
    expect(cleanup).toBe(1);
    const row = store.listAttempts(run.runId)[0]!;
    expect(row.error).toContain("provision timed out");
    expect(row.error).toContain("cleanup timed out");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
dockerTest("a timed-out Docker exec cannot leave a delayed child writing evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "qs-child-kill-"));
  const fixtureDir = join(root, "fixture");
  mkdirSync(fixtureDir);
  const container = await createAttemptContainer({
    image: "alpine:3",
    env: {},
    attemptId: `child-${Date.now()}`,
    fixtureDir,
    resultsDir: root,
  });
  try {
    const result = await container.execInWorkspace(["sh", "-c", "(sleep 0.3; echo late > /results/late.txt) & wait"], {
      timeoutMs: 30,
    });
    expect(result.timedOut).toBe(true);
    await Bun.sleep(500);
    expect(existsSync(join(root, "late.txt"))).toBe(false);
  } finally {
    await container.teardown();
    rmSync(root, { recursive: true, force: true });
  }
});
dockerTest("workspace transfer excludes bulk before copying and preserves safe source links", async () => {
  const root = mkdtempSync(join(tmpdir(), "qs-transfer-"));
  const fixtureDir = join(root, "fixture");
  mkdirSync(fixtureDir);
  const container = await createAttemptContainer({
    image: "alpine:3",
    env: {},
    attemptId: `transfer-${Date.now()}`,
    fixtureDir,
    resultsDir: root,
  });
  try {
    await container.execInWorkspace([
      "sh",
      "-c",
      "mkdir -p nested/node_modules .next; dd if=/dev/zero of=nested/node_modules/bulk bs=1048576 count=16 2>/dev/null; echo source > 'file with spaces.txt'; echo new > nested/new.ts; ln -s 'file with spaces.txt' safe-link; ln -s /etc/passwd outside-link; echo private > .env",
    ]);
    const before = await container.execInWorkspace(["sh", "-c", "tar -cf - . | wc -c"]);
    const after = await container.execInWorkspace([
      "sh",
      "-c",
      "tar --exclude=node_modules --exclude=.next --exclude=.env -cf - . | wc -c",
    ]);
    const start = performance.now();
    const output = join(root, "export");
    await container.exportWorkspace(output);
    console.log(
      JSON.stringify({
        workload: "16 MiB nested dependency",
        unfilteredArchiveBytes: Number(before.stdout),
        filteredArchiveBytes: Number(after.stdout),
        exportMs: Math.round(performance.now() - start),
      }),
    );
    expect(Number(after.stdout)).toBeLessThan(Number(before.stdout) / 100);
    expect(existsSync(join(output, "nested/node_modules"))).toBe(false);
    expect(existsSync(join(output, ".next"))).toBe(false);
    expect(existsSync(join(output, ".env"))).toBe(false);
    expect(existsSync(join(output, "file with spaces.txt"))).toBe(true);
    expect(existsSync(join(output, "nested/new.ts"))).toBe(true);
    expect(existsSync(join(output, "safe-link"))).toBe(true);
    expect(existsSync(join(output, "outside-link"))).toBe(false);
  } finally {
    await container.teardown();
    rmSync(root, { recursive: true, force: true });
  }
});
