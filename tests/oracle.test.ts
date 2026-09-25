import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OracleAdapter, OracleContainerAdapter } from "../src/adapters/oracle.ts";
import { discoverEvals } from "../src/evals/discovery.ts";
import { discoverExperiments } from "../src/experiments/discovery.ts";
import type { LoadedExperiment } from "../src/experiments/types.ts";
import { buildRunManifest } from "../src/manifest.ts";
import { isMovingModelAlias } from "../src/model-identity.ts";
import { planRun } from "../src/plan.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { validateOracle } from "../src/runner/oracle-validate.ts";
import { prepWorkspaceSource } from "../src/runner/workspace-source.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore } from "../src/store/db.ts";
import { requireDockerOrSkip } from "./helpers.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");
const ORACLE = join(FIXTURES, "oracle");
const REPO = join(import.meta.dir, "..");
const silent = (): void => {};

function makeStores(): { store: ResultsStore; artifacts: ArtifactsStore } {
  const root = mkdtempSync(join(tmpdir(), "qs-oracle-"));
  return { store: new ResultsStore(join(root, "results.db")), artifacts: new ArtifactsStore(join(root, "results")) };
}

function writeTmpEval(root: string, id: string, files: Record<string, string>): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PROMPT.md"), `---\nid: ${id}\nsuite: benchmark\n---\n\nDo the ${id} task.\n`);
  writeFileSync(join(dir, "EVAL.ts"), `export default async () => ({ passed: true, checks: [] });\n`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

function validateCli(root: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "src/cli.ts", "validate", "--oracle", "--evals-root", root], { cwd: REPO });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("discovery", () => {
  test("a plain eval's solution/ is discovered", () => {
    const hello = discoverEvals(join(ORACLE, "ready")).find((entry) => entry.metadata.id === "hello-solution")!;
    expect(hello.solutionDir).toBe(join(ORACLE, "ready", "hello-solution", "solution"));
  });

  test("framework-expanded evals get their own solution/<fw>/", () => {
    const evals = discoverEvals(join(ORACLE, "ready"));
    expect(evals.map((entry) => entry.metadata.id)).toEqual(["hello-solution", "multi-solution-alpha", "multi-solution-beta"]);
    for (const fw of ["alpha", "beta"]) {
      const entry = evals.find((e) => e.metadata.id === `multi-solution-${fw}`)!;
      expect(entry.solutionDir).toBe(join(ORACLE, "ready", "multi-solution", "solution", fw));
    }
  });

  test("solution/ missing a listed framework is a load error naming it", () => {
    const root = mkdtempSync(join(tmpdir(), "qs-oracle-disc-"));
    cpSync(join(ORACLE, "ready", "multi-solution"), join(root, "multi-solution"), { recursive: true });
    rmSync(join(root, "multi-solution", "solution", "beta"), { recursive: true });
    expect(() => discoverEvals(root)).toThrow(/has solution\/ but no solution for framework "beta"/);
  });

  test("an eval without solution/ has solutionDir null", () => {
    const hello = discoverEvals(join(FIXTURES, "evals")).find((entry) => entry.metadata.id === "hello-local")!;
    expect(hello.solutionDir).toBeNull();
    for (const entry of discoverEvals(join(FIXTURES, "evals"))) expect(entry.solutionDir).toBeNull();
  });
});

describe("identity", () => {
  test("solution/ is recorded outside components and never changes the eval hash", () => {
    const root = mkdtempSync(join(tmpdir(), "qs-oracle-id-"));
    writeTmpEval(root, "plain", { "local/README.md": "same\n" });
    writeTmpEval(root, "solved", { "local/README.md": "same\n", "solution/NOTES.md": "# Notes\n" });
    const evals = discoverEvals(root);
    const manifest = buildRunManifest({ evals, experiments: [] });
    const plain = manifest.evals["plain"]!;
    const solved = manifest.evals["solved"]!;
    expect(plain.solution).toBeNull();
    expect(solved.solution).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(solved.components)).not.toContain("solution");
    // Identical except for solution/ (and the id-bearing prompt/metadata):
    expect(solved.components.local).toBe(plain.components.local);
    expect(solved.components.scorer).toBe(plain.components.scorer);
  });

  test("editing only solution/ leaves the eval hash unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "qs-oracle-id2-"));
    writeTmpEval(root, "solved", { "local/README.md": "x\n", "solution/NOTES.md": "# Notes v1\n" });
    const before = buildRunManifest({ evals: discoverEvals(root), experiments: [] }).evals["solved"]!;
    writeFileSync(join(root, "solved", "solution", "NOTES.md"), "# Notes v2\n");
    const after = buildRunManifest({ evals: discoverEvals(root), experiments: [] }).evals["solved"]!;
    expect(after.hash).toBe(before.hash);
    expect(after.solution).not.toBe(before.solution);
  });
});

describe("overlay", () => {
  test("solution files win over local files; local-only files survive", async () => {
    const root = mkdtempSync(join(tmpdir(), "qs-oracle-overlay-"));
    writeTmpEval(root, "overlay", {
      "local/app.txt": "starter\n",
      "local/keep.txt": "kept\n",
      "solution/app.txt": "solved\n",
      "solution/new/file.txt": "added\n",
    });
    const [loaded] = discoverEvals(root);
    const fixture = await prepWorkspaceSource(loaded!);
    const solved = await prepWorkspaceSource(loaded!, "solution");
    try {
      expect(readFileSync(join(fixture, "app.txt"), "utf8")).toBe("starter\n");
      expect(existsSync(join(fixture, "new"))).toBe(false);
      expect(readFileSync(join(solved, "app.txt"), "utf8")).toBe("solved\n");
      expect(readFileSync(join(solved, "keep.txt"), "utf8")).toBe("kept\n");
      expect(readFileSync(join(solved, "new", "file.txt"), "utf8")).toBe("added\n");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(solved, { recursive: true, force: true });
    }
  });

  test("an eval with solution/ but no local/ starts from the solution alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "qs-oracle-overlay2-"));
    writeTmpEval(root, "bare", { "solution/NOTES.md": "# Notes\n" });
    const [loaded] = discoverEvals(root);
    expect(loaded!.localDir).toBeNull();
    const solved = await prepWorkspaceSource(loaded!, "solution");
    expect(readFileSync(join(solved, "NOTES.md"), "utf8")).toBe("# Notes\n");
    rmSync(solved, { recursive: true, force: true });
  });
});

describe("run", () => {
  test("oracle adapter identity is pinned and not a moving alias", () => {
    expect(isMovingModelAlias(new OracleAdapter().identity.model)).toBe(false);
    expect(new OracleContainerAdapter().parseStream("")).toEqual({ tokensIn: null, tokensOut: null, turns: 0, costUsd: 0 });
  });

  test("the oracle experiment scores every ready eval 1/1 with no model spend", async () => {
    const evals = discoverEvals(join(ORACLE, "ready"));
    const experiments = await discoverExperiments(join(ORACLE, "experiments"));
    expect(experiments.map((entry) => entry.experiment.id)).toEqual(["oracle-local"]);
    const plan = planRun(evals, experiments.map((entry) => entry.experiment), 1);
    const { store, artifacts } = makeStores();
    const summary = await executeRunV3({ evals, experiments, plan, store, artifacts, log: silent });
    expect(summary).toMatchObject({ total: 3, passed: 3, failed: 0, incomplete: 0, errors: 0 });
    for (const attempt of store.listAttempts(summary.runId)) {
      expect(attempt.status).toBe("completed");
      expect(attempt.result?.passed).toBe(true);
      expect(attempt.costUsd).toBe(0);
      expect(attempt.tokensIn).toBeNull();
    }
    const run = store.getRun(summary.runId)!;
    expect(run.manifest.evals["hello-solution"]?.solution).toMatch(/^[0-9a-f]{64}$/);
    // The role the resolved adapter declares is recorded on the run, not in the manifest.
    expect(run.config.roles).toEqual({ "oracle-local": "positive-control" });
    store.close();
  });

  test("the recorded role is the resolved adapter's, never its name's", async () => {
    const evals = discoverEvals(join(ORACLE, "ready"));
    const experiments = await discoverExperiments(join(ORACLE, "experiments"));
    const plan = planRun(evals, experiments.map((entry) => entry.experiment), 1);
    const { store, artifacts } = makeStores();
    const real = new OracleAdapter();
    // A supplied adapter registered under the oracle's name that declares no role.
    const impostor = { name: "oracle", startingState: "solution" as const, runAttempt: real.runAttempt.bind(real) };
    const summary = await executeRunV3({ evals, experiments, plan, store, artifacts, log: silent, hostAdapters: { oracle: impostor } });
    expect(store.getRun(summary.runId)!.config.roles).toEqual({ "oracle-local": "agent" });
    store.close();
  });

  test("preflight refuses an oracle pairing with a solution-less eval before any row", async () => {
    const evals = discoverEvals(join(FIXTURES, "evals")).filter((entry) => entry.metadata.id === "hello-local");
    const experiments = await discoverExperiments(join(ORACLE, "experiments"));
    const plan = planRun(evals, experiments.map((entry) => entry.experiment), 1);
    const { store, artifacts } = makeStores();
    await expect(executeRunV3({ evals, experiments, plan, store, artifacts, log: silent })).rejects.toThrow(
      /the oracle adapter needs solution\/ — add it or drop the eval from the run: oracle-local × hello-local/,
    );
    expect(store.listRuns()).toHaveLength(0);
    store.close();
  });
  test("preflight refuses a container oracle experiment that sets runtime.command", async () => {
    const evals = discoverEvals(join(ORACLE, "ready")).filter((entry) => entry.metadata.id === "hello-solution");
    const dir = mkdtempSync(join(tmpdir(), "qs-oracle-exp-"));
    const path = join(dir, "oracle-scripted.ts");
    writeFileSync(path, "// synthetic module for oracle-scripted\n");
    const experiments: LoadedExperiment[] = [
      {
        experiment: {
          id: "oracle-scripted",
          agent: { adapter: "oracle", provider: "local", model: "oracle-v1", reasoning: "none" },
          runtime: { kind: "container", image: "alpine:3", command: ["true"] },
        },
        path,
      },
    ];
    const plan = planRun(evals, experiments.map((entry) => entry.experiment), 1);
    const { store, artifacts } = makeStores();
    await expect(executeRunV3({ evals, experiments, plan, store, artifacts, log: silent })).rejects.toThrow(
      /selects the oracle adapter but sets runtime\.command/,
    );
    expect(store.listRuns()).toHaveLength(0);
    store.close();
  });
});

describe("validate", () => {
  test("ready: every eval scores 1.0 and exits 0", () => {
    const { exitCode, stdout } = validateCli("tests/__fixtures__/oracle/ready");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("  oracle:");
    expect(stdout.match(/: 1\.0$/gm)).toHaveLength(3);
    expect(stdout).toContain("hello-solution (suite: benchmark; local/; solution/)");
  });

  test("broken: a failing graded check exits 1 and names the check", () => {
    const { exitCode, stdout, stderr } = validateCli("tests/__fixtures__/oracle/broken");
    expect(exitCode).toBe(1);
    expect(stdout).toContain("hello-broken: FAILED (notes-written)");
    expect(stderr).toContain("1 eval(s) FAILED");
  });

  test("deferred: a scorer that calls exec (and swallows the error) is deferred, exit 0", () => {
    const { exitCode, stdout } = validateCli("tests/__fixtures__/oracle/deferred");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("exec-needed: deferred (scorer needs exec");
  });

  test("no solutions: every eval is MISSING and exits 1", () => {
    const { exitCode, stdout } = validateCli("tests/__fixtures__/evals");
    expect(exitCode).toBe(1);
    expect(stdout.match(/MISSING \(no solution\/\)/g)).toHaveLength(6);
  });

  test("a scorer that swallows a runtime-only error and returns passing checks is deferred, not 1.0", async () => {
    const root = mkdtempSync(join(tmpdir(), "qs-oracle-swallow-"));
    writeTmpEval(root, "swallow", { "solution/NOTES.md": "# Notes\n" });
    writeFileSync(
      join(root, "swallow", "EVAL.ts"),
      `export default async (ctx) => { try { await ctx.exec(["true"]); } catch {} return { passed: true, checks: [{ name: "ok", passed: true }] }; };\n`,
    );
    const [loaded] = discoverEvals(root);
    expect(await validateOracle(loaded!)).toEqual({ kind: "deferred", capabilities: ["exec"] });
  });

  test("a scorer that touches a runtime-only capability and then hangs fails, not deferred", async () => {
    const root = mkdtempSync(join(tmpdir(), "qs-oracle-hang-exec-"));
    writeTmpEval(root, "hang-exec", { "solution/NOTES.md": "# Notes\n" });
    writeFileSync(
      join(root, "hang-exec", "EVAL.ts"),
      `export default async (ctx) => { try { await ctx.exec(["true"]); } catch {} return new Promise(() => {}); };\n`,
    );
    const [loaded] = discoverEvals(root);
    const outcome = await validateOracle(loaded!, { timeoutMs: 200 });
    expect(outcome).toMatchObject({ kind: "failed", error: expect.stringContaining("scoring timed out") });
  });

  test("a hanging scorer fails with a scoring timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "qs-oracle-hang-"));
    writeTmpEval(root, "hang", { "solution/NOTES.md": "# Notes\n" });
    writeFileSync(join(root, "hang", "EVAL.ts"), `export default () => new Promise(() => {});\n`);
    const [loaded] = discoverEvals(root);
    const outcome = await validateOracle(loaded!, { timeoutMs: 200 });
    expect(outcome).toMatchObject({ kind: "failed", error: expect.stringContaining("scoring timed out") });
  });
});

const describeDocker = await requireDockerOrSkip(["alpine:3"], "oracle container test");

describeDocker("run (container)", () => {
  test("a container oracle experiment scores hello-solution 1/1", async () => {
    const evals = discoverEvals(join(ORACLE, "ready")).filter((entry) => entry.metadata.id === "hello-solution");
    const dir = mkdtempSync(join(tmpdir(), "qs-oracle-exp-"));
    const path = join(dir, "oracle-container.ts");
    writeFileSync(path, "// synthetic module for oracle-container\n");
    const experiments: LoadedExperiment[] = [
      {
        experiment: {
          id: "oracle-container",
          agent: { adapter: "oracle", provider: "local", model: "oracle-v1", reasoning: "none" },
          runtime: { kind: "container", image: "alpine:3" },
        },
        path,
      },
    ];
    const plan = planRun(evals, experiments.map((entry) => entry.experiment), 1);
    const { store, artifacts } = makeStores();
    const summary = await executeRunV3({ evals, experiments, plan, store, artifacts, log: silent });
    expect(summary).toMatchObject({ total: 1, passed: 1, errors: 0 });
    store.close();
  }, 120_000);
});
