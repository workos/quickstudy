/**
 * Suite tabs on the Matrix view. The view builds its tabs from a hard-coded
 * list, so a suite missing there is invisible even though the report carries
 * it; these pin the list, the hover titles, and the tab/default-suite logic
 * through the exported pure helpers (the view itself loads asynchronously).
 */

import { expect, test } from "bun:test";
import type { DataAttempt } from "../../../src/export-types.ts";
import { availableSuites, resolveSuite, SUITES, SUITE_TITLES } from "./Matrix.tsx";

function attempt(suite: string): Pick<DataAttempt, "suite"> {
  return { suite };
}

test("the suite tabs include discovery, with a title saying it never grades into the headline", () => {
  expect(SUITES).toContain("discovery");
  expect(SUITE_TITLES.discovery).toMatch(/never graded into the headline/);
  for (const suite of SUITES) {
    if (suite !== "benchmark") expect(SUITE_TITLES[suite]).toBeTruthy();
  }
});

test("a run with benchmark and discovery pairs shows both tabs, in tab order", () => {
  const suites = availableSuites([attempt("discovery"), attempt("benchmark"), attempt("discovery")]);
  expect(suites).toEqual(["benchmark", "discovery"]);
  expect(resolveSuite(suites, "benchmark")).toBe("benchmark");
  expect(resolveSuite(suites, "discovery")).toBe("discovery");
});

test("a run with no discovery pair shows no discovery tab", () => {
  const suites = availableSuites([attempt("benchmark"), attempt("regression")]);
  expect(suites).toEqual(["benchmark", "regression"]);
  expect(suites).not.toContain("discovery");
  expect(resolveSuite(suites, "discovery")).toBe("benchmark");
});

test("a discovery-only run lands on the discovery suite and renders no toggle", () => {
  const suites = availableSuites([attempt("discovery")]);
  expect(suites).toEqual(["discovery"]);
  expect(suites).toHaveLength(1);
  expect(resolveSuite(suites, "benchmark")).toBe("discovery");
  expect(resolveSuite([], "benchmark")).toBe("benchmark");
});
