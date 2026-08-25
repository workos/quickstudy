/**
 * pass@k / pass^k: per-k restatements of a pair's scored counts.
 *
 * Both are computed from this run's trials only and stay within the report's
 * no-attribution stance: they describe the observed outcomes, not a wider
 * population.
 *
 *   - pass@k — the fraction of size-k subsets of the scored trials that
 *     contain at least one pass ("given k of these attempts, how often was
 *     one good"). Exact, not sampled: 1 - C(scored-passed, k) / C(scored, k).
 *   - pass^k — (passed/scored)^k, the all-pass rate for k with-replacement
 *     draws from the scored trials ("how often do k attempts ALL pass").
 *
 * References: Chen et al., "Evaluating Large Language Models Trained on
 * Code" (the unbiased pass@k estimator).
 */

export interface PassAtKEntry {
  k: number;
  /** Fraction of size-k subsets of the scored trials containing ≥1 pass. */
  pass_at_k: number;
  /** (passed/scored)^k — the all-k-pass rate. */
  pass_to_the_k: number;
}

function assertCounts(passed: number, scored: number, k: number): void {
  if (!Number.isInteger(passed) || !Number.isInteger(scored) || !Number.isInteger(k)) {
    throw new RangeError(`pass@k needs integer counts (passed=${passed}, scored=${scored}, k=${k})`);
  }
  if (passed < 0 || scored < 1 || passed > scored || k < 1 || k > scored) {
    throw new RangeError(`pass@k needs 0 ≤ passed ≤ scored and 1 ≤ k ≤ scored (passed=${passed}, scored=${scored}, k=${k})`);
  }
}

/** Exact pass@k over the scored trials: 1 - C(scored-passed, k) / C(scored, k). */
export function passAtK(passed: number, scored: number, k: number): number {
  assertCounts(passed, scored, k);
  const failed = scored - passed;
  if (failed < k) return 1;
  let allFail = 1;
  for (let i = 0; i < k; i++) {
    allFail *= (failed - i) / (scored - i);
  }
  return 1 - allFail;
}

/** pass^k over the scored trials: (passed/scored)^k. */
export function passToTheK(passed: number, scored: number, k: number): number {
  assertCounts(passed, scored, k);
  return (passed / scored) ** k;
}

/**
 * The full per-k series for one pair, k = 1..scored. Empty when nothing was
 * scored — a pair with no scored trials gets no values, never zeros.
 */
export function collectPassAtK(passed: number, scored: number): PassAtKEntry[] {
  if (scored === 0) return [];
  const entries: PassAtKEntry[] = [];
  for (let k = 1; k <= scored; k++) {
    entries.push({ k, pass_at_k: passAtK(passed, scored, k), pass_to_the_k: passToTheK(passed, scored, k) });
  }
  return entries;
}

/**
 * The ks worth rendering: k=1 duplicates the pass rate and k beyond the
 * scored count does not exist, so displays anchor on a few in-between sizes.
 * The JSON keeps the full series; this only shapes text/UI rendering.
 */
export const PASS_AT_K_DISPLAY_KS = [2, 3, 5, 10] as const;

/** Filter a pair's series down to the display anchors. */
export function displayPassAtK(entries: PassAtKEntry[] | undefined): PassAtKEntry[] {
  return (entries ?? []).filter((entry) => (PASS_AT_K_DISPLAY_KS as readonly number[]).includes(entry.k));
}
