import type { ReactNode } from "react";
import type { RunCostEstimate } from "../../../src/report/costs.ts";

/** Separate from reported spend; absent on exports created without a pricing snapshot. */
export function CostEstimate({ estimate }: { estimate?: RunCostEstimate }): ReactNode {
  if (estimate === undefined) return null;
  return (
    <div className="kpi" data-testid="cost-estimate">
      <div className="kpi-label">Estimated token cost</div>
      <div className="kpi-val">{estimate.cost_usd === null ? "—" : `$${estimate.cost_usd.toFixed(2)}`}</div>
      <div className="kpi-meta">
        In addition to reported cost · {estimate.cost_attempts} estimated, {estimate.unpriced_attempts} unpriced attempt(s)
      </div>
      <div className="kpi-meta">Pricing: {estimate.pricing.version}. Excludes tool fees, diagnosis, infrastructure and superseded retries.</div>
    </div>
  );
}
