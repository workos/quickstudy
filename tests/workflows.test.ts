import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// The weekly-sweep publication-workflow guard moved with its subject
// (examples/weekly-sweep.yml) to the consumer benchmark repo.

describe("release workflow contracts", () => {
  test("manual tagged releases check out and attest the exact tag before building", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
    const checkout = workflow.indexOf("uses: actions/checkout@v4");
    const verify = workflow.indexOf("- name: Verify checked-out source");
    const build = workflow.indexOf("- name: Build standalone executable");

    expect(checkout).toBeGreaterThan(0);
    expect(workflow).toContain("inputs.release_tag || github.sha");
    expect(workflow).toContain('expected="$(git rev-list -n 1 "refs/tags/$REQUESTED_TAG")"');
    expect(workflow).toContain('if [ "$actual" != "$expected" ]');
    expect(checkout).toBeLessThan(verify);
    expect(verify).toBeLessThan(build);
    expect(workflow).toContain("SOURCE.txt");
    expect(workflow).toContain("quickstudy LICENSE README.txt SOURCE.txt");
  });

  test("every repo file release.yml copies into an archive exists", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
    const copied = [...workflow.matchAll(/cp\s+((?:\.|[A-Za-z])[^\s"]*)/g)].map((m) => m[1] as string);
    expect(copied.length).toBeGreaterThan(0);
    for (const path of copied) {
      if (path.startsWith("dist/")) continue;
      expect({ path, exists: existsSync(join(root, path)) }).toEqual({ path, exists: true });
    }
  });
});
