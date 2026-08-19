/**
 * v3 surface-usage: OFFERED derives from the experiment's runtime config +
 * resolved MCP server names; USED derives from the raw stream exactly as
 * before; the store keeps NULL (never a zero-filled object) when no
 * supported stream existed; the report's offered-versus-used rollup counts
 * unavailable telemetry separately.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedRun } from "../scripts/seed-run.ts";
import { buildReport } from "../src/report/report.ts";
import { ResultsStore } from "../src/store/db.ts";
import type { RunManifest } from "../src/manifest.ts";
import {
  extractSurfaceUsage,
  surfaceUsageConfigFromRuntime,
  surfaceUsageVendor,
} from "../src/surface-usage.ts";

function claudeEvent(id: string, name: string, input: unknown): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

describe("offered-surface derivation", () => {
  test("hosts/commands come from the runtime config subtrees; mcp names from the resolved map", () => {
    const config = {
      docs: { nativeWeb: true, hosts: ["*.acme.com", "docs.acme.test"] },
      cli: { commands: ["acme"] },
      unrelated: { nested: { value: 1 } },
    };
    expect(surfaceUsageConfigFromRuntime(config, ["acme-mcp"])).toEqual({
      docsHosts: ["acme.com", "docs.acme.test"],
      cliCommands: ["acme"],
      mcpServers: ["acme-mcp"],
    });
  });

  test("an empty runtime offers nothing", () => {
    expect(surfaceUsageConfigFromRuntime(undefined, [])).toEqual({
      docsHosts: [],
      cliCommands: [],
      mcpServers: [],
    });
  });

  test("only known vendors are extractable; anything else stores NULL", () => {
    expect(surfaceUsageVendor("claude")).toBe("claude");
    expect(surfaceUsageVendor("codex")).toBe("codex");
    expect(surfaceUsageVendor("echo")).toBeNull();
    expect(surfaceUsageVendor("some-future-agent")).toBeNull();
  });
});

describe("offered vs used extraction", () => {
  test("a claude stream against a derived config yields sanitized identifiers per channel", () => {
    const config = surfaceUsageConfigFromRuntime(
      { docs: { hosts: ["docs.acme.test"] }, cli: { commands: ["acme"] } },
      ["acme"],
    );
    const raw = [
      claudeEvent("1", "WebFetch", { url: "https://docs.acme.test/auth?token=sk_secret_123" }),
      claudeEvent("2", "Bash", { command: "acme auth login --api-key sk_secret_123" }),
      claudeEvent("3", "mcp__acme__list_orgs", { query: "everything" }),
    ].join("\n");

    const usage = extractSurfaceUsage("claude", raw, config);
    // Query strings are stripped — credentials never reach telemetry.
    expect(usage.docs.urls).toEqual(["https://docs.acme.test/auth"]);
    expect(usage.docs.count).toBe(1);
    // Only the executable + subcommand survive, never flags or values.
    expect(usage.cli.commands).toEqual(["acme auth"]);
    expect(usage.mcp.tools).toEqual(["mcp__acme__list_orgs"]);
  });

  test("use of a channel the treatment did not offer is still observed (offered≠used)", () => {
    // A cli-treatment experiment whose agent browsed the docs anyway.
    const config = surfaceUsageConfigFromRuntime(
      { cli: { commands: ["acme"] }, docs: { hosts: ["docs.acme.test"] } },
      [],
    );
    const raw = claudeEvent("1", "WebFetch", { url: "https://docs.acme.test/auth" });
    const usage = extractSurfaceUsage("claude", raw, config);
    expect(usage.docs.count).toBe(1);
    expect(usage.cli.count).toBe(0);
  });
});

describe("store round-trip: null never zero", () => {
  function makeStore(): ResultsStore {
    const root = mkdtempSync(join(tmpdir(), "qs-usage-store-"));
    return new ResultsStore(join(root, "results.db"));
  }

  const manifest: RunManifest = {
    manifestVersion: "v3",
    harness: { version: "t", revision: "t", dirty: false, source: { sha256: "0".repeat(64) } },
    evals: {},
    experiments: {},
    images: {},
    hash: "1".repeat(64),
  };

  test("a stored usage payload round-trips; an omitted one stays NULL", () => {
    const store = makeStore();
    store.insertRun({
      id: "01RUN",
      startedAt: 1,
      config: { trials: 1, evalIds: ["e"], experimentIds: ["x"] },
      manifest,
    });
    const base = {
      runId: "01RUN",
      evalId: "e",
      experimentId: "x",
      suite: "benchmark" as const,
      attemptIdentityHash: "2".repeat(64),
      status: "completed" as const,
      result: { passed: true, checks: [] },
    };
    store.insertAttempt({
      ...base,
      id: "01WITH",
      trialIndex: 0,
      surfaceUsage: { docs: { count: 2, urls: ["https://docs.acme.test/auth"] }, mcp: { count: 0, tools: [] }, cli: { count: 0, commands: [] } },
    });
    store.insertAttempt({ ...base, id: "01WITHOUT", trialIndex: 1 });

    const attempts = store.listAttempts("01RUN");
    const withUsage = attempts.find((attempt) => attempt.id === "01WITH");
    const withoutUsage = attempts.find((attempt) => attempt.id === "01WITHOUT");
    expect(withUsage?.surfaceUsage?.docs.urls).toEqual(["https://docs.acme.test/auth"]);
    // Missing telemetry is NULL — never a zero-filled object.
    expect(withoutUsage?.surfaceUsage).toBeNull();
    store.close();
  });
});

describe("report offered-vs-used rollup", () => {
  test("unavailable telemetry is counted separately, never as zero use", () => {
    const root = mkdtempSync(join(tmpdir(), "qs-usage-report-"));
    const dbPath = join(root, "results.db");
    const resultsDir = join(root, "results");
    const { runId } = seedRun({ dbPath, resultsDir });
    const store = new ResultsStore(dbPath);
    const report = buildReport({ store, runId, resultsDir });

    // codex-mcp has one errored attempt (NULL usage) on django.
    const codexMcp = report.usage.find((usage) => usage.experiment_id === "codex-mcp")!;
    expect(codexMcp.treatment).toBe("mcp");
    expect(codexMcp.telemetry_unavailable).toBeGreaterThan(0);
    expect(codexMcp.telemetry_available + codexMcp.telemetry_unavailable).toBe(9);
    expect(codexMcp.channels.mcp.events).toBeGreaterThan(0);

    // claude-cli's failing trials read docs — cross-arm use shows up on the
    // docs channel of a cli-treatment experiment.
    const claudeCli = report.usage.find((usage) => usage.experiment_id === "claude-cli")!;
    expect(claudeCli.treatment).toBe("cli");
    expect(claudeCli.channels.docs.events).toBeGreaterThan(0);
    expect(claudeCli.channels.cli.events).toBeGreaterThan(0);

    // claude-docs reports full telemetry: offered docs, observed docs only.
    const claudeDocs = report.usage.find((usage) => usage.experiment_id === "claude-docs")!;
    expect(claudeDocs.telemetry_unavailable).toBe(0);
    expect(claudeDocs.channels.mcp.events).toBe(0);
    expect(claudeDocs.channels.docs.values).toEqual(["https://docs.acme.test/auth"]);
    store.close();
  });
});
