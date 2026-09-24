import { DIAGNOSIS_TARGETS, type DiagnosisFinding, type DiagnosisTarget } from "../../src/diagnose/types.ts";
import type { ReportPair } from "../../src/report/report.ts";
import { isGraded } from "./checks.ts";

/**
 * Pure grouping for the Diagnosis view. `DiagnosisFinding` carries no check
 * name, so each finding's failing-check set is joined from the run's
 * `report.pairs[].checks` on `(eval_id, experiment_id)`. No DOM, no React.
 */
export interface FindingCluster {
  evalId: string;
  /** Sorted failing graded check names for the pairs the findings cite; [] when the report has none. */
  failingChecks: string[];
  findings: DiagnosisFinding[];
  /** Experiments among the cluster's findings. */
  experiments: string[];
}

/** Share of findings at which `eval-defect` leads the target order. */
const EVAL_DEFECT_LEAD_SHARE = 0.25;

function pairKey(evalId: string, experimentId: string): string {
  return `${evalId}\u0000${experimentId}`;
}

/** Sorted failing graded check names per pair (`passed < total`; ungraded misses excluded). */
function failingChecksByPair(pairs: ReportPair[]): Map<string, string[]> {
  const byPair = new Map<string, string[]>();
  for (const pair of pairs) {
    const failing = (pair.checks ?? [])
      .filter((check) => isGraded(check) && check.passed < check.total)
      .map((check) => check.name)
      .sort();
    byPair.set(pairKey(pair.eval_id, pair.experiment_id), failing);
  }
  return byPair;
}

/**
 * Group findings by `(eval_id, failing checks)`, largest cluster first, then
 * by eval id. Findings keep document order inside a cluster. Without a report
 * (`null`) — or for a pair the report lacks — the failing-check set is empty,
 * so clusters fall back to one per eval id.
 */
export function clusterFindings(findings: DiagnosisFinding[], pairs: ReportPair[] | null): FindingCluster[] {
  const failing = pairs === null ? new Map<string, string[]>() : failingChecksByPair(pairs);
  const clusters = new Map<string, FindingCluster>();
  for (const finding of findings) {
    const failingChecks = failing.get(pairKey(finding.eval_id, finding.experiment_id)) ?? [];
    const key = `${finding.eval_id}\u0000${failingChecks.join(",")}`;
    let cluster = clusters.get(key);
    if (cluster === undefined) {
      cluster = { evalId: finding.eval_id, failingChecks, findings: [], experiments: [] };
      clusters.set(key, cluster);
    }
    cluster.findings.push(finding);
    if (!cluster.experiments.includes(finding.experiment_id)) cluster.experiments.push(finding.experiment_id);
  }
  return [...clusters.values()].sort(
    (a, b) =>
      b.findings.length - a.findings.length ||
      (a.evalId < b.evalId ? -1 : a.evalId > b.evalId ? 1 : 0) ||
      (a.failingChecks.join(",") < b.failingChecks.join(",") ? -1 : 1),
  );
}

/** DIAGNOSIS_TARGETS order, with "eval-defect" moved first when it is >= 25% of findings. */
export function targetOrder(findings: DiagnosisFinding[]): DiagnosisTarget[] {
  const defects = findings.filter((finding) => finding.target === "eval-defect").length;
  if (findings.length === 0 || defects / findings.length < EVAL_DEFECT_LEAD_SHARE) return [...DIAGNOSIS_TARGETS];
  return ["eval-defect", ...DIAGNOSIS_TARGETS.filter((target) => target !== "eval-defect")];
}
