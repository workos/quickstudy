#!/usr/bin/env bun
/**
 * Single-attempt playground harness: run ONE eval × experiment attempt
 * through the v3 runner.
 *
 *   bun scripts/dev-attempt.ts --eval <id> --experiment <id>
 *   bun scripts/dev-attempt.ts --eval <id> --experiment <id> --egress-proxy
 *
 * Results land in dev-results.db + dev-results/ (never the real stores).
 * Attempt containers are torn down after scoring; `quickstudy clean` sweeps
 * anything a crashed run left behind.
 */

import { parseArgs } from "node:util";
import { discoverEvals } from "../src/evals/discovery.ts";
import { discoverExperiments } from "../src/experiments/discovery.ts";
import { dockerDaemonReachable, imageExists } from "../src/isolation/docker.ts";
import { EGRESS_PROXY_IMAGE } from "../src/isolation/images.ts";
import { planRun } from "../src/plan.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore } from "../src/store/db.ts";

const { values } = parseArgs({
  options: {
    eval: { type: "string" },
    experiment: { type: "string" },
    "evals-root": { type: "string", default: "evals" },
    "experiments-root": { type: "string", default: "experiments" },
    /** Route the attempt's egress through the per-run allowlist proxy. */
    "egress-proxy": { type: "boolean", default: false },
    /** Attempt timeout (default: the runner's 10 minutes). */
    "timeout-min": { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    "usage: bun scripts/dev-attempt.ts --eval <id> --experiment <id> " +
      "[--evals-root <dir>] [--experiments-root <dir>] [--egress-proxy] [--timeout-min <n>]\n\n" +
      "Runs exactly one trial of one eval × experiment pair through the v3 runner.\n" +
      "Model/reasoning pins live in the experiment module itself.\n" +
      "Results land in dev-results.db + dev-results/ — never the real stores.",
  );
  process.exit(0);
}

function die(message: string): never {
  console.error(`dev-attempt: ${message}`);
  process.exit(1);
}

if (!values.eval) die(`missing --eval (an eval id under ${values["evals-root"]}/)`);
if (!values.experiment) die(`missing --experiment (an experiment id under ${values["experiments-root"]}/)`);

let evals = discoverEvals(values["evals-root"]);
const selectedEval = evals.find((entry) => entry.metadata.id === values.eval);
if (!selectedEval) {
  die(`no eval "${values.eval}" under ${values["evals-root"]} (available: ${evals.map((entry) => entry.metadata.id).join(", ") || "none"})`);
}
evals = [selectedEval];

const experiments = await discoverExperiments(values["experiments-root"]);
const selected = experiments.find((entry) => entry.experiment.id === values.experiment);
if (!selected) {
  die(
    `no experiment "${values.experiment}" under ${values["experiments-root"]} ` +
      `(available: ${experiments.map((entry) => entry.experiment.id).join(", ") || "none"})`,
  );
}

if (selected.experiment.runtime.kind === "container") {
  if (!(await dockerDaemonReachable())) die("no Docker daemon reachable — start Docker and re-run");
  const runtime = selected.experiment.runtime;
  const image = runtime.image ?? runtime.containerImage?.(selectedEval.metadata);
  if (image !== undefined && image !== "" && !(await imageExists(image))) {
    die(`image "${image}" not found — build it (base images: \`bun src/cli.ts images build\`)`);
  }
  if (values["egress-proxy"] && !(await imageExists(EGRESS_PROXY_IMAGE))) {
    die(`--egress-proxy needs the "${EGRESS_PROXY_IMAGE}" image — build it with \`bun src/cli.ts images build\``);
  }
}

let timeoutMin: number | undefined;
if (values["timeout-min"] !== undefined) {
  timeoutMin = Number(values["timeout-min"]);
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) die(`--timeout-min must be a positive number`);
}

console.log(
  `dev-attempt: ${selectedEval.metadata.id} × ${selected.experiment.id} ` +
    `(agent: ${selected.experiment.agent.adapter}; runtime: ${selected.experiment.runtime.kind}; ` +
    `egress proxy: ${values["egress-proxy"]})`,
);

const store = new ResultsStore("dev-results.db");
const artifacts = new ArtifactsStore("dev-results");
try {
  const summary = await executeRunV3({
    evals,
    experiments: [selected],
    plan: planRun(evals, [selected.experiment], 1),
    store,
    artifacts,
    egressProxy: values["egress-proxy"],
    ...(timeoutMin !== undefined ? { attemptTimeoutMs: timeoutMin * 60 * 1000 } : {}),
    log: (message) => console.log(`  ${message}`),
  });
  const attempt = store.listAttempts(summary.runId)[0];
  console.log(
    `result: ${summary.passed} passed / ${summary.failed} failed / ${summary.incomplete} incomplete / ${summary.errors} errored`,
  );
  if (attempt) {
    console.log(`  attempt:    ${attempt.id} (${attempt.status})`);
    // null = telemetry unavailable (vendor stream omitted usage) — never "0".
    const tel = (value: number | null): string => (value === null ? "unavailable" : String(value));
    console.log(
      `  telemetry:  tokensIn=${tel(attempt.tokensIn)} tokensOut=${tel(attempt.tokensOut)}` +
        `${attempt.costUsd === null ? "" : ` costUsd=${attempt.costUsd}`}`,
    );
    console.log(`  artifacts:  dev-results/${summary.runId}/${attempt.id}/`);
    if (attempt.result) {
      console.log(
        `  checks:     ${attempt.result.checks.map((check) => `${check.name}=${check.passed ? "pass" : "fail"}`).join(" ")}`,
      );
    }
    if (attempt.error) console.log(`  error:      ${attempt.error}`);
  }
  if (summary.errors > 0) process.exitCode = 1;
} finally {
  store.close();
}
