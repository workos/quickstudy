import { expect, test } from "bun:test";
import type { ComparisonGroup } from "../../../src/experiments/groups.ts";
import { nNoticeSentences } from "./Compare.tsx";

const group: ComparisonGroup = { group: "g", experimentIds: ["a", "b"], comparison: "allowed", mismatches: [], details: [] };
const EMPTY_ARM = "Some shared evals have an arm with nothing scored; those rows are listed but not comparable.";

test("a shared eval where every arm attempted but none scored still gets the notice", () => {
  const attempted = new Map([["e", new Set(["a", "b"])]]);
  expect(nNoticeSentences(3, [group], new Map(), attempted)).toEqual([EMPTY_ARM]);
});

test("an eval only one member ran is not shared and gets no notice", () => {
  const attempted = new Map([["e", new Set(["a"])]]);
  expect(nNoticeSentences(3, [group], new Map(), attempted)).toEqual([]);
});

test("every arm scored at three trials: no notice", () => {
  const attempted = new Map([["e", new Set(["a", "b"])]]);
  const arms = new Map([["e", new Map([["a", { passed: 1, scored: 3 }], ["b", { passed: 2, scored: 3 }]])]]);
  expect(nNoticeSentences(3, [group], arms, attempted)).toEqual([]);
});
