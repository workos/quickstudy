import { expect, test } from "bun:test";
import { fmtTokens, incompleteReason } from "./format.ts";

test("token counts read at a glance and null stays unavailable", () => {
  expect(fmtTokens(148074667)).toBe("148.1M");
  expect(fmtTokens(1757638)).toBe("1.8M");
  expect(fmtTokens(40900)).toBe("40.9k");
  expect(fmtTokens(512)).toBe("512");
  expect(fmtTokens(0)).toBe("0");
  expect(fmtTokens(null)).toBe("—");
});

test("the incomplete banner names what happened, not a generic cause", () => {
  expect(incompleteReason({ unfinished: false, incomplete: 5, errors: 1, timedOut: 5 })).toBe("5 attempts timed out; 1 attempt errored");
  expect(incompleteReason({ unfinished: false, incomplete: 3, errors: 0, timedOut: 2 })).toBe("2 attempts timed out; 1 attempt incomplete");
  expect(incompleteReason({ unfinished: true, incomplete: 0, errors: 0 })).toBe("the run never finished");
  expect(incompleteReason({ unfinished: false, incomplete: 0, errors: 0 })).toBe("missing trial coverage");
});
