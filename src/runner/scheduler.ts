import { hashString } from "../hash.ts";
import type { AttemptPlan } from "../plan.ts";

/** Seeded order changes dispatch timing, never trial coordinates. */
export function orderedPlan(plan: AttemptPlan[], seed: string): AttemptPlan[] {
  return [...plan].sort((a, b) =>
    hashString(`${seed}:${JSON.stringify(a)}`).localeCompare(hashString(`${seed}:${JSON.stringify(b)}`)),
  );
}
export async function schedule<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
  options: {
    signal?: AbortSignal;
    capacity?: (item: T) => { key: string; limit: number } | undefined;
  } = {},
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  const capacities = new Map<T, { key: string; limit: number } | undefined>();
  const limits = new Map<string, number>();
  for (const item of items) {
    const cap = options.capacity?.(item);
    if (cap) {
      if (!cap.key || !Number.isInteger(cap.limit) || cap.limit < 1)
        throw new Error("runtime capacity must have a key and positive integer limit");
      if (limits.has(cap.key) && limits.get(cap.key) !== cap.limit)
        throw new Error(`conflicting runtime capacity for ${cap.key}`);
      limits.set(cap.key, cap.limit);
    }
    capacities.set(item, cap);
  }
  const remaining = [...items];
  const running = new Set<Promise<void>>();
  const active = new Map<string, number>();
  let failure: unknown;
  while (remaining.length || running.size) {
    while (!failure && !options.signal?.aborted && running.size < concurrency) {
      const index = remaining.findIndex((item) => {
        const cap = capacities.get(item);
        return !cap || (active.get(cap.key) ?? 0) < cap.limit;
      });
      if (index < 0) break;
      const item = remaining.splice(index, 1)[0]!;
      const cap = capacities.get(item);
      if (cap) active.set(cap.key, (active.get(cap.key) ?? 0) + 1);
      const task = Promise.resolve()
        .then(() => work(item))
        .catch((err) => {
          failure = err;
        })
        .finally(() => {
          running.delete(task);
          if (cap) active.set(cap.key, (active.get(cap.key) ?? 1) - 1);
        });
      running.add(task);
    }
    if (!running.size) break;
    await Promise.race(running);
  }
  if (failure) throw failure;
}
