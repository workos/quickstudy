import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The `./ui/viewers` package export: a host that renders exported bundles in its own UI
// imports the transcript and diff viewers instead of copying them. Two things must hold
// for that to work from the published tarball: the barrel resolves and exposes the
// components, and every file an `exports` subpath points at is inside `files`.

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, string>;
  files: string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

describe("ui/viewers export", () => {
  test("the barrel exposes both viewers and the transcript parser", async () => {
    // A non-literal specifier: the harness tsconfig has no --jsx, so it must not resolve the
    // TSX behind the barrel; `tsc -p ui` types the barrel itself.
    const barrel: string = "../ui/src/viewers.ts";
    const viewers = (await import(barrel)) as Record<string, unknown>;
    expect(typeof viewers.TranscriptViewer).toBe("function");
    expect(typeof viewers.DiffViewer).toBe("function");
    expect(typeof viewers.parseTranscript).toBe("function");
    expect(typeof viewers.parseTurn).toBe("function");
  });

  test("every exports target ships in the tarball", () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const relative = target.replace(/^\.\//, "");
      if (relative === "package.json") continue; // npm always packs it
      expect(existsSync(join(root, relative))).toBe(true);
      const shipped = pkg.files.some(
        (entry) => relative === entry || relative.startsWith(`${entry}/`),
      );
      expect(shipped, `${subpath} → ${target} is not covered by package.json "files"`).toBe(true);
    }
    expect(pkg.exports["./ui/viewers"]).toBe("./ui/src/viewers.ts");
    expect(pkg.exports["./ui/viewers.css"]).toBe("./ui/src/components/viewers.css");
  });

  test("React is an optional peer: the CLI never needs it, a host embedding the viewers does", () => {
    expect(pkg.peerDependencies?.react).toBeDefined();
    expect(pkg.peerDependenciesMeta?.react?.optional).toBe(true);
  });

  test("the app stylesheet still carries the viewer styles, through the shared file", () => {
    const styles = readFileSync(join(root, "ui/src/styles.css"), "utf8");
    expect(styles).toContain('@import "./components/viewers.css";');
    const viewers = readFileSync(join(root, "ui/src/components/viewers.css"), "utf8");
    for (const selector of [".turn-head", ".role-assistant", ".viewer-note", ".diff-add", ".diff-line.highlight"]) {
      expect(viewers).toContain(selector);
      expect(styles).not.toContain(`\n${selector} {`);
    }
  });
});
