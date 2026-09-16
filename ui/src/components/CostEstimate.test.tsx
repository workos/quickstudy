import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunCostEstimate } from "../../../src/report/costs.ts";
import { CostEstimate } from "./CostEstimate.tsx";

test("cost estimates disclose coverage, distinguish null from zero, and tolerate old reports", () => {
  const estimate: RunCostEstimate = {
    pricing: { version: "example", currency: "USD", rates: [] },
    cost_usd: 1.25, cost_attempts: 2, unpriced_attempts: 1, attempts: [],
  };
  const html = renderToStaticMarkup(<CostEstimate estimate={estimate} />);
  expect(html).toContain("Estimated token cost");
  expect(html).toContain("$1.25");
  expect(html).toContain("2 estimated, 1 unpriced");
  expect(html).toContain("In addition to reported cost");
  expect(html).toContain("example");
  expect(renderToStaticMarkup(<CostEstimate />)).toBe("");
  expect(renderToStaticMarkup(<CostEstimate estimate={{ ...estimate, cost_usd: null }} />)).not.toContain("$0.00");
  expect(renderToStaticMarkup(<CostEstimate estimate={{ ...estimate, cost_usd: 0 }} />)).toContain("$0.00");
});
