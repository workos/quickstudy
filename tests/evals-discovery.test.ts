import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverEvals, importEvalScorer } from "../src/evals/discovery.ts";
import { EvalLoadError } from "../src/evals/prompt.ts";

const FIXTURE_ROOT = join(import.meta.dir, "__fixtures__", "evals");

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "qs-evals-"));
}

function writeEval(
  root: string,
  dirname: string,
  opts: { id?: string; frontmatter?: string; body?: string; evalTs?: string | false; local?: boolean } = {},
): string {
  const dir = join(root, dirname);
  mkdirSync(dir, { recursive: true });
  const frontmatter = opts.frontmatter ?? `---\nid: ${opts.id ?? dirname}\nsuite: benchmark\n---\n`;
  writeFileSync(join(dir, "PROMPT.md"), `${frontmatter}\n${opts.body ?? "Do the task.\n"}`);
  if (opts.evalTs !== false) {
    writeFileSync(join(dir, "EVAL.ts"), opts.evalTs ?? `export default async () => ({ passed: true, checks: [] });\n`);
  }
  if (opts.local) {
    mkdirSync(join(dir, "local"), { recursive: true });
    writeFileSync(join(dir, "local", "seed.txt"), "seed\n");
  }
  return dir;
}

function variantFrontmatter(id: string, frameworks: string[], local?: string): string {
  const list = frameworks.map((fw) => `  - ${fw}`).join("\n");
  return `---\nid: ${id}\nsuite: benchmark\nframeworks:\n${list}\n${local !== undefined ? `local: ${local}\n` : ""}---\n`;
}

describe("eval discovery", () => {
  test("discovers the committed fixtures, sorted by id", () => {
    const evals = discoverEvals(FIXTURE_ROOT);
    expect(evals.map((e) => e.metadata.id)).toEqual([
      "hello-local",
      "multi-fw-alpha",
      "multi-fw-beta",
      "multi-shared-alpha",
      "multi-shared-beta",
      "treatment-fixture",
    ]);
    const hello = evals[0]!;
    expect(hello.metadata.suite).toBe("benchmark");
    expect(hello.metadata.topics).toEqual(["smoke"]);
    expect(hello.promptBody).toContain("NOTES.md");
    expect(hello.scorerPath.endsWith("EVAL.ts")).toBe(true);
    expect(hello.localDir).not.toBeNull();

    const multiFwAlpha = evals[1]!;
    expect(multiFwAlpha.metadata.framework).toBe("alpha");
    expect(multiFwAlpha.localDir).toBe(join(FIXTURE_ROOT, "multi-fw", "local", "alpha"));
    expect(multiFwAlpha.promptBody).toBe(evals[2]!.promptBody);
    const multiSharedBeta = evals[4]!;
    expect(multiSharedBeta.metadata.framework).toBe("beta");
    expect(multiSharedBeta.localDir).toBe(join(FIXTURE_ROOT, "shared-fixtures", "beta"));
  });

  test("an eval without local/ is valid (tools-only evals) — localDir is null", () => {
    const root = makeRoot();
    writeEval(root, "no-local");
    const evals = discoverEvals(root);
    expect(evals[0]?.localDir).toBeNull();
  });

  test("duplicate ids across two directories fail fast, naming both paths", () => {
    const root = makeRoot();
    writeEval(root, "aaa", { id: "aaa" });
    writeEval(root, "bbb", { id: "aaa" });
    expect(() => discoverEvals(root)).toThrow(/duplicate eval id "aaa"/);
    try {
      discoverEvals(root);
    } catch (err) {
      expect((err as Error).message).toContain(join(root, "aaa", "PROMPT.md"));
      expect((err as Error).message).toContain(join(root, "bbb", "PROMPT.md"));
    }
  });

  test("frontmatter id must equal the directory name", () => {
    const root = makeRoot();
    writeEval(root, "real-name", { id: "alias" });
    expect(() => discoverEvals(root)).toThrow(/id "alias" must equal the directory name "real-name"/);
  });

  test("missing EVAL.ts is a discovery error naming the eval", () => {
    const root = makeRoot();
    writeEval(root, "no-scorer", { evalTs: false });
    expect(() => discoverEvals(root)).toThrow(/no EVAL\.ts/);
  });

  test("malformed frontmatter fails with file and line", () => {
    const root = makeRoot();
    writeEval(root, "no-fence", { frontmatter: "id: no-fence\n" });
    expect(() => discoverEvals(root)).toThrow(EvalLoadError);
    expect(() => discoverEvals(root)).toThrow(/expected YAML frontmatter opening "---"/);
  });

  test("unknown frontmatter keys are rejected — new metadata needs a use case first", () => {
    const root = makeRoot();
    writeEval(root, "extra-key", { frontmatter: "---\nid: extra-key\nsuite: benchmark\npriority: 9\n---\n" });
    expect(() => discoverEvals(root)).toThrow(/unknown frontmatter key "priority"/);
  });

  test("suite outside the closed set is rejected", () => {
    const root = makeRoot();
    writeEval(root, "bad-suite", { frontmatter: "---\nid: bad-suite\nsuite: production\n---\n" });
    expect(() => discoverEvals(root)).toThrow(/"suite" must be one of: benchmark, regression, other/);
  });

  test("an empty task body is rejected", () => {
    const root = makeRoot();
    writeEval(root, "empty-body", { body: "   \n" });
    expect(() => discoverEvals(root)).toThrow(/no task body/);
  });

  test("a frameworks list expands one directory into one eval per framework, sorted by id", () => {
    const root = makeRoot();
    // Listed beta-first to prove output order comes from the id sort.
    const dir = writeEval(root, "multi", { frontmatter: variantFrontmatter("multi", ["beta", "alpha"]) });
    mkdirSync(join(dir, "local", "alpha"), { recursive: true });
    mkdirSync(join(dir, "local", "beta"), { recursive: true });
    const evals = discoverEvals(root);
    expect(evals.map((e) => e.metadata.id)).toEqual(["multi-alpha", "multi-beta"]);
    expect(evals.map((e) => e.metadata.framework)).toEqual(["alpha", "beta"]);
    expect(evals[0]!.promptBody).toBe(evals[1]!.promptBody);
    expect(evals[0]!.scorerPath).toBe(join(dir, "EVAL.ts"));
    expect(evals[0]!.localDir).toBe(join(dir, "local", "alpha"));
    expect(evals[1]!.localDir).toBe(join(dir, "local", "beta"));
  });

  test("both forms coexist in one root", () => {
    const root = makeRoot();
    writeEval(root, "plain");
    const dir = writeEval(root, "variant", { frontmatter: variantFrontmatter("variant", ["x"]) });
    mkdirSync(join(dir, "local", "x"), { recursive: true });
    const evals = discoverEvals(root);
    expect(evals.map((e) => e.metadata.id)).toEqual(["plain", "variant-x"]);
    expect(evals[0]!.metadata.framework).toBeUndefined();
  });

  test("single-directory form is unchanged — no new keys required, metadata untouched", () => {
    const root = makeRoot();
    const dir = writeEval(root, "plain", { local: true });
    const evals = discoverEvals(root);
    expect(evals).toHaveLength(1);
    const plain = evals[0]!;
    // Pinned exactly: expansion must not leak any new key onto plain metadata.
    expect(plain.metadata).toEqual({ id: "plain", suite: "benchmark" });
    expect(plain.dir).toBe(dir);
    expect(plain.localDir).toBe(join(dir, "local"));
  });

  test("local: resolves relative to the eval directory, per framework", () => {
    const root = makeRoot();
    mkdirSync(join(root, "shared", "alpha"), { recursive: true });
    mkdirSync(join(root, "shared", "beta"), { recursive: true });
    writeEval(root, "multi", { frontmatter: variantFrontmatter("multi", ["alpha", "beta"], "../shared") });
    const evals = discoverEvals(root);
    expect(evals[0]!.localDir).toBe(join(root, "shared", "alpha"));
    expect(evals[1]!.localDir).toBe(join(root, "shared", "beta"));
  });

  test("an expanded id colliding with a literal directory fails, naming both paths", () => {
    const root = makeRoot();
    const dir = writeEval(root, "multi", { frontmatter: variantFrontmatter("multi", ["alpha"]) });
    mkdirSync(join(dir, "local", "alpha"), { recursive: true });
    writeEval(root, "multi-alpha");
    expect(() => discoverEvals(root)).toThrow(/duplicate eval id "multi-alpha"/);
    try {
      discoverEvals(root);
    } catch (err) {
      expect((err as Error).message).toContain(join(root, "multi", "PROMPT.md"));
      expect((err as Error).message).toContain(join(root, "multi-alpha", "PROMPT.md"));
    }
  });

  test("a listed framework without its starting-state directory is a validation error", () => {
    const root = makeRoot();
    const dir = writeEval(root, "multi", { frontmatter: variantFrontmatter("multi", ["alpha", "beta"]) });
    mkdirSync(join(dir, "local", "alpha"), { recursive: true });
    expect(() => discoverEvals(root)).toThrow(
      new RegExp(`lists framework "beta" but has no starting state for it \\(expected ${join(dir, "local", "beta")}\\)`),
    );
  });

  test("a variant eval with no starting state at all is valid — every variant starts empty", () => {
    const root = makeRoot();
    writeEval(root, "multi", { frontmatter: variantFrontmatter("multi", ["alpha", "beta"]) });
    const evals = discoverEvals(root);
    expect(evals.map((e) => e.localDir)).toEqual([null, null]);
  });

  test("a declared local: path that is not a directory is a validation error", () => {
    const root = makeRoot();
    writeEval(root, "multi", { frontmatter: variantFrontmatter("multi", ["alpha"], "../missing") });
    expect(() => discoverEvals(root)).toThrow(/"local" path "\.\.\/missing" resolves to .* which is not a directory/);
  });

  test("local: may not escape the evals root's parent", () => {
    const root = makeRoot();
    writeEval(root, "multi", {
      frontmatter: variantFrontmatter("multi", ["alpha"], "../../../../../../../../escape-fixtures"),
    });
    expect(() => discoverEvals(root)).toThrow(/outside the evals root's parent/);
  });

  test("absolute local: paths are rejected at parse time", () => {
    const root = makeRoot();
    writeEval(root, "multi", { frontmatter: variantFrontmatter("multi", ["alpha"], "/etc/fixtures") });
    expect(() => discoverEvals(root)).toThrow(/"local" must be a relative path/);
  });

  test("local: without frameworks is rejected — single evals use the local/ directory", () => {
    const root = makeRoot();
    writeEval(root, "single", { frontmatter: `---\nid: single\nsuite: benchmark\nlocal: ../shared\n---\n` });
    expect(() => discoverEvals(root)).toThrow(/"local" requires "frameworks"/);
  });

  test("framework: alongside frameworks: is rejected — expansion owns the key", () => {
    const root = makeRoot();
    writeEval(root, "multi", {
      frontmatter: `---\nid: multi\nsuite: benchmark\nframework: alpha\nframeworks:\n  - alpha\n---\n`,
    });
    expect(() => discoverEvals(root)).toThrow(/"framework" cannot be set alongside "frameworks"/);
  });

  test("an empty frameworks list is rejected", () => {
    const root = makeRoot();
    writeEval(root, "multi", { frontmatter: `---\nid: multi\nsuite: benchmark\nframeworks: []\n---\n` });
    expect(() => discoverEvals(root)).toThrow(/"frameworks" must be a non-empty list/);
  });

  test("duplicate frameworks entries are rejected", () => {
    const root = makeRoot();
    writeEval(root, "multi", { frontmatter: variantFrontmatter("multi", ["alpha", "alpha"]) });
    expect(() => discoverEvals(root)).toThrow(/"frameworks" entries must be unique/);
  });

  test("non-kebab frameworks tokens are rejected", () => {
    const root = makeRoot();
    writeEval(root, "multi", { frontmatter: variantFrontmatter("multi", ["Not_Kebab"]) });
    expect(() => discoverEvals(root)).toThrow(/must be a kebab-case token/);
  });

  test("a variant eval's frontmatter id must still equal its directory name", () => {
    const root = makeRoot();
    writeEval(root, "real-name", { frontmatter: variantFrontmatter("alias", ["x"]) });
    expect(() => discoverEvals(root)).toThrow(/expanded eval id "alias-x" must equal "<dirname>-<framework>" \("real-name-x"\)/);
  });

  test("importEvalScorer validates the default export is a function", async () => {
    const root = makeRoot();
    const good = writeEval(root, "good");
    const bad = writeEval(root, "bad", { evalTs: `export default { not: "a function" };\n` });
    expect(typeof (await importEvalScorer(join(good, "EVAL.ts")))).toBe("function");
    expect(importEvalScorer(join(bad, "EVAL.ts"))).rejects.toThrow(/must default-export an async scorer function/);
  });
});
