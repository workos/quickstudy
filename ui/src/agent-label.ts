/**
 * Display labels for pinned agent identity (manifest components.agent).
 *
 * The comparison-group NAME is an operator-chosen string (often the agent
 * CLI); the interesting axis is the pinned model. These helpers derive
 * "model (reasoning)" labels from the manifest identity so views can lead
 * with the model and demote the group name to context.
 */

import type { DataRun } from "../../src/export-types.ts";

/** The manifest's explicit missing-value sentinel (never displayed). */
const UNSPECIFIED = "unspecified";

/** "model (reasoning)" from raw pins; null when no model was pinned. */
export function formatAgentLabel(model: string, reasoning: string): string | null {
  if (model === UNSPECIFIED) return null;
  return reasoning === UNSPECIFIED ? model : `${model} (${reasoning})`;
}

/** "model · reasoning" from a report agent identity; "model unpinned" when no model was pinned. */
export function modelLabel(agent: { model: string; reasoning: string }): string {
  if (agent.model === UNSPECIFIED) return "model unpinned";
  return agent.reasoning === UNSPECIFIED ? agent.model : `${agent.model} · ${agent.reasoning}`;
}

/** "model (reasoning)" for one experiment; null when no model was pinned. */
export function agentLabelOf(run: DataRun, experimentId: string): string | null {
  const agent = run.manifest.experiments[experimentId]?.components.agent;
  if (agent === undefined) return null;
  return formatAgentLabel(agent.model, agent.reasoning);
}

/** Full identity line for tooltips; null when no model was pinned. */
export function agentTitleOf(run: DataRun, experimentId: string): string | null {
  const agent = run.manifest.experiments[experimentId]?.components.agent;
  if (agent === undefined || agent.model === UNSPECIFIED) return null;
  const parts = [`adapter ${agent.adapter}`, `provider ${agent.provider}`, `model ${agent.model}`];
  if (agent.reasoning !== UNSPECIFIED) parts.push(`reasoning ${agent.reasoning}`);
  if (agent.cliVersion !== UNSPECIFIED) parts.push(`cli ${agent.cliVersion}`);
  return parts.join(" · ");
}

/**
 * The label shared by every member of a group, or null when members disagree
 * (a withheld group may mix models — a single model header would be wrong).
 */
export function sharedAgentLabel(run: DataRun, experimentIds: readonly string[]): string | null {
  const labels = new Set(experimentIds.map((experimentId) => agentLabelOf(run, experimentId)));
  if (labels.size !== 1) return null;
  return [...labels][0] ?? null;
}
