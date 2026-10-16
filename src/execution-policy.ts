import type { LoadedEval } from "./evals/types.ts";
import type { LoadedExperiment } from "./experiments/types.ts";
import type { RuntimeImageIdentity } from "./manifest.ts";
import { composeAllowlistFromHosts } from "./isolation/proxy/allowlist.ts";
import type { WebPolicy } from "./runtime/types.ts";

export interface LifecycleBudgets {
  provisionMs: number;
  agentMs: number;
  scoreMs: number;
  exportMs: number;
  cleanupMs: number;
}
export const DEFAULT_BUDGETS: LifecycleBudgets = {
  provisionMs: 120_000,
  agentMs: 600_000,
  scoreMs: 180_000,
  exportMs: 60_000,
  cleanupMs: 30_000,
};
export interface PairEnvironment {
  image: RuntimeImageIdentity | null;
  egress: { proxy: boolean; allowlist: string[] };
  webPolicy: WebPolicy;
  pathTreatment: string | null;
  mcp: string | null;
  /** Runtime text prepended to the eval prompt for this pair (null = prompt verbatim). */
  promptPreamble: string | null;
  budgets: LifecycleBudgets;
  /**
   * The agent's endpoint overrides in force (non-secret base URLs, e.g.
   * OPENAI_BASE_URL → an LLM gateway route), recorded in full so a changed
   * route changes identity and a resume cannot mix routes. Absent when the
   * agent runs vendor-direct — such pairs hash exactly as before.
   */
  endpoints?: Record<string, string>;
}

/** The prompt an agent receives: the runtime's preamble (if any), a blank line, the eval's verbatim body. */
export function composePrompt(preamble: string | null | undefined, body: string): string {
  const text = preamble?.trim() ?? "";
  return text === "" ? body : `${text}\n\n${body}`;
}
export function pairKey(evalId: string, experimentId: string): string {
  return JSON.stringify([evalId, experimentId]);
}
export function resolvePairEnvironments(options: {
  evals: LoadedEval[];
  experiments: LoadedExperiment[];
  images?: Record<string, RuntimeImageIdentity>;
  egressProxy?: boolean;
  adapterHosts?: Record<string, readonly string[]>;
  /** Per experiment: the agent's non-secret endpoint overrides (see PairEnvironment.endpoints). */
  adapterEndpoints?: Record<string, Record<string, string>>;
  budgets?: Partial<LifecycleBudgets>;
  mcpHashes?: Record<string, string>;
  imageTags?: Record<string, string>;
}): Record<string, PairEnvironment> {
  const budgets = { ...DEFAULT_BUDGETS, ...options.budgets };
  for (const [name, value] of Object.entries(budgets))
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid lifecycle budget ${name}`);
  const pairs: Record<string, PairEnvironment> = {};
  for (const loaded of options.evals)
    for (const { experiment } of options.experiments) {
      const runtime = experiment.runtime;
      const tag =
        options.imageTags?.[pairKey(loaded.metadata.id, experiment.id)] ??
        runtime.image ??
        runtime.containerImage?.(loaded.metadata);
      pairs[pairKey(loaded.metadata.id, experiment.id)] = {
        image: tag ? (options.images?.[tag] ?? { tag, id: "unresolved", repoDigests: [] }) : null,
        // With the flag, every container is proxied. No runtime hosts means
        // only the adapter's provider endpoints are permitted.
        egress: {
          proxy: runtime.kind === "container" && (options.egressProxy ?? false),
          allowlist: composeAllowlistFromHosts([
            ...(runtime.egressHosts?.(loaded.metadata) ?? []),
            ...(options.adapterHosts?.[experiment.id] ?? []),
          ]),
        },
        webPolicy: runtime.webPolicy?.() ?? "native-web-blocked",
        pathTreatment: runtime.pathTreatment?.() ?? null,
        mcp: options.mcpHashes?.[experiment.id] ?? null,
        promptPreamble: (() => {
          const text = runtime.promptPreamble?.(loaded.metadata)?.trim() ?? "";
          return text === "" ? null : text;
        })(),
        budgets: { ...budgets },
        ...(() => {
          const endpoints = options.adapterEndpoints?.[experiment.id];
          return endpoints !== undefined && Object.keys(endpoints).length > 0 ? { endpoints: { ...endpoints } } : {};
        })(),
      };
    }
  return pairs;
}
