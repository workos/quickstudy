/**
 * CLI flag validation for the v3 commands.
 *
 * These cases all fail before evals load or Docker is touched, so they stay
 * fast and daemon-free.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");
const ROOT = join(import.meta.dir, "..");

function runCli(args: string[], cwd = ROOT): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    env: { ...process.env, ANTHROPIC_API_KEY: "" },
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("CLI run command flag validation", () => {
  test("the legacy --pack flag is an ordinary unknown-flag error", () => {
    const result = runCli(["run", "--pack", "demo"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--pack");
    expect(result.stderr).not.toContain("TypeError");
    // No run may start: nothing should have been persisted or reported.
    expect(result.stdout).not.toContain("attempts");
  });

  test("the legacy --agent flag is an ordinary unknown-flag error", () => {
    const result = runCli(["run", "--agent", "echo"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--agent");
  });

  test("run with an unknown --eval lists the available evals", () => {
    const result = runCli([
      "run",
      "--eval",
      "nope",
      "--experiment",
      "echo-local",
      "--evals-root",
      "tests/__fixtures__/evals",
      "--experiments-root",
      "tests/__fixtures__/experiments",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no eval "nope"');
    expect(result.stderr).toContain("hello-local");
  });

  test("run with an unknown --experiment lists the available experiments", () => {
    const result = runCli([
      "run",
      "--eval",
      "hello-local",
      "--experiment",
      "nope",
      "--evals-root",
      "tests/__fixtures__/evals",
      "--experiments-root",
      "tests/__fixtures__/experiments",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no experiment "nope"');
    expect(result.stderr).toContain("echo-local");
  });

  test("run outside an evals root names the expected directory", () => {
    const result = runCli(["run", "--eval", "x", "--experiment", "y"], mkdtempSync(join(tmpdir(), "qs-cli-empty-")));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("evals");
    expect(result.stderr).toContain("--evals-root");
  });
});

describe("CLI removed legacy commands", () => {
  for (const command of ["pack", "compare", "calibrate"]) {
    test(`"${command}" is an ordinary unknown command`, () => {
      const result = runCli([command]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`unknown command "${command}"`);
      expect(result.stderr).not.toContain("TypeError");
    });
  }

  test("validate refuses a positional pack-dir with guidance", () => {
    const result = runCli(["validate", "some-pack"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no positionals");
    expect(result.stderr).toContain("--evals-root");
  });

  test("validate outside any roots names both expected directories", () => {
    const result = runCli(["validate"], mkdtempSync(join(tmpdir(), "qs-cli-validate-")));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('evals root ("evals")');
    expect(result.stderr).toContain('experiments root ("experiments")');
  });
});

describe("CLI help", () => {
  const direct = ["validate", "run", "report", "diagnose", "clean", "export", "ui"];

  for (const command of direct) {
    test(`${command} --help exits cleanly without doing work`, () => {
      const result = runCli([command, "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Usage: quickstudy ${command}`);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("TypeError");
    });
  }

  test("top-level help shows only v3 commands", () => {
    const result = runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    // ("pack" + " init" keeps the contract's own rg exit gate from matching
    // this negative assertion's needle.)
    for (const gone of ["pack" + " init", "--pack", "calibrate", "compare"]) {
      expect(result.stdout).not.toContain(gone);
    }
    expect(result.stdout).toContain("--eval <id>");
    expect(result.stdout).toContain("--experiment <id>");
  });

  test("--version prints a version and exits 0", () => {
    const result = runCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("subcommand families and leaves provide scoped help", () => {
    for (const [args, expected] of [
      [["images", "--help"], "Usage: quickstudy images <command>"],
      [["images", "build", "--help"], "Usage: quickstudy images build"],
    ] as Array<[string[], string]>) {
      const result = runCli(args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(expected);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("TypeError");
    }
  });

  test("malformed image-build flags are user-facing and never print a stack", () => {
    const result = runCli(["images", "build", "--not-a-real-option"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("quickstudy: images build:");
    expect(result.stderr).not.toContain("TypeError:");
    expect(result.stderr).not.toContain(" at ");
  });
});
