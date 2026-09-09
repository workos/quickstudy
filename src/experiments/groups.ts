/**
 * Comparison groups with withhold-and-diff semantics.
 *
 * Experiments sharing a `comparisonGroup` claim to be treatments of ONE
 * configuration — same agent, same model, same runtime — varying only the
 * declared `treatment`. `compareGroups` checks that claim: members must
 * agree on every identity component EXCEPT the treatment itself and the
 * treatment's own runtime config subtree (by convention
 * `runtime.config[treatment]`).
 *
 * On mismatch the group is marked `comparison: "withheld"` with a
 * component-level diff — the run is NEVER blocked and raw per-experiment
 * results are unaffected. (src/compare.ts is the diff-rendering precedent;
 * its throw-unless---force blocking is deliberately NOT copied here.)
 *
 * Excluded from the comparison by construction:
 *   - `source` — two experiment files always hash differently;
 *   - `treatment` — the declared variation;
 *   - `runtime.config[treatment]` — the treatment's resulting configuration;
 *   - `harness` — equal within one manifest by construction.
 * The manifest's opaque `runtime` hash is replaced by the raw runtime data
 * (kind/image/command/config) so the diff can name the differing key.
 */

import { pairKey } from "../execution-policy.ts";
import { diffIdentity, type IdentityMismatch } from "../identity-diff.ts";
import type { RunManifest } from "../manifest.ts";
import type { Experiment } from "./types.ts";

export interface ComparisonGroup {
  group: string;
  /** Member experiment ids, sorted. */
  experimentIds: string[];
  /** "allowed" = automatic treatment comparison may proceed. */
  comparison: "allowed" | "withheld";
  /** Component-level mismatches (empty when allowed). */
  mismatches: IdentityMismatch[];
  /** Rendered diff lines naming the members and component (empty when allowed). */
  details: string[];
}

/**
 * The comparable view of one experiment: manifest identity components where
 * they are precise (agent fields, resolved image), raw runtime data where
 * the manifest is opaque (a single hash), minus every excluded component.
 */
function comparableView(experiment: Experiment, manifest: RunManifest): Record<string, unknown> {
  const components = manifest.experiments[experiment.id]?.components;
  const config: Record<string, unknown> = { ...experiment.runtime.config };
  if (experiment.treatment !== undefined) delete config[experiment.treatment];
  const environments = Object.fromEntries(Object.keys(manifest.evals).sort().map((evalId) => {
    const value = { ...manifest.pairs?.[pairKey(evalId, experiment.id)] };
    for (const field of experiment.runtime.treatmentPolicyFields ?? []) delete value[field];
    return [evalId, value];
  }));
  return {
    environments,
    treatmentPolicyFields: [...(experiment.runtime.treatmentPolicyFields ?? [])].sort(),
    agent: components?.agent ?? {
      adapter: experiment.agent.adapter,
      provider: experiment.agent.provider ?? "unspecified",
      model: experiment.agent.model ?? "unspecified",
      reasoning: experiment.agent.reasoning ?? "unspecified",
      cliVersion: experiment.agent.cliVersion ?? "unspecified",
    },
    image: components?.image ?? null,
    runtime: {
      kind: experiment.runtime.kind,
      observationTargets: experiment.runtime.observationTargets ?? null,
      image: experiment.runtime.image ?? null,
      command: experiment.runtime.command ?? null,
      config,
    },
  };
}

/**
 * Group experiments by `comparisonGroup` and check treatment comparability.
 * Pure — no store access, never throws, never blocks a run; the report layer
 * consumes its output. Experiments without a group are not compared at all;
 * a singleton group is trivially allowed.
 */
export function compareGroups(experiments: readonly Experiment[], manifest: RunManifest): ComparisonGroup[] {
  const byGroup = new Map<string, Experiment[]>();
  for (const experiment of experiments) {
    if (experiment.comparisonGroup === undefined) continue;
    const members = byGroup.get(experiment.comparisonGroup) ?? [];
    members.push(experiment);
    byGroup.set(experiment.comparisonGroup, members);
  }

  const groups: ComparisonGroup[] = [];
  for (const [group, members] of [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...members].sort((a, b) => a.id.localeCompare(b.id));
    const baseline = sorted[0] as Experiment;
    const baselineView = comparableView(baseline, manifest);

    const mismatches: IdentityMismatch[] = [];
    const details: string[] = [];
    for (const member of sorted.slice(1)) {
      for (const mismatch of diffIdentity(baselineView, comparableView(member, manifest), "identity")) {
        mismatches.push(mismatch);
        details.push(
          `${group}: ${baseline.id} vs ${member.id}: ${mismatch.path} changed ` +
            `(${JSON.stringify(mismatch.a)} -> ${JSON.stringify(mismatch.b)})`,
        );
      }
    }

    groups.push({
      group,
      experimentIds: sorted.map((member) => member.id),
      comparison: mismatches.length === 0 ? "allowed" : "withheld",
      mismatches,
      details,
    });
  }
  return groups;
}
