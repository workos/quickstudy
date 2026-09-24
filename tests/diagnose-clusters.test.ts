/**
 * Report honesty: last-marker excerpt anchoring, diagnosis clustering by
 * (eval, failing graded checks), and eval-defect-first target ordering.
 */

import { describe, expect, test } from "bun:test";
import { EXCERPT_TAIL_LINES, excerptTranscript } from "../src/diagnose/excerpt.ts";
import { DIAGNOSIS_TARGETS, type DiagnosisFinding, type DiagnosisTarget } from "../src/diagnose/types.ts";
import type { ReportCheck, ReportPair } from "../src/report/report.ts";
import { clusterFindings, targetOrder } from "../ui/src/diagnosis-clusters.ts";

/** A transcript of `total` lines with ERROR_MARKER hits on the given 1-indexed lines. */
function transcript(total: number, markerLines: number[]): string {
  const markers = new Set(markerLines);
  return Array.from({ length: total }, (_, i) => (markers.has(i + 1) ? `${i + 1} error: boom` : `${i + 1} ok`)).join(
    "\n",
  );
}

describe("excerpt", () => {
  test("an early false positive does not pin the window to the head", () => {
    const excerpt = excerptTranscript(transcript(600, [2, 500]));
    expect(excerpt.lines).toEqual([496, 504]);
  });

  test("a nearby earlier marker joins the last cluster", () => {
    const excerpt = excerptTranscript(transcript(600, [2, 480, 500]));
    expect(excerpt.lines).toEqual([476, 504]);
    expect(excerpt.lines[1] - excerpt.lines[0] + 1).toBeLessThanOrEqual(40);
  });

  test("an earlier marker that does not fit the window is excluded", () => {
    const excerpt = excerptTranscript(transcript(600, [2, 400, 500]));
    expect(excerpt.lines).toEqual([496, 504]);
    expect(excerpt.text).not.toContain("400 error");
  });

  test("no markers falls back to the tail", () => {
    const excerpt = excerptTranscript(transcript(600, []));
    expect(excerpt.lines).toEqual([600 - EXCERPT_TAIL_LINES + 1, 600]);
  });

  test("a single marker at line 1 clamps at the head", () => {
    const excerpt = excerptTranscript(transcript(600, [1]));
    expect(excerpt.lines).toEqual([1, 5]);
  });
});

function finding(evalId: string, experimentId: string, target: DiagnosisTarget = "docs"): DiagnosisFinding {
  return {
    eval_id: evalId,
    experiment_id: experimentId,
    target,
    claim: `${evalId} ${experimentId} claim`,
    suggested_change: "change",
    confidence: "medium",
    evidence: [],
  };
}

function pair(evalId: string, experimentId: string, checks: ReportCheck[]): ReportPair {
  return { eval_id: evalId, experiment_id: experimentId, checks } as unknown as ReportPair;
}

const check = (name: string, passed: number, total: number, graded = true): ReportCheck => ({
  name,
  passed,
  total,
  graded,
});

describe("clusters", () => {
  const findings = [
    finding("beta", "exp-a"),
    finding("alpha", "exp-a"),
    finding("alpha", "exp-b"),
    finding("beta", "exp-b"),
    finding("alpha", "exp-c"),
    finding("alpha", "exp-a", "mcp"),
  ];
  const pairs = [
    pair("alpha", "exp-a", [check("shape", 0, 3), check("style", 3, 3), check("recall", 0, 3, false)]),
    pair("alpha", "exp-b", [check("shape", 1, 3)]),
    pair("alpha", "exp-c", [check("shape", 2, 3), check("style", 3, 3)]),
    pair("beta", "exp-a", [check("build", 0, 3)]),
    pair("beta", "exp-b", [check("build", 1, 3), check("lint", 3, 3)]),
  ];

  test("groups by eval and failing graded checks, largest first", () => {
    const clusters = clusterFindings(findings, pairs);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.evalId).toBe("alpha");
    expect(clusters[0]?.failingChecks).toEqual(["shape"]);
    expect(clusters[0]?.findings).toHaveLength(4);
    expect(clusters[0]?.experiments).toEqual(["exp-a", "exp-b", "exp-c"]);
    // Document order is preserved inside a cluster.
    expect(clusters[0]?.findings.map((f) => f.target)).toEqual(["docs", "docs", "docs", "mcp"]);
    expect(clusters[1]).toMatchObject({ evalId: "beta", failingChecks: ["build"], experiments: ["exp-a", "exp-b"] });
    expect(clusters[1]?.findings).toHaveLength(2);
  });

  test("without a report, clusters are per eval id with no checks", () => {
    const clusters = clusterFindings(findings, null);
    expect(clusters.map((c) => [c.evalId, c.findings.length, c.failingChecks])).toEqual([
      ["alpha", 4, []],
      ["beta", 2, []],
    ]);
  });

  test("a finding whose pair is absent from the report has no failing checks", () => {
    const clusters = clusterFindings([finding("gamma", "exp-a")], pairs);
    expect(clusters).toEqual([
      { evalId: "gamma", failingChecks: [], findings: [finding("gamma", "exp-a")], experiments: ["exp-a"] },
    ]);
  });
});

describe("target order", () => {
  test("eval-defect leads at >= 25% of findings", () => {
    const six = [
      finding("a", "x", "eval-defect"),
      finding("a", "y", "eval-defect"),
      finding("a", "z"),
      finding("b", "x"),
      finding("b", "y", "mcp"),
      finding("b", "z", "cli"),
    ];
    const order = targetOrder(six);
    expect(order[0]).toBe("eval-defect");
    expect(order).toHaveLength(DIAGNOSIS_TARGETS.length);
  });

  test("below 25% the default order holds", () => {
    const six = [
      finding("a", "x", "eval-defect"),
      finding("a", "y"),
      finding("a", "z"),
      finding("b", "x"),
      finding("b", "y", "mcp"),
      finding("b", "z", "cli"),
    ];
    expect(targetOrder(six)).toEqual([...DIAGNOSIS_TARGETS]);
  });
});
