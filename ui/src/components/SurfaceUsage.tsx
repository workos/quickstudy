/**
 * Sanitized developer-surface telemetry. Counts stay visible at a glance;
 * the already-redacted identifiers can be expanded for auditability. The
 * offered channel comes from the experiment's declared treatment — use of a
 * channel the treatment did not offer is flagged as cross-arm use.
 */

import type { ReactNode } from "react";
import type { SurfaceUsage } from "../../../src/surface-usage.ts";
import type { ReportExperimentUsage } from "../../../src/report/report.ts";
import { StatBadge } from "./StatBadge.tsx";

const CHANNELS = ["docs", "mcp", "cli"] as const;
type Channel = (typeof CHANNELS)[number];

function attemptSignal(usage: SurfaceUsage, channel: Channel): { count: number; values: string[] } {
  if (channel === "docs") return { count: usage.docs.count, values: usage.docs.urls };
  if (channel === "mcp") return { count: usage.mcp.count, values: usage.mcp.tools };
  return { count: usage.cli.count, values: usage.cli.commands };
}

const USAGE_HELP =
  "Offered vs. used: the developer surfaces the agent actually reached for during the attempt " +
  "(docs page fetches, MCP tool calls, product CLI commands), extracted from its transcript. " +
  "Blue = the surface this arm's treatment offered; amber = use of a surface it did not offer (cross-arm use). " +
  "Expand “identifiers” to audit the exact sanitized pages, tools, or commands. " +
  "This is the honesty check behind treatment comparisons — a pass that never used its offered surface " +
  "says little about that surface.";

/** A hoverable (?) that explains the block without taking space from it. */
function HelpTip({ text }: { text: string }): ReactNode {
  return (
    <span className="help-tip" title={text} aria-label={text} tabIndex={0} role="note">
      ?
    </span>
  );
}

function Values({ channel, values }: { channel: Channel; values: string[] }): ReactNode {
  if (values.length === 0) return null;
  return (
    <details className="usage-values">
      <summary>{channel} identifiers</summary>
      <ul>
        {values.map((value) => (
          <li key={value}>
            <code>{value}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function AttemptSurfaceUsage({
  treatment,
  usage,
}: {
  /** The experiment's declared treatment (the offered channel), if any. */
  treatment: string | null;
  usage: SurfaceUsage | null;
}): ReactNode {
  if (usage === null) {
    return (
      <div className="surface-usage" data-testid="surface-usage-unavailable">
        <StatBadge tone="gray">surface telemetry unavailable</StatBadge>
      </div>
    );
  }

  const observed = CHANNELS.filter((channel) => attemptSignal(usage, channel).count > 0);
  const contamination = treatment === null ? [] : observed.filter((channel) => channel !== treatment);

  return (
    <div className="surface-usage" data-testid="surface-usage">
      <div className="usage-badges">
        {observed.length === 0 && <StatBadge tone="gray">no configured surface use observed</StatBadge>}
        {observed.map((channel) => {
          const signal = attemptSignal(usage, channel);
          return (
            <StatBadge key={channel} tone={channel === treatment ? "blue" : "amber"}>
              {channel} {signal.count}
            </StatBadge>
          );
        })}
        {contamination.length > 0 && (
          <StatBadge tone="amber">cross-arm use: {contamination.join(", ")}</StatBadge>
        )}
        <HelpTip text={USAGE_HELP} />
      </div>
      {observed.map((channel) => (
        <Values key={channel} channel={channel} values={attemptSignal(usage, channel).values} />
      ))}
    </div>
  );
}

/** The report's per-experiment offered-versus-used rollup. */
export function ExperimentUsageSummary({ usage }: { usage: ReportExperimentUsage }): ReactNode {
  const observed = CHANNELS.filter((channel) => usage.channels[channel].events > 0);
  const contamination =
    usage.treatment === null ? [] : observed.filter((channel) => channel !== usage.treatment);

  return (
    <div className="surface-usage aggregate-usage" data-testid={`usage-${usage.experiment_id}`}>
      <div className="usage-badges">
        <StatBadge tone={usage.telemetry_available > 0 ? "blue" : "gray"}>
          telemetry {usage.telemetry_available} available
        </StatBadge>
        {usage.telemetry_unavailable > 0 && (
          <StatBadge tone="gray">{usage.telemetry_unavailable} unavailable</StatBadge>
        )}
        {observed.map((channel) => {
          const signal = usage.channels[channel];
          return (
            <StatBadge key={channel} tone={channel === usage.treatment ? "blue" : "amber"}>
              {channel} {signal.events} events / {signal.attempts} attempts
            </StatBadge>
          );
        })}
        {contamination.length > 0 && (
          <StatBadge tone="amber">cross-arm use: {contamination.join(", ")}</StatBadge>
        )}
        <HelpTip text={USAGE_HELP} />
      </div>
      {observed.map((channel) => (
        <Values key={channel} channel={channel} values={usage.channels[channel].values} />
      ))}
    </div>
  );
}
