import type { EvalMetadata } from "../evals/types.ts";
import type { Runtime, RuntimeCapacity } from "../experiments/types.ts";

/**
 * The capacity an attempt of `metadata` holds under `runtime`: the static
 * pool, the resolver's answer for that eval, or none. The scheduler validates
 * the shape of whatever comes back.
 */
export function resolveRuntimeCapacity(
  runtime: Runtime | undefined,
  metadata: EvalMetadata | undefined,
): RuntimeCapacity | undefined {
  const capacity = runtime?.capacity;
  if (capacity === undefined) return undefined;
  if (typeof capacity === "function") return metadata === undefined ? undefined : capacity(metadata);
  return capacity;
}
