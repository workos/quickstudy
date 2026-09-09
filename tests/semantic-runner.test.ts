import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverEvals } from "../src/evals/discovery.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { ResultsStore } from "../src/store/db.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { buildReport } from "../src/report/report.ts";
import { exportSite } from "../src/export.ts";

test("semantic scoring through the worker records verdicts, instrument errors and separate usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "qs-semantic-run-"));
  const store = new ResultsStore(join(root, "results.db"));
  const artifacts = new ArtifactsStore(join(root, "results"));
  try {
    for (const id of ["pass", "fail", "malformed"]) {
      const dir = join(root, "evals", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "PROMPT.md"), `---\nid: ${id}\nsuite: benchmark\n---\nExplain the result.`);
      writeFileSync(
        join(dir, "EVAL.ts"),
        `import {defineSemanticScorer} from ${JSON.stringify(resolve("src/index.ts"))};
export default defineSemanticScorer({name:"explanation",rubric:"Explain the completed task.",provider:"fake",model:"fake-v1",includeFinalReport:true},async (request)=>({verdict:${id === "malformed" ? '"bad"' : `{passed:${id === "pass"},reason:"assessed",evidence:[request.evidence[0].ref]}`},usage:{tokensIn:20,tokensOut:10,costUsd:0.001}}));`,
      );
    }
    const path = join(root, "experiment.ts");
    writeFileSync(path, "export default {};");
    const evals = discoverEvals(join(root, "evals"));
    const experiments = [
      { path, experiment: { id: "echo", agent: { adapter: "echo" }, runtime: { kind: "host" as const } } },
    ];
    const summary = await executeRunV3({
      evals,
      experiments,
      store,
      artifacts,
      plan: evals.map((e) => ({ evalId: e.metadata.id, experimentId: "echo", trialIndex: 0 })),
      log: () => {},
    });
    expect(summary).toMatchObject({ passed: 1, failed: 1, errors: 1 });
    const error = store.listAttempts(summary.runId).find((a) => a.evalId === "malformed")!;
    expect(error.result).toBeNull();
    expect(error.error).toContain("malformed");
    expect(error.judgeRecords?.[0]?.tokensIn).toBe(20);
    const report = buildReport({ store, runId: summary.runId, resultsDir: artifacts.rootDir });
    expect(report.judge_telemetry).toEqual({
      provenance: "semantic-judge",
      calls: 3,
      tokens_in: 60,
      tokens_out: 30,
      cost_usd: 0.003,
    });
    const identity = store.getRun(summary.runId)!.manifest.evals.pass!.components.scorerConfiguration;
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    const outDir = join(root, "site");
    await exportSite({ store, resultsDir: artifacts.rootDir, runIds: [summary.runId], outDir, log: () => {} });
    const data = JSON.parse(readFileSync(join(outDir, "data/runs", summary.runId, "run.json"), "utf8"));
    expect(data.attempts.find((a: { eval_id: string }) => a.eval_id === "malformed").judgments[0].costUsd).toBe(0.001);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
