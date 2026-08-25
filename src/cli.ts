#!/usr/bin/env bun
/**
 * quickstudy command router.
 *
 * Every load error exits non-zero with file/line context — an eval or
 * experiment is never partially loaded, and nothing (containers, agents)
 * starts before the roots validate and every preflight (provider keys,
 * MCP credentials) passes.
 */

import * as quickstudyApi from "./index.ts";

// Consumer modules (EVAL.ts, experiments/*.ts) import the harness by package
// name. From source, Bun resolves that self-reference through the root
// package.json; the compiled binary has no package.json or node_modules to
// consult when it dynamically imports those files, so the bare specifier must
// be served by the binary itself. Serving the embedded API also guarantees
// exactly one copy of the harness at runtime — a disk-resolved second copy
// would break instanceof checks and identity hashing.
Bun.plugin({
  name: "quickstudy-self-resolution",
  setup(build) {
    build.module("quickstudy", () => ({ exports: quickstudyApi, loader: "object" }));
  },
});

import { existsSync, mkdtempSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  dockerDaemonReachable,
  removeAttemptContainers,
  removeRunResources,
} from "./isolation/docker.ts";
import {
  buildAgentRuntimeImage,
  buildEgressProxyImage,
  buildMcpProxyImage,
} from "./isolation/images.ts";
import { EMBEDDED_BUILD_INFO } from "./build-info.generated.ts";
import {
  buildReport,
  renderReportText,
  ReportError,
  writeReportJson,
  type ReportJson,
} from "./report/report.ts";
import { ExportError, exportSite } from "./export.ts";
import { renderDiagnosisText } from "./diagnose/render.ts";
import { diagnosisJsonPath, runDiagnose } from "./diagnose/run.ts";
import { DiagnoseError } from "./diagnose/types.ts";
import { AnthropicModelClient, ModelOutputError } from "./llm.ts";
import { discoverEvals, importEvalScorer } from "./evals/discovery.ts";
import { EvalLoadError } from "./evals/prompt.ts";
import { discoverExperiments, ExperimentLoadError } from "./experiments/discovery.ts";
import { compareGroups } from "./experiments/groups.ts";
import { buildRunManifest } from "./manifest.ts";
import { filterEvals, planRun } from "./plan.ts";
import { executeRunV3 } from "./runner/execute.ts";
import { collectProviderKeys, InvalidProviderKeyError, MissingProviderKeyError } from "./secrets.ts";
import { serveSite } from "./serve.ts";
import { UI_INDEX_HTML_BASE64 } from "./ui-bundle.generated.ts";
import { ArtifactsStore } from "./store/artifacts.ts";
import { ResultsStore } from "./store/db.ts";

const USAGE = `quickstudy — eval × experiment harness for coding agents

Usage:
  quickstudy validate                     Validate the evals and experiments roots
    [--evals-root <dir>]                  Evals root (default: evals)
    [--experiments-root <dir>]            Experiments root (default: experiments)
  quickstudy run [--eval <id>...]         Execute evals against experiments
    [--experiment <id>...]                Omit either selector to include every discovered item
    [--evals-root <dir>]                  Evals root (default: evals)
    [--experiments-root <dir>]            Experiments root (default: experiments)
    [--suite <s>]... [--framework <f>]... Metadata filters applied before planning
    [--trials <n>]                        Trials per eval × experiment pair (default: 3)
    [--egress-proxy]                      Route container egress through the per-run allowlist proxy
    [--db <path>] [--results <dir>]       Stores (default: results.db, results/)
  quickstudy clean                        Remove all quickstudy-labeled containers and networks
  quickstudy images build [--pull]        Build the agent-runtime, egress-proxy and mcp-proxy images
    [--images-dir <dir>]                  Build from this checkout's Dockerfiles instead of the embedded copies
  quickstudy report <run-id>              Build report.json for a run and print the text report
    [--latest]                            Report the most recent run instead of naming one
    [--json]                              Print report.json instead of the text report
    [--strict]                            Exit non-zero when incomplete or any attempt errored (CI/publication)
    [--db <path>] [--results <dir>]       Stores (default: results.db, results/)
  quickstudy diagnose <run-id>            LLM-diagnose a run's failing pairs into diagnosis.json
    [--latest]                            Diagnose the most recent run instead of naming one
    [--db <path>] [--results <dir>]       Stores (default: results.db, results/)
  quickstudy export <run-id>...           Materialize a run as a self-contained static site
    [--runs <a,b|all>]                    More run ids (comma-separated), or "all" for every run in the DB
    [--out <dir>]                         Output directory (default: ./site)
    [--db <path>] [--results <dir>]       Stores (default: results.db, results/)
  quickstudy ui                           Export to a temp dir and serve the UI locally
    [--runs <a,b>]                        Runs to include (default: every run in the DB)
    [--port <n>]                          Listen port (default: 4173)
    [--watch]                             Re-export when the results DB changes
    [--db <path>] [--results <dir>]       Stores (default: results.db, results/)
`;

const COMMAND_HELP: Record<string, string> = {
  validate: `Usage: quickstudy validate [--evals-root <dir>] [--experiments-root <dir>]\n\nDiscover and validate the evals root (frontmatter, scorer default exports)\nand the experiments root (defineExperiment shapes, comparison groups).\nDefaults: evals, experiments.`,
  run: `Usage: quickstudy run [--eval <id>...] [--experiment <id>...] [options]\n\nExecute the selected eval × experiment pairs. Omit --eval to select every\ndiscovered eval; omit --experiment to select every discovered experiment.\n\nOptions:\n  --eval <id>... --experiment <id>...\n  --evals-root <dir> --experiments-root <dir>   (defaults: evals, experiments)\n  --suite <s>... --framework <f>...\n  --trials <n> --egress-proxy\n  --db <path> --results <dir>`,
  report: `Usage: quickstudy report <run-id> [options]\n\nBuild report.json into the results dir and print the text report\n(pass \`--latest\` to pick the most recent run; \`--json\` prints the JSON).\n\nOptions:\n  --latest --json --strict\n  --strict exits non-zero for incomplete runs or any attempt error\n  --db <path> --results <dir>`,
  diagnose: `Usage: quickstudy diagnose <run-id> [options]\n\nSend each failing (eval × experiment) pair's harness-selected evidence to a\nstructured model call and write diagnosis.json beside report.json\n(pass \`--latest\` to pick the most recent run). Findings are hypotheses with\nevidence links — never verdicts. Requires ANTHROPIC_API_KEY; override the\nanalyst model with QUICKSTUDY_ANALYST_MODEL.\n\nOptions:\n  --latest\n  --db <path> --results <dir>`,
  clean: `Usage: quickstudy clean\n\nRemove quickstudy-labeled containers, networks, and sidecars.`,
  export: `Usage: quickstudy export <run-id>... [options]\n\nBuild a self-contained static site.\n\nOptions:\n  --runs <a,b|all> --out <dir> --db <path> --results <dir>`,
  ui: `Usage: quickstudy ui [options]\n\nExport stored runs to a temporary directory and serve the local UI.\n\nOptions:\n  --runs <a,b> --port <n> --watch --db <path> --results <dir>`,
};

const IMAGES_HELP = `Usage: quickstudy images <command>\n\nCommands:\n  build    Build the agent runtime, egress proxy, and MCP proxy images.\n\nRun \`quickstudy images build --help\` for build options.`;
const IMAGES_BUILD_HELP = `Usage: quickstudy images build [--pull] [--images-dir <dir>]\n\nBuild all quickstudy runtime and proxy images. --pull refreshes base images; --images-dir uses contexts from a checkout.`;

function helpRequested(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function fail(message: string): never {
  console.error(`quickstudy: ${message}`);
  process.exit(1);
}

async function commandValidate(args: string[]): Promise<void> {
  let values: { "evals-root": string; "experiments-root": string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        "evals-root": { type: "string", default: "evals" },
        "experiments-root": { type: "string", default: "experiments" },
      },
    }));
  } catch (err) {
    fail(`validate: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
  if (positionals.length > 0) {
    fail(
      `validate: unexpected argument "${positionals[0]}" — validate takes no positionals; ` +
        `point --evals-root/--experiments-root at your directories instead`,
    );
  }

  const evalsRoot = values["evals-root"];
  const experimentsRoot = values["experiments-root"];
  const haveEvals = existsSync(evalsRoot) && statSync(evalsRoot).isDirectory();
  const haveExperiments = existsSync(experimentsRoot) && statSync(experimentsRoot).isDirectory();
  if (!haveEvals && !haveExperiments) {
    fail(
      `validate: neither an evals root ("${evalsRoot}") nor an experiments root ` +
        `("${experimentsRoot}") exists\n\n${USAGE}`,
    );
  }
  if (haveEvals) {
    const evals = discoverEvals(evalsRoot);
    // A missing/non-function default export is a validation error HERE, not
    // at attempt time.
    for (const loaded of evals) await importEvalScorer(loaded.scorerPath);
    console.log(`evals root "${evalsRoot}" is valid`);
    console.log(`  evals: ${evals.length}`);
    for (const loaded of evals) {
      const meta = loaded.metadata;
      console.log(
        `    - ${meta.id} (suite: ${meta.suite}` +
          `${meta.product !== undefined ? `; product: ${meta.product}` : ""}` +
          `${meta.framework !== undefined ? `; framework: ${meta.framework}` : ""}` +
          `${loaded.localDir !== null ? "; local/" : ""})`,
      );
    }
  }
  if (haveExperiments) {
    const experiments = await discoverExperiments(experimentsRoot);
    console.log(`experiments root "${experimentsRoot}" is valid`);
    console.log(`  experiments: ${experiments.length}`);
    for (const { experiment } of experiments) {
      console.log(
        `    - ${experiment.id} (agent: ${experiment.agent.adapter}; runtime: ${experiment.runtime.kind}` +
          `${experiment.treatment !== undefined ? `; treatment: ${experiment.treatment}` : ""}` +
          `${experiment.comparisonGroup !== undefined ? `; group: ${experiment.comparisonGroup}` : ""})`,
      );
    }
    // Comparison groups: agreement is checked here so an author sees a
    // withheld group at validate time, not after a paid run. Never an error —
    // withhold-and-diff, by design.
    const groups = compareGroups(
      experiments.map((entry) => entry.experiment),
      buildRunManifest({ evals: [], experiments }),
    );
    if (groups.length > 0) {
      console.log(`  comparison groups: ${groups.length}`);
      for (const group of groups) {
        console.log(`    - ${group.group}: ${group.experimentIds.join(", ")} (comparison ${group.comparison})`);
        for (const detail of group.details) console.log(`        ${detail}`);
      }
    }
  }
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) fail(`${flag} must be an integer >= 1, got "${value}"`);
  return parsed;
}

/** The run path: discover, filter, plan, execute, persist, summarize. */
async function commandRun(args: string[]): Promise<void> {
  let values: RunFlags;
  try {
    values = parseRunFlags(args);
  } catch (err) {
    fail(`run: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
  const trials = parsePositiveInt(values.trials, "--trials");
  const evalsRoot = values["evals-root"];
  const experimentsRoot = values["experiments-root"];

  let evals;
  try {
    evals = discoverEvals(evalsRoot);
  } catch (err) {
    if (err instanceof Error && /is not a directory/.test(err.message)) {
      fail(`run: ${err.message} (point --evals-root at your evals directory)`);
    }
    throw err;
  }
  let experiments;
  try {
    experiments = await discoverExperiments(experimentsRoot);
  } catch (err) {
    if (err instanceof Error && /is not a directory/.test(err.message)) {
      fail(`run: ${err.message} (point --experiments-root at your experiments directory)`);
    }
    throw err;
  }

  const evalSelection = values.eval ?? [];
  for (const id of evalSelection) {
    if (!evals.some((entry) => entry.metadata.id === id)) {
      fail(`run: no eval "${id}" under ${evalsRoot} (available: ${evals.map((entry) => entry.metadata.id).join(", ") || "none"})`);
    }
  }
  if (evalSelection.length > 0) evals = evals.filter((entry) => evalSelection.includes(entry.metadata.id));

  const experimentSelection = values.experiment ?? [];
  for (const id of experimentSelection) {
    if (!experiments.some((entry) => entry.experiment.id === id)) {
      fail(
        `run: no experiment "${id}" under ${experimentsRoot} ` +
          `(available: ${experiments.map((entry) => entry.experiment.id).join(", ") || "none"})`,
      );
    }
  }
  if (experimentSelection.length > 0) {
    experiments = experiments.filter((entry) => experimentSelection.includes(entry.experiment.id));
  }

  // Metadata filters apply to the eval list BEFORE planning.
  evals = filterEvals(evals, {
    ...(values.suite ? { suites: values.suite } : {}),
    ...(values.framework ? { frameworks: values.framework } : {}),
  });

  const plan = planRun(evals, experiments.map((entry) => entry.experiment), trials);
  if (plan.length === 0) {
    fail(`run: nothing to run — the selection matched ${evals.length} eval(s) and ${experiments.length} experiment(s)`);
  }

  const store = new ResultsStore(values.db);
  const artifacts = new ArtifactsStore(values.results);
  try {
    const summary = await executeRunV3({
      evals,
      experiments,
      plan,
      store,
      artifacts,
      egressProxy: values["egress-proxy"],
      config: { trials, evalsRoot, experimentsRoot },
    });
    console.log(
      `run ${summary.runId}: ${summary.total} attempts — ${summary.passed} passed, ${summary.failed} failed, ` +
        `${summary.incomplete} incomplete, ${summary.errors} errored`,
    );
    console.log(`  results: ${values.db} + ${values.results}/${summary.runId}/`);
    if (summary.errors > 0) process.exitCode = 1;
  } finally {
    store.close();
  }
}

async function commandReport(args: string[]): Promise<void> {
  let values: ReportFlags;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        latest: { type: "boolean", default: false },
        db: { type: "string", default: "results.db" },
        results: { type: "string", default: "results" },
      },
    }));
  } catch (err) {
    fail(`report: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }

  const requestedRunId = positionals[0];
  if (!requestedRunId && !values.latest) fail(`report: missing <run-id> (or pass --latest)\n\n${USAGE}`);

  const store = new ResultsStore(values.db);
  try {
    let runId = requestedRunId;
    if (values.latest) {
      const latest = store.latestRun();
      if (latest === null) {
        // Zero-state, not an error: an empty database is a valid starting point.
        console.log("this results database has no runs yet — run `quickstudy run --eval <id> --experiment <id>` first");
        return;
      }
      runId = latest.id;
    }

    const report: ReportJson = buildReport({ store, runId: runId as string, resultsDir: values.results });
    const path = writeReportJson(report, values.results);
    console.log(values.json ? JSON.stringify(report, null, 2) : renderReportText(report));
    console.error(`report written: ${path}`);
    if (values.strict) {
      const problems = [
        ...(report.incomplete ? ["incomplete"] : []),
        ...(report.totals.errors > 0
          ? [`contains ${report.totals.errors} attempt error${report.totals.errors === 1 ? "" : "s"}`]
          : []),
      ];
      if (problems.length > 0) fail(`run ${report.run.id} is not publishable: ${problems.join("; ")} (--strict)`);
    }
  } finally {
    store.close();
  }
}

interface DiagnoseFlags {
  latest: boolean;
  db: string;
  results: string;
}

/**
 * The explicitly separate, key-gated, token-spending step: report stays
 * offline, diagnose calls the model. A thin flag-parser over `runDiagnose` —
 * the engine (including `--latest` resolution) is the testable surface.
 */
async function commandDiagnose(args: string[]): Promise<void> {
  let values: DiagnoseFlags;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        latest: { type: "boolean", default: false },
        db: { type: "string", default: "results.db" },
        results: { type: "string", default: "results" },
      },
    }));
  } catch (err) {
    fail(`diagnose: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }

  const requestedRunId = positionals[0];
  if (!requestedRunId && !values.latest) fail(`diagnose: missing <run-id> (or pass --latest)\n\n${USAGE}`);

  // Key preflight FIRST — before any store read, and long before any spend.
  collectProviderKeys([{ name: "diagnose", requiredHostEnv: ["ANTHROPIC_API_KEY"] }]);

  const store = new ResultsStore(values.db);
  try {
    if (values.latest && store.latestRun() === null) {
      // Zero-state, not an error: an empty database is a valid starting point.
      console.log("this results database has no runs yet — run `quickstudy run --eval <id> --experiment <id>` first");
      return;
    }
    const diagnosis = await runDiagnose({
      store,
      resultsDir: values.results,
      ...(values.latest ? {} : { runId: requestedRunId as string }),
      client: new AnthropicModelClient(),
      log: (line) => console.error(line),
    });
    console.log(renderDiagnosisText(diagnosis, values.results));
    console.error(`diagnosis written: ${diagnosisJsonPath(values.results, diagnosis.run_id)}`);
    if (diagnosis.pairs_diagnosed === 0 && diagnosis.errors.length > 0) {
      fail(
        `every diagnosable pair failed to diagnose (${diagnosis.errors.length} error(s)) — ` +
          `the errors are recorded in diagnosis.json`,
      );
    }
  } finally {
    store.close();
  }
}

async function commandClean(): Promise<void> {
  if (!(await dockerDaemonReachable())) {
    fail(
      "clean: no Docker daemon reachable — nothing to inspect. " +
        "Start your Docker runtime (Docker Desktop, OrbStack, Colima, …), confirm `docker ps` works, then re-run.",
    );
  }
  // Attempt containers first: a run network cannot be removed while an
  // attempt container is still attached.
  const removed = await removeAttemptContainers();
  const runResources = await removeRunResources();

  const notes = [
    removed > 0 ? `${removed} attempt container(s)` : "",
    runResources.containers > 0 ? `${runResources.containers} sidecar container(s)` : "",
    runResources.networks > 0 ? `${runResources.networks} run network(s)` : "",
  ].filter((note) => note !== "");
  console.log(notes.length === 0 ? "no quickstudy-labeled resources found — already clean" : `removed ${notes.join(", ")}`);
}

async function commandImages(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "--help" || subcommand === "-h") {
    console.log(IMAGES_HELP);
    return;
  }
  if (subcommand !== "build") {
    fail(`images: unknown subcommand "${subcommand ?? ""}" (expected: build)\n\n${USAGE}`);
  }
  if (helpRequested(rest)) {
    console.log(IMAGES_BUILD_HELP);
    return;
  }
  let values: { pull: boolean; "images-dir"?: string };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { pull: { type: "boolean", default: false }, "images-dir": { type: "string" } },
    }));
  } catch (err) {
    fail(`images build: ${err instanceof Error ? err.message : String(err)}\n\n${IMAGES_BUILD_HELP}`);
  }
  if (!(await dockerDaemonReachable())) {
    fail(
      "images build: no Docker daemon reachable. " +
        "Start your Docker runtime (Docker Desktop, OrbStack, Colima, …), confirm `docker ps` works, then re-run.",
    );
  }
  const imagesRoot = values["images-dir"];
  try {
    const exitCode = await buildAgentRuntimeImage({ pull: values.pull, imagesRoot });
    if (exitCode !== 0) fail(`images build: docker build exited ${exitCode}`);
    const proxyExitCode = await buildEgressProxyImage({ pull: values.pull, imagesRoot });
    if (proxyExitCode !== 0) fail(`images build: egress-proxy docker build exited ${proxyExitCode}`);
    const mcpExitCode = await buildMcpProxyImage({ pull: values.pull, imagesRoot });
    if (mcpExitCode !== 0) fail(`images build: mcp-proxy docker build exited ${mcpExitCode}`);
  } catch (err) {
    // Missing build context (e.g. running the binary outside a checkout).
    fail(`images build: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The prebuilt UI bundle shipped next to the CLI sources (source checkout). */
function uiBundleDir(): string {
  return join(import.meta.dir, "../ui/dist");
}

/**
 * Resolve a directory containing the UI shell (`index.html`).
 *
 * Source checkout: the on-disk `ui/dist` produced by `bun run ui:build`.
 * Compiled binary: `ui/dist` isn't on disk, so materialize the embedded shell
 * (see `ui-bundle.generated.ts`) into a temp dir and return that.
 */
function mustUiBundleDir(): string {
  const bundleDir = uiBundleDir();
  if (existsSync(join(bundleDir, "index.html"))) return bundleDir;

  if (UI_INDEX_HTML_BASE64.length > 0) {
    const dir = mkdtempSync(join(tmpdir(), "quickstudy-ui-"));
    writeFileSync(join(dir, "index.html"), Buffer.from(UI_INDEX_HTML_BASE64, "base64"));
    return dir;
  }

  fail(
    `the UI bundle is not built (expected ${bundleDir}).\n` +
      "Build it once with `bun run ui:build`, then re-run.",
  );
}

/** Positional run ids + comma-separated --runs, de-duplicated in order. */
function collectRunIds(positionals: string[], runsFlag: string | undefined): string[] {
  const ids = [...positionals, ...(runsFlag ?? "").split(",")].map((id) => id.trim()).filter((id) => id !== "");
  return [...new Set(ids)];
}

async function commandExport(args: string[]): Promise<void> {
  let values: { runs?: string; out: string; db: string; results: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        runs: { type: "string" },
        out: { type: "string", default: "site" },
        db: { type: "string", default: "results.db" },
        results: { type: "string", default: "results" },
      },
    }));
  } catch (err) {
    fail(`export: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }

  const bundleDir = mustUiBundleDir();
  const store = new ResultsStore(values.db);
  try {
    // `--runs all`: every run in the DB. Explicit positionals are redundant
    // but harmless (collectRunIds de-duplicates).
    const runIds =
      values.runs === "all"
        ? collectRunIds([...positionals, ...store.listRuns().map((run) => run.id)], undefined)
        : collectRunIds(positionals, values.runs);
    if (runIds.length === 0) {
      const known = store
        .listRuns()
        .slice(0, 5)
        .map((run) => `  ${run.id} (started ${new Date(run.startedAt).toISOString()})`);
      fail(`export: missing <run-id>${known.length > 0 ? `; most recent runs:\n${known.join("\n")}` : " (no runs in this database yet)"}`);
    }
    const summary = await exportSite({
      store,
      resultsDir: values.results,
      runIds,
      outDir: values.out,
      bundleDir,
    });
    console.log(
      `exported ${summary.runs} run(s), ${summary.attempts} attempt(s) -> ${summary.outDir}` +
        (summary.missingAssets > 0 ? ` (${summary.missingAssets} missing artifact(s) skipped)` : ""),
    );
    console.log(`open ${join(summary.outDir, "index.html")} — or host the directory anywhere static`);
  } finally {
    store.close();
  }
}

interface UiFlags {
  runs?: string;
  port: string;
  watch: boolean;
  db: string;
  results: string;
}

async function commandUi(args: string[]): Promise<void> {
  let values: UiFlags;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        runs: { type: "string" },
        port: { type: "string", default: "4173" },
        watch: { type: "boolean", default: false },
        db: { type: "string", default: "results.db" },
        results: { type: "string", default: "results" },
      },
    }));
  } catch (err) {
    fail(`ui: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`ui: --port must be 0-65535, got "${values.port}"`);

  const bundleDir = mustUiBundleDir();
  const requested = collectRunIds([], values.runs);
  const outDir = mkdtempSync(join(tmpdir(), "quickstudy-ui-"));

  const doExport = async (): Promise<void> => {
    const store = new ResultsStore(values.db);
    try {
      const runIds = requested.length > 0 ? requested : store.listRuns().map((run) => run.id);
      if (runIds.length === 0) {
        console.warn(
          "quickstudy: this results database has no runs yet — serving the empty state.\n" +
            "  Get started: quickstudy run --eval <id> --experiment <id>",
        );
      }
      const summary = await exportSite({ store, resultsDir: values.results, runIds, outDir, bundleDir });
      console.log(`exported ${summary.runs} run(s), ${summary.attempts} attempt(s) -> ${outDir}`);
    } finally {
      store.close();
    }
  };

  await doExport();
  const server = serveSite(outDir, port);
  console.log(`quickstudy ui: ${server.url} (Ctrl-C to stop)`);

  if (values.watch) {
    // WAL mode writes land in <db>-wal, so watch the directory and filter by
    // the db basename prefix; debounce bursts into one re-export.
    const dbDir = dirname(resolve(values.db));
    const dbName = basename(values.db);
    let timer: ReturnType<typeof setTimeout> | null = null;
    watch(dbDir, (_event, fileName) => {
      if (fileName === null || !fileName.startsWith(dbName)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        doExport().catch((err: unknown) => {
          console.warn(`quickstudy ui: re-export failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, 400);
    });
    console.log(`watching ${values.db} — the site re-exports on change`);
  }

  // Serve until interrupted.
  await new Promise(() => {});
}

interface ReportFlags {
  json: boolean;
  strict: boolean;
  latest: boolean;
  db: string;
  results: string;
}

interface RunFlags {
  eval?: string[];
  experiment?: string[];
  "evals-root": string;
  "experiments-root": string;
  framework?: string[];
  suite?: string[];
  trials: string;
  "egress-proxy": boolean;
  db: string;
  results: string;
}

function parseRunFlags(args: string[]): RunFlags {
  const { values } = parseArgs({
    args,
    options: {
      eval: { type: "string", multiple: true },
      experiment: { type: "string", multiple: true },
      "evals-root": { type: "string", default: "evals" },
      "experiments-root": { type: "string", default: "experiments" },
      framework: { type: "string", multiple: true },
      suite: { type: "string", multiple: true },
      trials: { type: "string", default: "3" },
      // Off by default until burned in; it becomes the default later, at
      // which point --no-egress-proxy preserves the direct-network mode.
      "egress-proxy": { type: "boolean", default: false },
      db: { type: "string", default: "results.db" },
      results: { type: "string", default: "results" },
    },
  });
  return values;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command !== undefined && command !== "images" && helpRequested(rest)) {
      const help = COMMAND_HELP[command];
      if (help !== undefined) {
        console.log(help);
        return;
      }
    }
    switch (command) {
      case "validate":
        await commandValidate(rest);
        return;
      case "run":
        await commandRun(rest);
        return;
      case "report":
        await commandReport(rest);
        return;
      case "diagnose":
        await commandDiagnose(rest);
        return;
      case "clean":
        await commandClean();
        return;
      case "images":
        await commandImages(rest);
        return;
      case "export":
        await commandExport(rest);
        return;
      case "ui":
        await commandUi(rest);
        return;
      case "version":
      case "--version":
        console.log(EMBEDDED_BUILD_INFO.version);
        return;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return;
      default:
        fail(`unknown command "${command}"\n\n${USAGE}`);
    }
  } catch (err) {
    if (
      err instanceof EvalLoadError ||
      err instanceof ExperimentLoadError ||
      err instanceof MissingProviderKeyError ||
      err instanceof InvalidProviderKeyError ||
      err instanceof ReportError ||
      err instanceof ExportError ||
      err instanceof DiagnoseError ||
      err instanceof ModelOutputError
    ) {
      fail(err.message);
    }
    throw err;
  }
}

await main();
