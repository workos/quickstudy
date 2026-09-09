/**
 * The v3 run manifest: immutable, content-addressed identity for one run.
 *
 * Ports the legacy identity techniques (canonical-JSON ordering, secret
 * exclusion, tree hashing, hash-of-components-then-hash-of-manifest) onto the
 * eval × experiment component set. There are deliberately no pack,
 * packRuntime, or reference components — those are legacy manifest fields.
 *
 * The component key sets are snapshot-asserted in tests/identity-v3.test.ts:
 * adding or removing a component is a deliberate, test-visible act.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EMBEDDED_BUILD_INFO } from "./build-info.generated.ts";
import { hashString, hashTree, type ContentIdentity } from "./hash.ts";
import { sourceIdentity } from "./source-identity.ts";
import { pairKey, resolvePairEnvironments, type PairEnvironment } from "./execution-policy.ts";
import { canonicalJson } from "./identity-diff.ts";
import type { EvalMetadata, LoadedEval } from "./evals/types.ts";
import type { LoadedExperiment } from "./experiments/types.ts";
import type { AttemptPlan } from "./plan.ts";

export const MANIFEST_VERSION = "v4";

export interface HarnessIdentity {
  version: string;
  revision: string;
  dirty: boolean;
  source: ContentIdentity;
}

/** A container image resolved to the content identity Docker will execute. */
export interface RuntimeImageIdentity {
  tag: string;
  id: string;
  repoDigests: string[];
}

/** Per-eval identity components. Every value is a content hash (or null). */
export interface EvalIdentityComponents {
  /** Hash of the entire PROMPT.md file, frontmatter included. */
  promptSource: string;
  /** Hash of the prompt the agent actually receives (the verbatim body). */
  effectivePrompt: string;
  /** Tree hash of `local/` (secret-pattern files excluded), or null when absent. */
  local: string | null;
  /** Hash of EVAL.ts. Statically-included shared scorer sources join in phase 3. */
  scorer: string;
  scorerConfiguration?: string | null;
  /** Hash of the canonicalized frontmatter metadata. */
  metadata: string;
}

export interface EvalIdentity {
  id: string;
  metadata: EvalMetadata;
  components: EvalIdentityComponents;
  hash: string;
}

/** Per-experiment identity components — phase 2's comparison-group diff reads these. */
export interface ExperimentIdentityComponents {
  /** Hash of the experiment's defining module source. */
  source: string;
  /** Agent identity fields, recorded verbatim (never hashed away). */
  agent: {
    adapter: string;
    provider: string;
    model: string;
    reasoning: string;
    cliVersion: string;
  };
  /** Hash of the canonicalized runtime configuration. */
  runtime: string;
  /** Resolved image identity for container runtimes; null for host. */
  image: RuntimeImageIdentity | null;
  /** The declared treatment, verbatim; null when the experiment declares none. */
  treatment: string | null;
  /** Harness source hash — an experiment is only comparable across equal harnesses. */
  harness: string;
}

export interface ExperimentIdentity {
  id: string;
  components: ExperimentIdentityComponents;
  hash: string;
}

export interface RunManifest {
  manifestVersion: "v3" | typeof MANIFEST_VERSION;
  /** v4: exact per-pair environment consumed by the runner. */
  pairs?: Record<string, PairEnvironment>;
  harness: HarnessIdentity;
  evals: Record<string, EvalIdentity>;
  experiments: Record<string, ExperimentIdentity>;
  /**
   * Every container image the run resolved, keyed by tag — the exact bits
   * Docker executed. Kept at the run level because a `containerImage(metadata)`
   * resolver maps one experiment to a different image per eval, which a single
   * per-experiment component cannot hold (that component still fills for
   * static `runtime.image` tags). Empty for host-only runs.
   */
  images: Record<string, RuntimeImageIdentity>;
  hash: string;
}

function contentHash(value: unknown): string {
  return hashString(typeof value === "string" ? value : canonicalJson(value));
}

function git(args: string[], cwd: string): string | null {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

/** Embedded build info when compiled; git revision + src tree hash from a checkout. */
export function resolveHarnessIdentityV3(): HarnessIdentity {
  if (EMBEDDED_BUILD_INFO.revision && EMBEDDED_BUILD_INFO.sourceHash && EMBEDDED_BUILD_INFO.dirty !== null) {
    return {
      version: EMBEDDED_BUILD_INFO.version,
      revision: EMBEDDED_BUILD_INFO.revision,
      dirty: EMBEDDED_BUILD_INFO.dirty,
      source: { sha256: EMBEDDED_BUILD_INFO.sourceHash },
    };
  }
  const root = resolve(import.meta.dir, "..");
  const revision = git(["rev-parse", "HEAD"], root) ?? "unversioned";
  const dirty = (git(["status", "--porcelain", "--untracked-files=all", "--", "src", "package.json", "bun.lock"], root) ?? "unknown") !== "";
  return { version: EMBEDDED_BUILD_INFO.version, revision, dirty, source: hashTree(join(root, "src")) };
}

export interface BuildRunManifestOptions {
  evals: LoadedEval[];
  experiments: LoadedExperiment[];
  /** Resolved image identities keyed by image tag (container runtimes only). */
  images?: Record<string, RuntimeImageIdentity>;
  /**
   * CLI versions probed from each experiment's resolved image via the
   * adapter's `versionCommand`, keyed by experiment id. A probed version
   * beats the experiment's declared string — the executable in the image is
   * the ground truth.
   */
  cliVersions?: Record<string, string>;
  /** Injectable for deterministic tests; production callers omit it. */
  harness?: HarnessIdentity;
  pairs?: Record<string, PairEnvironment>;
  scorerIdentities?: Record<string, Record<string, unknown>>;
}

/** Build before the first paid attempt; all reads are deterministic and local. */
export function buildRunManifest(options: BuildRunManifestOptions): RunManifest {
  const harness = options.harness ?? resolveHarnessIdentityV3();

  const evals: Record<string, EvalIdentity> = {};
  for (const loaded of options.evals) {
    const components: EvalIdentityComponents = {
      promptSource: contentHash(readFileSync(loaded.promptPath, "utf8")),
      effectivePrompt: contentHash(loaded.promptBody),
      local: loaded.localDir === null ? null : hashTree(loaded.localDir).sha256,
      scorer: sourceIdentity(loaded.scorerPath),
      scorerConfiguration: options.scorerIdentities?.[loaded.metadata.id] ? contentHash(options.scorerIdentities[loaded.metadata.id]) : null,
      metadata: contentHash(loaded.metadata),
    };
    evals[loaded.metadata.id] = {
      id: loaded.metadata.id,
      metadata: loaded.metadata,
      components,
      hash: contentHash(components),
    };
  }

  const experiments: Record<string, ExperimentIdentity> = {};
  for (const { experiment, path } of options.experiments) {
    const imageTag = experiment.runtime.image;
    const components: ExperimentIdentityComponents = {
      source: sourceIdentity(path),
      agent: {
        adapter: experiment.agent.adapter,
        provider: experiment.agent.provider ?? "unspecified",
        model: experiment.agent.model ?? "unspecified",
        reasoning: experiment.agent.reasoning ?? "unspecified",
        cliVersion: options.cliVersions?.[experiment.id] ?? experiment.agent.cliVersion ?? "unspecified",
      },
      runtime: contentHash({
        kind: experiment.runtime.kind,
        capacity: experiment.runtime.capacity ?? null,
        observationTargets: experiment.runtime.observationTargets ?? null,
        treatmentPolicyFields: [...(experiment.runtime.treatmentPolicyFields ?? [])].sort(),
        image: experiment.runtime.image ?? null,
        command: experiment.runtime.command ?? null,
        config: experiment.runtime.config ?? {},
      }),
      image: (imageTag !== undefined ? options.images?.[imageTag] : undefined) ?? null,
      treatment: experiment.treatment ?? null,
      harness: harness.source.sha256,
    };
    experiments[experiment.id] = {
      id: experiment.id,
      components,
      hash: contentHash(components),
    };
  }

  const withoutHash: Omit<RunManifest, "hash"> = {
    manifestVersion: MANIFEST_VERSION,
    pairs: options.pairs ?? resolvePairEnvironments(options),
    harness,
    evals,
    experiments,
    images: options.images ?? {},
  };
  return { ...withoutHash, hash: contentHash(withoutHash) };
}

/** The identity persisted on every attempt row. Trials share it by design. */
export function attemptIdentityHash(plan: AttemptPlan, manifest: RunManifest): string {
  const evalIdentity = manifest.evals[plan.evalId];
  if (!evalIdentity) throw new Error(`attemptIdentityHash: eval "${plan.evalId}" is not in the manifest`);
  const experimentIdentity = manifest.experiments[plan.experimentId];
  if (!experimentIdentity) throw new Error(`attemptIdentityHash: experiment "${plan.experimentId}" is not in the manifest`);
  return contentHash({
    manifestVersion: manifest.manifestVersion,
    ...(manifest.manifestVersion === "v4" ? { environment: manifest.pairs?.[pairKey(plan.evalId, plan.experimentId)] } : {}),
    eval: evalIdentity.hash,
    experiment: experimentIdentity.hash,
  });
}
