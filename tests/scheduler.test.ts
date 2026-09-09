import { expect, test } from "bun:test";
import { schedule, orderedPlan } from "../src/runner/scheduler.ts";

test("scheduler obeys shared runtime capacity and records reproducible order", async () => {
  const plan = Array.from({ length: 8 }, (_, trialIndex) => ({
    evalId: "eval",
    experimentId: String(trialIndex % 2),
    trialIndex,
  }));
  expect(orderedPlan(plan, "a")).toEqual(orderedPlan([...plan].reverse(), "a"));
  expect(orderedPlan(plan, "a")).not.toEqual(orderedPlan(plan, "b"));
  let active = 0;
  let peak = 0;
  await schedule(
    plan,
    4,
    async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(10);
      active--;
    },
    { capacity: () => ({ key: "one-pool", limit: 1 }) },
  );
  expect(peak).toBe(1);
});

test("synthetic local workload reduces elapsed time at a bounded concurrency", async () => {
  const workload = [0, 1, 2, 3, 4, 5];
  const measure = async (concurrency: number) => {
    let active = 0;
    let peak = 0;
    const start = performance.now();
    await schedule(workload, concurrency, async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(50);
      active--;
    });
    return { elapsedMs: Math.round(performance.now() - start), peak };
  };
  const serial = await measure(1);
  const parallel = await measure(3);
  console.log(JSON.stringify({ workload: "6 local 50 ms jobs", serial, parallel }));
  expect(parallel.peak).toBe(3);
  expect(parallel.elapsedMs).toBeLessThan(serial.elapsedMs * 0.75);
});
