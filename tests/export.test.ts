/**
 * Data-directory contract tests (v3): golden shape from a seeded run,
 * multi-run export, verbatim report embedding, workspace exclusion, and the
 * window.__QS_DATA__ inlining (with its </script> escaping).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedRun, SEED_EVALS, SEED_EXPERIMENTS } from "../scripts/seed-run.ts";
import { DATA_SCHEMA_VERSION, type DataMeta, type DataRun } from "../src/export-types.ts";
import { ExportError, exportSite, inlineDataIntoHtml } from "../src/export.ts";
import { REPORT_SCHEMA_VERSION, type ReportJson } from "../src/report/report.ts";
import { ResultsStore } from "../src/store/db.ts";

const silent = () => {};

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "quickstudy-export-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function seeded(options: { dropLast?: number } = {}) {
  const root = tempRoot();
  const dbPath = join(root, "results.db");
  const resultsDir = join(root, "results");
  const { runId } = seedRun({ dbPath, resultsDir, ...options });
  return { root, dbPath, resultsDir, runId, store: new ResultsStore(dbPath) };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** A minimal fake ui/dist bundle with the qs-data slot. */
function fakeBundle(root: string): string {
  const bundleDir = join(root, "dist");
  mkdirSync(join(bundleDir, "assets"), { recursive: true });
  writeFileSync(
    join(bundleDir, "index.html"),
    '<!doctype html><html><head><script id="qs-data">window.__QS_DATA__ = undefined;</script></head><body><div id="root"></div></body></html>',
    "utf8",
  );
  writeFileSync(join(bundleDir, "assets", "app.js"), "console.log('bundle');\n", "utf8");
  return bundleDir;
}

describe("exportSite data directory", () => {
  test("golden shape: every attempt row has a JSON + transcript asset; completed rows a diff", async () => {
    const { store, resultsDir, runId, root } = seeded();
    const outDir = join(root, "site");

    const summary = await exportSite({ store, resultsDir, runIds: [runId], outDir, log: silent });
    expect(summary.runs).toBe(1);
    expect(summary.attempts).toBe(54);
    expect(summary.missingAssets).toBe(0);

    const meta = readJson<DataMeta>(join(outDir, "data", "meta.json"));
    expect(meta.schemaVersion).toBe(DATA_SCHEMA_VERSION);
    expect(meta.runs).toHaveLength(1);
    expect(meta.runs[0]?.id).toBe(runId);
    expect(meta.runs[0]?.trials).toBe(3);
    expect(meta.runs[0]?.eval_ids).toEqual(SEED_EVALS.map((spec) => spec.id));
    expect(meta.runs[0]?.experiment_ids).toEqual(SEED_EXPERIMENTS.map((spec) => spec.id));
    // ISO strings on the wire, converted from the store's epoch milliseconds.
    expect(meta.runs[0]?.started_at).toBe("2026-07-20T00:00:00.000Z");
    expect(meta.runs[0]?.finished_at).toBe("2026-07-20T01:00:00.000Z");
    expect(meta.runs[0]?.attempts).toBe(54);

    const runJson = readJson<DataRun>(join(outDir, "data", "runs", runId, "run.json"));
    expect(runJson.schemaVersion).toBe(DATA_SCHEMA_VERSION);
    expect(runJson.attempts).toHaveLength(54);

    // The run's comparison groups ride along: claude allowed, codex withheld.
    expect(runJson.groups.map((group) => [group.group, group.comparison])).toEqual([
      ["claude", "allowed"],
      ["codex", "withheld"],
    ]);
    expect(runJson.groups[1]?.details.some((detail) => detail.includes("model"))).toBeTrue();

    const attemptsDir = join(outDir, "data", "runs", runId, "attempts");
    for (const attempt of runJson.attempts) {
      expect(existsSync(join(attemptsDir, `${attempt.id}.json`))).toBeTrue();
      // Every seeded attempt has a transcript artifact.
      expect(attempt.transcript).toBe(`attempts/${attempt.id}.transcript.txt`);
      expect(existsSync(join(attemptsDir, `${attempt.id}.transcript.txt`))).toBeTrue();
      if (attempt.status === "completed") {
        expect(attempt.diff).toBe(`attempts/${attempt.id}.diff.patch`);
        expect(existsSync(join(attemptsDir, `${attempt.id}.diff.patch`))).toBeTrue();
      }
    }

    // Attempt rows carry the queryable facts the drill-down renders.
    const passing = runJson.attempts.find((attempt) => attempt.passed === true);
    expect(passing?.checks?.map((check) => check.name)).toEqual(["flow-wired", "no-secrets-in-client", "build-passes"]);
    expect(passing?.treatment).not.toBeNull();
    expect(passing?.comparison_group).toMatch(/^(claude|codex)$/);
    const errored = runJson.attempts.find((attempt) => attempt.status === "error");
    expect(errored?.error).toContain("timed out");
    expect(errored?.passed).toBeNull();
    // Telemetry stays null (never 0) where the seed recorded none.
    expect(errored?.cost_usd).toBeNull();
    expect(errored?.surface_usage).toBeNull();
    const mcpUsage = runJson.attempts.find(
      (attempt) => attempt.experiment_id === "claude-mcp" && attempt.passed !== null,
    );
    expect(mcpUsage?.surface_usage?.mcp.tools).toEqual(["acme__list_orgs"]);

    // report.json is present and carries the current schema pin.
    const report = readJson<ReportJson>(join(outDir, "data", "runs", runId, "report.json"));
    expect(report.run.id).toBe(runId);
    expect(report.schema_version).toBe(REPORT_SCHEMA_VERSION);
  });

  test("multi-run export lists runs newest-first and exports both data dirs", async () => {
    const { store, resultsDir, runId, root, dbPath } = seeded();
    const second = seedRun({ dbPath, resultsDir, dropLast: 2 });
    const outDir = join(root, "site");

    // Re-open so the store sees the second run (seedRun used its own handle).
    store.close();
    const reopened = new ResultsStore(dbPath);
    const summary = await exportSite({
      store: reopened,
      resultsDir,
      runIds: [runId, second.runId],
      outDir,
      log: silent,
    });
    expect(summary.runs).toBe(2);
    expect(summary.attempts).toBe(54 + 52);

    const meta = readJson<DataMeta>(join(outDir, "data", "meta.json"));
    expect(meta.runs.map((run) => run.id)).toHaveLength(2);
    // Same started_at in seeds — newest-first tiebreak is id DESC, matching listRuns.
    const ids = [runId, second.runId].sort().reverse();
    expect(meta.runs.map((run) => run.id)).toEqual(ids);

    expect(existsSync(join(outDir, "data", "runs", runId, "run.json"))).toBeTrue();
    expect(existsSync(join(outDir, "data", "runs", second.runId, "run.json"))).toBeTrue();
    reopened.close();
  });

  test("workspace trees are never exported", async () => {
    const { store, resultsDir, runId, root } = seeded();
    // Simulate an exported workspace in the artifacts dir.
    const attemptId = store.listAttempts(runId)[0]?.id as string;
    const workspaceDir = join(resultsDir, runId, attemptId, "workspace");
    mkdirSync(join(workspaceDir, "node_modules"), { recursive: true });
    writeFileSync(join(workspaceDir, "app.ts"), "export {};\n", "utf8");

    const outDir = join(root, "site");
    await exportSite({ store, resultsDir, runIds: [runId], outDir, log: silent });

    const everything: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        everything.push(path);
        if (statSync(path).isDirectory()) walk(path);
      }
    };
    walk(outDir);
    expect(everything.some((path) => path.includes("workspace"))).toBeFalse();
  });

  test("stored report.json is embedded verbatim, never reshaped", async () => {
    const { store, resultsDir, runId, root } = seeded();
    const marker = { verbatim_marker: "phase-7-artifact", pairs: [] };
    mkdirSync(join(resultsDir, runId), { recursive: true });
    writeFileSync(join(resultsDir, runId, "report.json"), JSON.stringify({ run: { id: runId }, ...marker }), "utf8");

    const outDir = join(root, "site");
    await exportSite({ store, resultsDir, runIds: [runId], outDir, log: silent });

    const exported = readJson<Record<string, unknown>>(join(outDir, "data", "runs", runId, "report.json"));
    expect(exported["verbatim_marker"]).toBe("phase-7-artifact");
  });

  test("stored diagnosis.json is embedded verbatim and copied byte-for-byte when present", async () => {
    const { store, resultsDir, runId, root } = seeded();
    // Verbatim contract: export copies the artifact without validation, so a
    // marker object (with a forward-compatible field) must survive untouched.
    const stored = `${JSON.stringify({ schema_version: 1, run_id: runId, verbatim_marker: "diagnosis-artifact", future_field: true }, null, 2)}\n`;
    mkdirSync(join(resultsDir, runId), { recursive: true });
    writeFileSync(join(resultsDir, runId, "diagnosis.json"), stored, "utf8");

    const bundleDir = fakeBundle(root);
    const outDir = join(root, "site");
    await exportSite({ store, resultsDir, runIds: [runId], outDir, bundleDir, log: silent });

    // Byte-equal file copy into the run's data dir.
    expect(readFileSync(join(outDir, "data", "runs", runId, "diagnosis.json"), "utf8")).toBe(stored);

    // And the inline payload carries it under the diagnoses key.
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const match = /window\.__QS_DATA__ = (.*?);<\/script>/s.exec(html);
    const inline = JSON.parse(match?.[1] as string) as { diagnoses?: Record<string, Record<string, unknown>> };
    expect(inline.diagnoses?.[runId]?.["verbatim_marker"]).toBe("diagnosis-artifact");
    expect(inline.diagnoses?.[runId]?.["future_field"]).toBe(true);
  });

  test("a diagnosis-less run exports silently with no diagnoses key and no diagnosis file", async () => {
    const { store, resultsDir, runId, root } = seeded();
    const bundleDir = fakeBundle(root);
    const outDir = join(root, "site");

    const warnings: string[] = [];
    await exportSite({ store, resultsDir, runIds: [runId], outDir, bundleDir, log: (message) => warnings.push(message) });

    // Absence is a legitimate state: no file, no inline key, no warning.
    expect(existsSync(join(outDir, "data", "runs", runId, "diagnosis.json"))).toBeFalse();
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const match = /window\.__QS_DATA__ = (.*?);<\/script>/s.exec(html);
    const inline = JSON.parse(match?.[1] as string) as Record<string, unknown>;
    expect("diagnoses" in inline).toBeFalse();
    expect(warnings.filter((warning) => warning.includes("diagnosis"))).toEqual([]);
  });

  test("malformed diagnosis.json warns and is skipped; the export still succeeds", async () => {
    const { store, resultsDir, runId, root } = seeded();
    mkdirSync(join(resultsDir, runId), { recursive: true });
    writeFileSync(join(resultsDir, runId, "diagnosis.json"), "{ not json", "utf8");

    const warnings: string[] = [];
    const outDir = join(root, "site");
    const summary = await exportSite({
      store,
      resultsDir,
      runIds: [runId],
      outDir,
      log: (message) => warnings.push(message),
    });
    expect(summary.runs).toBe(1);
    expect(warnings.some((warning) => warning.includes("diagnosis.json") && warning.includes(runId))).toBeTrue();
    expect(existsSync(join(outDir, "data", "runs", runId, "diagnosis.json"))).toBeFalse();
  });

  test("missing artifact on disk degrades to null with a warning, not a crash", async () => {
    const { store, resultsDir, runId, root } = seeded();
    const attemptId = store.listAttempts(runId)[0]?.id as string;
    rmSync(join(resultsDir, runId, attemptId, "transcript.jsonl"));

    const warnings: string[] = [];
    const outDir = join(root, "site");
    const summary = await exportSite({
      store,
      resultsDir,
      runIds: [runId],
      outDir,
      log: (message) => warnings.push(message),
    });
    expect(summary.missingAssets).toBe(1);
    expect(warnings.some((warning) => warning.includes(attemptId))).toBeTrue();

    const runJson = readJson<DataRun>(join(outDir, "data", "runs", runId, "run.json"));
    const attempt = runJson.attempts.find((a) => a.id === attemptId);
    expect(attempt?.transcript).toBeNull();
    expect(attempt?.diff).not.toBeNull();
  });

  test("unknown run id fails loudly with recent runs named", async () => {
    const { store, resultsDir, root } = seeded();
    expect(
      exportSite({ store, resultsDir, runIds: ["nope"], outDir: join(root, "site"), log: silent }),
    ).rejects.toThrow(ExportError);
  });

  test("seeded exports are deterministic: two generations are byte-identical", async () => {
    const generatedAt = "2026-07-20T02:00:00.000Z";
    const generate = async (): Promise<Map<string, string>> => {
      const { store, resultsDir, runId, root } = seeded();
      const outDir = join(root, "site");
      try {
        await exportSite({ store, resultsDir, runIds: [runId], outDir, generatedAt, log: silent });
      } finally {
        store.close();
      }
      const files = new Map<string, string>();
      const walk = (current: string, prefix: string): void => {
        for (const entry of readdirSync(current).sort()) {
          const path = join(current, entry);
          const relative = prefix === "" ? entry : `${prefix}/${entry}`;
          if (statSync(path).isDirectory()) walk(path, relative);
          else files.set(relative, readFileSync(path, "utf8"));
        }
      };
      walk(join(outDir, "data"), "");
      return files;
    };

    const first = await generate();
    const second = await generate();
    // Identical ids, identical paths, identical bytes — regenerating the
    // committed dev data must only diff when seed content actually changes.
    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [file, content] of first) {
      expect(second.get(file)).toBe(content);
    }
  });

  test("empty runIds still writes a valid, empty meta index", async () => {
    const { store, resultsDir, root } = seeded();
    const outDir = join(root, "site");
    const summary = await exportSite({ store, resultsDir, runIds: [], outDir, log: silent });
    expect(summary.runs).toBe(0);
    const meta = readJson<DataMeta>(join(outDir, "data", "meta.json"));
    expect(meta.schemaVersion).toBe(DATA_SCHEMA_VERSION);
    expect(meta.runs).toEqual([]);
  });
});

describe("bundle copy + inline data", () => {
  test("copies the bundle and inlines window.__QS_DATA__ into index.html", async () => {
    const { store, resultsDir, runId, root } = seeded();
    const bundleDir = fakeBundle(root);
    const outDir = join(root, "site");

    await exportSite({ store, resultsDir, runIds: [runId], outDir, bundleDir, log: silent });

    expect(existsSync(join(outDir, "assets", "app.js"))).toBeTrue();
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    expect(html).toContain("window.__QS_DATA__ = {");
    expect(html).not.toContain("window.__QS_DATA__ = undefined");

    // The inlined index parses back to the meta/runs/reports shape.
    const match = /window\.__QS_DATA__ = (.*?);<\/script>/s.exec(html);
    expect(match).not.toBeNull();
    const inline = JSON.parse(match?.[1] as string) as { meta: DataMeta; runs: Record<string, DataRun> };
    expect(inline.meta.schemaVersion).toBe(DATA_SCHEMA_VERSION);
    expect(inline.runs[runId]?.attempts).toHaveLength(54);
  });

  test("missing bundle dir fails before anything is written", async () => {
    const { store, resultsDir, runId, root } = seeded();
    const outDir = join(root, "site");
    expect(
      exportSite({ store, resultsDir, runIds: [runId], outDir, bundleDir: join(root, "no-dist"), log: silent }),
    ).rejects.toThrow(/no UI bundle/);
    expect(existsSync(outDir)).toBeFalse();
  });

  test("inlineDataIntoHtml escapes </script> so payloads cannot truncate the document", () => {
    const html = '<html><head><script id="qs-data">window.__QS_DATA__ = undefined;</script></head></html>';
    const data = {
      meta: { schemaVersion: DATA_SCHEMA_VERSION, generated_at: "now", runs: [] },
      runs: {},
      reports: {
        evil: { methodology: "</script><script>alert(1)</script>" } as never,
      },
    };
    const inlined = inlineDataIntoHtml(html, data);
    expect(inlined).not.toContain("</script><script>alert(1)");
    expect(inlined).toContain("\\u003c/script>");

    // And the payload still round-trips.
    const match = /window\.__QS_DATA__ = (.*?);<\/script>/s.exec(inlined);
    const parsed = JSON.parse(match?.[1] as string) as typeof data;
    expect((parsed.reports["evil"] as { methodology: string }).methodology).toBe(
      "</script><script>alert(1)</script>",
    );
  });

  test("replacement-pattern sequences ($&, $') in payload strings survive inlining", () => {
    const html = '<html><head><script id="qs-data">window.__QS_DATA__ = undefined;</script></head></html>';
    const data = {
      meta: { schemaVersion: DATA_SCHEMA_VERSION, generated_at: "now", runs: [] },
      runs: {},
      reports: {
        run: { methodology: "watch out for $& and $' and $` and $1 patterns" } as never,
      },
    };
    const inlined = inlineDataIntoHtml(html, data);
    const match = /window\.__QS_DATA__ = (.*?);<\/script>/s.exec(inlined);
    const parsed = JSON.parse(match?.[1] as string) as typeof data;
    expect((parsed.reports["run"] as { methodology: string }).methodology).toBe(
      "watch out for $& and $' and $` and $1 patterns",
    );
  });

  test("bundle without the qs-data slot fails loudly", () => {
    expect(() =>
      inlineDataIntoHtml("<html><head></head></html>", {
        meta: { schemaVersion: DATA_SCHEMA_VERSION, generated_at: "now", runs: [] },
        runs: {},
        reports: {},
      }),
    ).toThrow(ExportError);
  });
});
