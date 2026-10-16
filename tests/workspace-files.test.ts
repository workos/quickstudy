import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExperiment, defineWorkspaceFiles, WORKSPACE_FILES_LIMITS, type WorkspaceFiles, type Experiment } from "../src/index.ts";
import { CodexAdapter, CODEX_CONFIG_PATH } from "../src/adapters/codex.ts";
import { OracleContainerAdapter } from "../src/adapters/oracle.ts";
import type { ContainerAgentAdapter } from "../src/adapters/types.ts";
import { discoverEvals } from "../src/evals/discovery.ts";
import { compareGroups } from "../src/experiments/groups.ts";
import { pairKey, resolvePairEnvironments } from "../src/execution-policy.ts";
import { hashString, hashTree } from "../src/hash.ts";
import { WORKSPACE_FILES_PROGRAM } from "../src/isolation/workspace-files.ts";
import type { AttemptContainer, CreateAttemptContainerOptions } from "../src/isolation/docker.ts";
import { buildRunManifest, type HarnessIdentity } from "../src/manifest.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore } from "../src/store/db.ts";

const roots: string[] = [];
const stores: ResultsStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp() { const root = realpathSync(mkdtempSync(join(tmpdir(), "qs-files-"))); roots.push(root); return root; }
const harness: HarnessIdentity = { version: "test", revision: "test", dirty: false, source: { sha256: "a".repeat(64) } };
const text = "# Harbor guide\r\nUnicode: 雪 🌊\n\n$(do-not-execute) `literal`\n";
const destination = ".agents/skills/harbor/SKILL.md";
const source = { id: "harbor-guide", version: "commit-abc123" };
function files(content = text): WorkspaceFiles {
  return { version: 1, files: [{ path: destination, encoding: "utf8", content, source }], absent: [] };
}
function control(): WorkspaceFiles { return { version: 1, files: [], absent: [".agents/skills/harbor"] }; }
function recipe(id = "files", overlay: WorkspaceFiles | undefined = files()): Experiment {
  return { id, agent: { adapter: "codex", model: "gpt-5.4-2026-03-05", reasoning: "high", cliVersion: "test-cli" },
    comparisonGroup: "files-study", treatment: id,
    runtime: { kind: "container", image: "test-image", ...(overlay ? { workspaceFiles: overlay } : {}),
      treatmentPolicyFields: ["workspaceFiles"], mcpServers: () => ({ guide: { url: "https://docs.example.test/mcp" } }),
    } };
}

/** Retain the actual Codex login/command, config and parser; only provider I/O is removed. */
function offlineCodex(): ContainerAgentAdapter {
  const adapter = new CodexAdapter("codex", { model: "gpt-5.4-2026-03-05", reasoning: "high" });
  return { kind: "container", name: adapter.name, identity: adapter.identity,
    requiredHostEnv: ["QUICKSTUDY_TEST_FILE_KEY"], setupFiles: adapter.setupFiles.bind(adapter),
    command: adapter.command.bind(adapter), parseStream: adapter.parseStream.bind(adapter) };
}
const stream = [
  { type: "thread.started", thread_id: "offline" },
  { type: "item.completed", item: { type: "agent_message", text: "Done" } },
  { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 7 } },
].map((event) => JSON.stringify(event)).join("\n");

type Faults = {
  agentStream?: string;
  contaminate?: (workspace: string) => void;
  corrupt?: boolean;
  setupMutation?: boolean;
  afterSetup?: (workspace: string) => void;
  writeFailure?: boolean;
  teardownFailure?: boolean;
  waitForAbort?: boolean;
  onStage?: () => void;
  noGit?: boolean;
};
function rig(experiments = [recipe()], faults: Faults = {}) {
  const root = temp();
  const dir = join(root, "evals", "task");
  mkdirSync(join(dir, "local"), { recursive: true });
  writeFileSync(join(dir, "local", "seed.txt"), "untouched\n");
  writeFileSync(join(dir, "PROMPT.md"), "---\nid: task\nsuite: benchmark\n---\n\nDo the task.\n");
  writeFileSync(join(dir, "EVAL.ts"), "export default async (ctx) => ({ passed: await ctx.fileExists('seed.txt'), checks: [] });\n");
  const evals = discoverEvals(join(root, "evals"));
  const loaded = experiments.map((experiment) => {
    const path = join(root, experiment.id + ".ts");
    writeFileSync(path, "export default {};\n"); // Dynamic payload deliberately absent from module source.
    return { experiment, path };
  });
  const store = new ResultsStore(join(root, "results.db")); stores.push(store);
  const artifacts = new ArtifactsStore(join(root, "results"));
  const events: string[] = [];
  const commands: string[][] = [];
  const envs: Record<string, string>[] = [];
  const setupContents: Record<string, string> = {};
  const staged: Buffer[] = [];
  const baselineHadFile: boolean[] = [];
  const createContainer = async (options: CreateAttemptContainerOptions): Promise<AttemptContainer> => {
    events.push("create"); envs.push(options.env);
    const containerRoot = join(root, options.attemptId);
    const workspace = join(containerRoot, "workspace");
    mkdirSync(workspace, { recursive: true });
    cpSync(options.fixtureDir, workspace, { recursive: true });
    faults.contaminate?.(workspace);
    const map = (path: string) => path.startsWith("/workspace/") ? join(workspace, path.slice(11)) : path.startsWith("/") ? join(containerRoot, path.slice(1)) : join(workspace, path);
    return {
      id: options.attemptId,
      execInWorkspace: async (cmd) => {
        if (cmd[0] === "git") {
          if (faults.noGit) return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
          if (cmd.includes("commit")) {
            events.push("baseline");
            baselineHadFile.push(existsSync(join(workspace, destination)));
          }
          const result = Bun.spawnSync(cmd, { cwd: workspace, stdout: "pipe", stderr: "pipe" });
          return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), timedOut: false };
        }
        events.push("agent"); commands.push(cmd);
        return { exitCode: 0, stdout: faults.agentStream ?? stream, stderr: "", timedOut: false };
      },
      workspaceFiles: async (request, signal) => {
        events.push(request.phase);
        if (request.phase === "stage") faults.onStage?.();
        if (faults.waitForAbort) {
          if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          events.push("staging-stopped");
          throw new Error("stopped");
        }
        const proc = Bun.spawn([process.execPath, "-e", WORKSPACE_FILES_PROGRAM, workspace], {
          stdin: Buffer.from(JSON.stringify({ ...request, setupPaths: request.setupPaths.map(map) })), stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (exitCode !== 0) throw new Error(stderr);
        const actual = JSON.parse(stdout);
        if (request.phase === "stage" && request.declaration.files.length) staged.push(readFileSync(join(workspace, request.declaration.files[0]!.path)));
        if (faults.corrupt && actual.files.length) actual.files[0].sha256 = "0".repeat(64);
        return actual;
      },
      writeFile: async (path, content) => {
        events.push("setup"); setupContents[path] = content;
        if (faults.writeFailure) throw new Error("DO-NOT-LOG-PAYLOAD");
        const target = map(path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, content);
        if (faults.setupMutation) writeFileSync(join(workspace, destination), "altered by setup");
        faults.afterSetup?.(workspace);
      },
      exportWorkspace: async (to) => { events.push("export"); cpSync(workspace, to, { recursive: true }); },
      teardown: async () => {
        events.push("teardown"); rmSync(containerRoot, { recursive: true, force: true });
        if (faults.teardownFailure) throw new Error("offline teardown failure");
      },
    };
  };
  const manifest = () => buildRunManifest({ evals, experiments: loaded, harness });
  const plan = loaded.map(({ experiment }) => ({ evalId: "task", experimentId: experiment.id, trialIndex: 0 }));
  const run = (extra: Partial<Parameters<typeof executeRunV3>[0]> = {}) => executeRunV3({
    evals, experiments: loaded, plan, store, artifacts, manifest: extra.manifest ?? manifest(), createContainer,
    containerAdapters: { codex: offlineCodex, oracle: () => new OracleContainerAdapter() }, log: () => {}, ...extra,
  });
  return { root, dir, evals, loaded, store, artifacts, events, commands, envs, setupContents, staged, baselineHadFile, manifest, run };
}

// A made-up key, not a real provider secret. No default adapter/probe is invoked.
process.env.QUICKSTUDY_TEST_FILE_KEY = "fake-overlay-key-not-a-credential";
afterAll(() => { delete process.env.QUICKSTUDY_TEST_FILE_KEY; });

describe("workspaceFiles public declaration", () => {
  test("public helper snapshots, canonicalizes and deeply freezes exact bytes", () => {
    const input = files();
    const resolved = defineWorkspaceFiles(input);
    input.files[0]!.content = "changed";
    expect(Buffer.from(resolved.files[0]!.content, "base64").toString()).toBe(text);
    expect(Object.isFrozen(resolved.files[0]!.source)).toBe(true);
    expect(Object.isFrozen(defineExperiment(recipe()).runtime.workspaceFiles)).toBe(true);
  });
  for (const path of ["", "/absolute", "../escape", "a/../b", "a/./b", "a//b", "a/", "C:/drive", "C:drive", "\\\\server\\file", "a\\b", "a:b", "a\u0000b", "a\nb", ".git/config", "x/.GIT/config", ".gitmodules", ".env", "private-key", "node_modules/file", ".quickstudy/file", "NUL.md", "a.", "x".repeat(241), Array(18).fill("a").join("/")]) {
    test(`rejects unsafe path ${JSON.stringify(path)}`, () => {
      const input = files(); input.files[0]!.path = path;
      expect(() => defineWorkspaceFiles(input)).toThrow("workspaceFiles:");
    });
  }
  test("rejects overlaps, invalid metadata, encodings, versions, and all size/count limits", () => {
    const invalid: WorkspaceFiles[] = [
      { ...files(), files: [files().files[0]!, files().files[0]!] },
      { ...files(), absent: [".agents"] },
      { ...control(), absent: ["tree", "tree/child"] },
      { ...files(), version: 2 as 1 },
      files("\ud800"),
      files("x".repeat(WORKSPACE_FILES_LIMITS.fileBytes + 1)),
      { ...files(), files: Array(129).fill(files().files[0]) },
      { ...files(), files: Array.from({ length: 5 }, (_, i) => ({ ...files("x".repeat(WORKSPACE_FILES_LIMITS.fileBytes)).files[0]!, path: `file-${i}` })) },
      { ...control(), absent: Array.from({ length: 129 }, (_, i) => `file-${i}`) },
      { ...files(), files: [{ ...files().files[0]!, encoding: "base64", content: "YQ" }] },
      { ...files(), files: [{ ...files().files[0]!, encoding: "hex" as "utf8" }] },
      { ...files(), files: [{ ...files().files[0]!, source: { id: "/host/source", version: "v1" } }] },
    ];
    for (const input of invalid) expect(() => defineWorkspaceFiles(input)).toThrow("workspaceFiles:");
  });
  test("unsupported host/scripted overlays fail before container, provision or provider activity", async () => {
    for (const runtime of [{ kind: "host" as const }, { kind: "container" as const, command: ["echo", "not-a-hook"] }]) {
      const experiment = recipe(); Object.assign(experiment.runtime, runtime);
      expect(() => defineExperiment(experiment)).toThrow("requires a container adapter");
      const r = rig([experiment]);
      expect(() => r.run({ manifest: undefined })).toThrow("requires a container adapter");
      expect(r.events).toEqual([]);
    }
  });
});

describe("production runner with offline containers", () => {
  test("baseline -> stage -> normal Codex setup -> verification -> normal login/command, metrics, export and cleanup", async () => {
    const r = rig(); const before = hashTree(join(r.dir, "local"));
    const summary = await r.run();
    expect(summary).toMatchObject({ passed: 1, errors: 0 });
    expect(r.events).toEqual(["create", "baseline", "stage", "setup", "verify", "agent", "export", "teardown"]);
    expect(r.staged[0]).toEqual(Buffer.from(text));
    expect(r.baselineHadFile).toEqual([false]);
    expect(r.commands[0]).toEqual(offlineCodex().command({ runId: "", attemptId: "", prompt: r.evals[0]!.promptBody, trialIndex: 0, webPolicy: "native-web-blocked" }));
    expect(r.commands[0]!.join(" ")).toContain("codex login --with-api-key");
    expect(r.setupContents[CODEX_CONFIG_PATH]).toContain('[mcp_servers.guide]');
    expect(r.envs[0]!.QUICKSTUDY_TEST_FILE_KEY).toBe(process.env.QUICKSTUDY_TEST_FILE_KEY!);
    const attempt = r.store.listAttempts(summary.runId)[0]!;
    expect(attempt).toMatchObject({ tokensIn: 12, tokensOut: 7, turns: 1, status: "completed" });
    expect(attempt.agentStartedAt).not.toBeNull();
    expect(hashTree(join(r.dir, "local"))).toEqual(before);
    const evidence = JSON.parse(readFileSync(join(r.artifacts.paths(summary.runId, attempt.id).attemptDir, "workspace-files.json"), "utf8"));
    expect(evidence.verified).toEqual(r.manifest().pairs![pairKey("task", "files")]!.workspaceFiles);
    expect(evidence.verified.files[0].sha256).toBe(hashString(Buffer.from(text)));
    expect(JSON.stringify(r.store.getRun(summary.runId))).not.toContain(text);
    expect(JSON.stringify(evidence)).not.toContain(process.env.QUICKSTUDY_TEST_FILE_KEY!);
    expect(readFileSync(attempt.transcriptRef!, "utf8")).not.toContain(process.env.QUICKSTUDY_TEST_FILE_KEY!);
  });

  test("overlay staging preserves the recorded preamble, check kinds and fetch-only docs evidence", async () => {
    const url = "https://docs.example.test/guide";
    const experiment = recipe("files", files(`${text}\n${url}\n`));
    let preamble = "  Read the local Harbor guide.\n";
    let resolutions = 0;
    experiment.runtime.promptPreamble = () => { resolutions++; return preamble; };
    experiment.runtime.observationTargets = { docsHosts: ["docs.example.test"] };
    const agentStream = [stream,
      JSON.stringify({ type: "item.completed", item: { id: "write", type: "command_execution", command: `printf '%s' '${url}' > README.md` } }),
      JSON.stringify({ type: "item.completed", item: { id: "fetch", type: "command_execution", command: `curl '${url}'` } }),
    ].join("\n");
    const r = rig([experiment], { agentStream });
    const checks = [
      { name: "sdk_seen", passed: true, graded: false, kind: "sdk" },
      { name: "wiring_seen", passed: false, graded: false, kind: "wiring" },
    ];
    writeFileSync(join(r.dir, "EVAL.ts"), `export default async () => (${JSON.stringify({ passed: true, checks })});\n`);
    const manifest = r.manifest();
    const intended = manifest.pairs![pairKey("task", "files")]!;
    expect(intended.promptPreamble).toBe("Read the local Harbor guide.");
    preamble = "Changed after manifest resolution; must not be delivered.";
    const prompt = `${intended.promptPreamble}\n\n${r.evals[0]!.promptBody}`;
    const adapter = offlineCodex();
    const setupFiles = adapter.setupFiles;
    adapter.setupFiles = (ctx) => { expect(ctx.prompt).toBe(prompt); return setupFiles(ctx); };
    const summary = await r.run({ manifest, containerAdapters: { codex: () => adapter } });
    expect(summary).toMatchObject({ passed: 1, errors: 0 });
    expect(resolutions).toBe(1);
    expect(r.commands[0]).toContain(prompt);
    expect(r.events).toEqual(["create", "baseline", "stage", "setup", "verify", "agent", "export", "teardown"]);
    const attempt = r.store.listAttempts(summary.runId)[0]!;
    expect(attempt.result?.checks).toEqual(checks);
    expect(attempt.surfaceUsage?.docs).toEqual({ count: 1, urls: [url] });
    const evidence = JSON.parse(readFileSync(join(r.artifacts.paths(summary.runId, attempt.id).attemptDir, "workspace-files.json"), "utf8"));
    expect(evidence.verified).toEqual(intended.workspaceFiles);
  });

  test("base64 preserves arbitrary bytes and empty files; sorted inventory agrees", async () => {
    const bytes = Buffer.from([0, 255, 128, 10, 13, 0]);
    const overlay: WorkspaceFiles = { version: 1, files: [
      { path: "z.bin", encoding: "base64", content: bytes.toString("base64"), source },
      { path: "a.md", encoding: "utf8", content: "", source },
    ], absent: ["unused"] };
    const r = rig([recipe("binary", overlay)]);
    const summary = await r.run(); expect(summary.passed).toBe(1);
    const attempt = r.store.listAttempts(summary.runId)[0]!;
    const workspace = r.artifacts.paths(summary.runId, attempt.id).workspace;
    expect(readFileSync(join(workspace, "z.bin"))).toEqual(bytes);
    expect(readFileSync(join(workspace, "a.md"))).toEqual(Buffer.alloc(0));
    expect(r.manifest().pairs![pairKey("task", "binary")]!.workspaceFiles!.files.map((f) => f.path)).toEqual(["a.md", "z.bin"]);
  });

  for (const fault of ["fixture file", "fixture directory", "symlink ancestor", "symlink leaf", "file ancestor", "corrupt readback", "setup invalidation", "write failure", "missing git"] as const) {
    test(`${fault} fails closed without agent execution`, async () => {
      const faults: Faults = {
        corrupt: fault === "corrupt readback", setupMutation: fault === "setup invalidation", writeFailure: fault === "write failure", noGit: fault === "missing git",
        contaminate: (workspace) => {
          if (fault === "symlink ancestor") symlinkSync("/nonexistent-outside", join(workspace, ".agents"));
          if (fault === "file ancestor") writeFileSync(join(workspace, ".agents"), "occupied");
          if (["fixture file", "fixture directory", "symlink leaf"].includes(fault)) {
            mkdirSync(join(workspace, ".agents/skills/harbor"), { recursive: true });
            if (fault === "fixture file") writeFileSync(join(workspace, destination), "occupied");
            if (fault === "fixture directory") mkdirSync(join(workspace, destination));
            if (fault === "symlink leaf") symlinkSync("/nonexistent-outside", join(workspace, destination));
          }
        },
      };
      const r = rig([recipe()], faults);
      const summary = await r.run();
      expect(summary.errors).toBe(1); expect(r.commands).toEqual([]); expect(r.events.at(-1)).toBe("teardown");
      const attempt = r.store.listAttempts(summary.runId)[0]!;
      expect(attempt).toMatchObject({ status: "error", errorKind: "environment", agentStartedAt: null, result: null });
      expect(attempt.error).not.toContain("DO-NOT-LOG-PAYLOAD");
      expect(existsSync(join(r.artifacts.paths(summary.runId, attempt.id).attemptDir, "workspace-files.json"))).toBe(false);
    });
  }

  test("runner preflight rejects unsafe/oversized/unknown-semantics declarations even with an injected manifest", async () => {
    for (const invalid of [
      { ...files(), files: [{ ...files().files[0]!, path: "../escape" }] },
      files("x".repeat(WORKSPACE_FILES_LIMITS.fileBytes + 1)),
      { ...files(), version: 2 as 1 },
    ]) {
      const r = rig(); const manifest = r.manifest();
      r.loaded[0]!.experiment.runtime.workspaceFiles = invalid;
      await expect(r.run({ manifest })).rejects.toThrow("workspaceFiles:");
      expect(r.events).toEqual([]);
    }
  });

  test("final verification rejects symlink/hardlink/type/mode changes after adapter setup", async () => {
    for (const change of ["symlink", "hardlink", "directory", "executable"]) {
      const r = rig([recipe()], { afterSetup: (workspace) => {
        const path = join(workspace, destination);
        if (change === "hardlink") linkSync(path, join(workspace, "alias.md"));
        else if (change === "executable") chmodSync(path, 0o755);
        else {
          rmSync(path);
          if (change === "symlink") symlinkSync(join(workspace, "seed.txt"), path);
          else mkdirSync(path);
        }
      } });
      expect((await r.run()).errors).toBe(1);
      expect(r.events).toContain("verify"); expect(r.commands).toEqual([]);
    }
  });

  test("adapter-owned destination/tree conflicts are rejected before staging", async () => {
    for (const path of ["/workspace/" + destination, "/workspace/.agents", "/workspace/.agents/skills/harbor/SKILL.md/child"]) {
      const r = rig(); const adapter = offlineCodex(); adapter.setupFiles = () => ({ [path]: "owned" });
      const summary = await r.run({ containerAdapters: { codex: () => adapter } });
      expect(summary.errors).toBe(1); expect(r.events).not.toContain("stage"); expect(r.commands).toEqual([]);
      expect(r.store.listAttempts(summary.runId)[0]!.error).toContain("adapter setup collision");
    }
  });

  test("files then no-files control has no leakage; absence is checked twice and never deletes contamination", async () => {
    const r = rig([recipe("files"), recipe("control", control())]);
    // Separate runs make the order explicit, rather than relying on scheduler hashing.
    await r.run({ plan: [{ evalId: "task", experimentId: "files", trialIndex: 0 }] });
    const summary = await r.run({ plan: [{ evalId: "task", experimentId: "control", trialIndex: 0 }] });
    expect(summary.passed).toBe(1);
    const attempt = r.store.listAttempts(summary.runId)[0]!;
    expect(existsSync(join(r.artifacts.paths(summary.runId, attempt.id).workspace, ".agents"))).toBe(false);
    const evidence = JSON.parse(readFileSync(join(r.artifacts.paths(summary.runId, attempt.id).attemptDir, "workspace-files.json"), "utf8"));
    expect(evidence.verified.absent).toEqual([".agents/skills/harbor"]);
    for (const kind of ["file", "directory", "symlink"]) {
      const contaminated = rig([recipe("control", control())], { contaminate: (workspace) => {
        mkdirSync(join(workspace, ".agents/skills"), { recursive: true });
        const target = join(workspace, ".agents/skills/harbor");
        if (kind === "directory") mkdirSync(target);
        else if (kind === "file") writeFileSync(target, "contaminated");
        else symlinkSync("/does-not-exist", target);
      } });
      expect((await contaminated.run()).errors).toBe(1); expect(contaminated.commands).toEqual([]);
    }
  });

  test("cancellation joins staging before teardown, preserves primary error alongside cleanup failure", async () => {
    const controller = new AbortController();
    const r = rig([recipe()], { waitForAbort: true, onStage: () => setTimeout(() => controller.abort(), 10), teardownFailure: true });
    const summary = await r.run({ signal: controller.signal });
    expect(summary.errors).toBe(1);
    expect(r.events.slice(-2)).toEqual(["staging-stopped", "teardown"]); expect(r.commands).toEqual([]);
    const attempt = r.store.listAttempts(summary.runId)[0]!;
    expect(attempt.errorKind).toBe("environment"); expect(attempt.agentStartedAt).toBeNull();
    expect(attempt.error).toContain("staging cancelled or timed out"); expect(attempt.error).toContain("container teardown failed");
  });

  test("fixed staging deadline aborts and joins before cleanup, never starts the agent", async () => {
    const r = rig([recipe()], { waitForAbort: true });
    const start = Date.now(); const summary = await r.run();
    expect(Date.now() - start).toBeGreaterThanOrEqual(WORKSPACE_FILES_LIMITS.timeoutMs);
    expect(summary.errors).toBe(1); expect(r.commands).toEqual([]);
    expect(r.events.slice(-2)).toEqual(["staging-stopped", "teardown"]);
    expect(r.store.listAttempts(summary.runId)[0]!.agentStartedAt).toBeNull();
  }, 40000);

  test("class runtime capabilities keep their original receiver with workspace files", async () => {
    const calls: string[] = [];
    class GuideRuntime {
      readonly kind = "container" as const;
      readonly workspaceFiles = files();
      #image = "test-image";
      containerImage() { calls.push("image"); return this.#image; }
      promptPreamble() { return `Guide for ${this.#image}.`; }
      mcpServers() { return { guide: { url: `https://${this.#image}.example.test/mcp` } }; }
      async provision() {
        expect(runtime).toBe(this);
        expect(this.#image).toBe("test-image");
        calls.push("provision");
        return {};
      }
      scorerCapabilities() {
        expect(runtime).toBe(this);
        calls.push("scorer");
        return { query: async () => this.#image };
      }
      async teardown() {
        expect(runtime).toBe(this);
        expect(this.#image).toBe("test-image");
        calls.push("teardown");
      }
    }
    const runtime = new GuideRuntime();
    const experiment = defineExperiment({ ...recipe(), runtime });
    const r = rig([experiment]);
    writeFileSync(join(r.dir, "EVAL.ts"), `export default async (ctx) => ({ passed: await ctx.query({}) === 'test-image', checks: [] });\n`);
    expect((await r.run()).passed).toBe(1);
    expect(calls).toContain("image");
    expect(calls.slice(-3)).toEqual(["provision", "scorer", "teardown"]);
    expect(r.commands[0]).toContain(`Guide for test-image.\n\n${r.evals[0]!.promptBody}`);
    expect(r.setupContents[CODEX_CONFIG_PATH]).toContain("https://test-image.example.test/mcp");
    expect(r.staged[0]).toEqual(Buffer.from(text));
    expect(experiment.runtime).toBe(runtime);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(runtime.workspaceFiles.files[0]!.encoding).toBe("utf8");
  });

  test("snapshot is bound before awaits; caller mutation cannot substitute payload bytes", async () => {
    const input = files(); const experiment = recipe("files", input);
    const r = rig([experiment], { onStage: () => { input.files[0]!.content = "mutated after identity"; } });
    expect((await r.run()).passed).toBe(1); expect(r.staged[0]).toEqual(Buffer.from(text));
  });

  test("no-overlay normal, scripted, host and oracle paths remain supported", async () => {
    const normal = recipe(); delete normal.runtime.workspaceFiles;
    const scripted = recipe("scripted"); delete scripted.runtime.workspaceFiles; scripted.runtime.command = ["echo", "scripted"];
    const host: Experiment = { id: "host", agent: { adapter: "echo" }, runtime: { kind: "host" } };
    const r = rig([normal, scripted, host]);
    expect((await r.run()).passed).toBe(3); expect(r.events).not.toContain("stage");
    const oracle = recipe("oracle"); oracle.agent = { adapter: "oracle" };
    const o = rig([oracle]);
    mkdirSync(join(o.dir, "solution")); writeFileSync(join(o.dir, "solution", "answer.md"), "reference");
    o.evals[0]!.solutionDir = join(o.dir, "solution");
    expect((await o.run()).passed).toBe(1);
    expect(o.events.indexOf("baseline")).toBeLessThan(o.events.indexOf("stage"));
  });
});

describe("generated identity, resume and actual group comparison", () => {
  test("dynamic bytes, path, provenance and absence change identity; encoding aliases do not", () => {
    const r = rig(); const baseline = r.manifest();
    for (const mutate of [
      (f: WorkspaceFiles) => { f.files[0]!.content += "!"; },
      (f: WorkspaceFiles) => { f.files[0]!.path += ".md"; },
      (f: WorkspaceFiles) => { f.files[0]!.source = { ...source, version: "commit-def456" }; },
      (f: WorkspaceFiles) => { (f.absent as string[]).push("unused"); },
    ]) {
      const input = files(); mutate(input); r.loaded[0]!.experiment.runtime.workspaceFiles = input;
      const changed = r.manifest(); expect(changed.hash).not.toBe(baseline.hash);
      expect(changed.experiments.files!.hash).not.toBe(baseline.experiments.files!.hash);
    }
    const encoded = files(); encoded.files[0]!.encoding = "base64"; encoded.files[0]!.content = Buffer.from(text).toString("base64");
    r.loaded[0]!.experiment.runtime.workspaceFiles = encoded;
    expect(r.manifest().hash).toBe(baseline.hash);
    r.loaded[0]!.experiment.runtime.workspaceFiles = { ...files(), version: 2 as 1 };
    expect(() => r.manifest()).toThrow("unsupported staging version");
    expect(JSON.stringify(baseline)).not.toContain(r.root);
    expect(JSON.stringify(baseline)).not.toContain(Buffer.from(text).toString("base64"));
  });

  test("manifest and pair resolution use captured files even if the runtime declaration changes", () => {
    for (const offered of [files(), undefined]) {
      const experiment = recipe();
      experiment.runtime.workspaceFiles = offered;
      const r = rig([experiment]);
      const expected = r.manifest();
      const workspaceFilesByExperiment = new Map([[experiment.id, offered ? defineWorkspaceFiles(offered) : undefined]]);
      experiment.runtime.workspaceFiles = files("changed after capture");
      const options = { evals: r.evals, experiments: r.loaded, harness, workspaceFilesByExperiment };
      expect(resolvePairEnvironments(options)).toEqual(expected.pairs!);
      expect(buildRunManifest(options)).toEqual(expected);
    }
  });

  test("stale payload manifests and stale resume are rejected; unchanged resume executes nothing", async () => {
    const r = rig(); const oldManifest = r.manifest(); const first = await r.run();
    const count = r.commands.length;
    expect((await r.run({ resumeRunId: first.runId })).passed).toBe(1); expect(r.commands.length).toBe(count);
    r.loaded[0]!.experiment.runtime.workspaceFiles = files("new dynamic bytes");
    await expect(r.run({ manifest: oldManifest })).rejects.toThrow("manifest payload identity mismatch");
    await expect(r.run({ resumeRunId: first.runId })).rejects.toThrow("resume refused");
    expect(r.commands.length).toBe(count);
  });

  test("only mutually declared file availability varies; other config/policy/agent/image/budget differences withhold", () => {
    const r = rig([recipe("files"), recipe("control", control())]);
    const experiments = r.loaded.map((x) => x.experiment);
    const compare = () => compareGroups(experiments, r.manifest())[0]!;
    expect(compare().comparison).toBe("allowed");
    expect(r.manifest().experiments.files!.hash).not.toBe(r.manifest().experiments.control!.hash);
    const arm = experiments[1]!;
    for (const exemptions of [[], ["workspaceFiles"]] as const) {
      experiments[0]!.runtime.treatmentPolicyFields = [...exemptions]; arm.runtime.treatmentPolicyFields = [];
      expect(compare().comparison).toBe("withheld");
    }
    experiments[0]!.runtime.treatmentPolicyFields = ["workspaceFiles"]; arm.runtime.treatmentPolicyFields = ["workspaceFiles"];
    const changes: Array<(e: Experiment) => void> = [
      (e) => { e.agent.model = "different-model"; }, (e) => { e.agent.cliVersion = "different-cli"; },
      (e) => { e.runtime.image = "different-image"; }, (e) => { e.runtime.config = { unrelated: true }; },
      (e) => { e.runtime.egressHosts = () => ["different.example.test"]; },
      (e) => { e.runtime.webPolicy = () => "native-web-allowed"; },
      (e) => { e.runtime.pathTreatment = () => "/opt/different"; },
      (e) => { e.runtime.promptPreamble = () => "A different treatment hint."; },
    ];
    for (const change of changes) {
      const original = { ...arm, agent: { ...arm.agent }, runtime: { ...arm.runtime } };
      change(arm); expect(compare().comparison).toBe("withheld"); Object.assign(arm, original);
    }
    const pairs = resolvePairEnvironments({ evals: r.evals, experiments: r.loaded, mcpHashes: { files: "a", control: "b" } });
    const manifest = buildRunManifest({ evals: r.evals, experiments: r.loaded, harness, pairs });
    expect(compareGroups(experiments, manifest)[0]!.comparison).toBe("withheld");
    const budgetPairs = Object.assign({}, ...r.loaded.map((loaded, i) => resolvePairEnvironments({
      evals: r.evals, experiments: [loaded], budgets: { agentMs: 1000 + i },
    })));
    const budgets = buildRunManifest({ evals: r.evals, experiments: r.loaded, harness, pairs: budgetPairs });
    expect(compareGroups(experiments, budgets)[0]!.comparison).toBe("withheld");
    arm.runtime.command = ["echo", "different-command"];
    expect(() => r.manifest()).toThrow("requires a container adapter");
  });
});
