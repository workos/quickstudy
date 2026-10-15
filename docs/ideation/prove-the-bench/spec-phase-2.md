# Implementation Spec: Prove the Bench - Phase 2

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

`CheckResult` gains an optional `graded` flag (default `true`). An ungraded check is recorded, tallied and exported like any other, but the convention (documented, and followed by the fixtures) is that scorers compute `passed` over graded checks only. The report tallies the flag per check name and computes one new per-experiment number, **SDK recall**: among scored attempts that recorded at least one ungraded check, the share whose ungraded checks all passed. The UI tags ungraded checks and counts graded ones in the matrix's "x/y checks".

`passed` stays the scorer's call. The harness ships no helper for it (consumer scorers import only types from the package), so the doc and the fixture scorer show the one-line convention.

This phase also performs the first `REPORT_SCHEMA_VERSION` bump of the plan and adds the stale-schema rebuild in `resolveReport`, so every later bump is picked up by `quickstudy export` for free.

## Decisions Considered and Rejected

- **SDK recall denominator is scored attempts on evals that declare at least one ungraded check; null otherwise** — rejected: all scored attempts. An eval with no recall check would otherwise count as recalled.
- **Bump REPORT_SCHEMA_VERSION and make export rebuild a stale-schema stored report; keep DATA_SCHEMA_VERSION at 3** — rejected: bump DATA_SCHEMA_VERSION too. Reports rebuild from the DB for free; hosted run snapshots are immutable.
- **Compute scorer health in report.ts and render it in the UI** — rejected: client-side computation. One implementation of pair math instead of two (applies equally to recall).
- **Drop the per-attempt cost_source item** — rejected: keep it. Derivable from `cost_usd !== null`.

## Feedback Strategy

**Inner-loop command**: `bun test tests/graded-checks.test.ts tests/report-v3.test.ts`

**Playground**: the test suite via `seedRun` + `buildReport` (see `tests/report-v3.test.ts:26-32`), plus a temp-dir eval fixture run through `executeRunV3` with the `echo` adapter; `bun run ui:dev` for the tag.

**Why this approach**: the report builder is pure over the store, and `seedRun` produces a deterministic store in milliseconds.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `tests/graded-checks.test.ts` | Validation, tally, recall, invariant, export, matrix counting (the contract's named suite) |
| `ui/src/checks.ts` | `countGradedChecks(checks)` and `isGraded(check)` pure helpers shared by Matrix/Report/Attempt views |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/evals/types.ts` | `CheckResult.graded?: boolean` with doc comment |
| `src/evals/result.ts` | `validEvalResult` rejects a non-boolean `graded` |
| `src/report/report.ts` | `ReportCheck.graded`; tally in `collectPairs`; `ReportExperiment.sdk_recall`; `collectRecall`; methodology sentence; text renderer line; `REPORT_SCHEMA_VERSION` 6 → 7 |
| `src/export.ts` | `resolveReport`: rebuild when `stored.schema_version !== REPORT_SCHEMA_VERSION` (before the v3 verbatim-reuse branch) |
| `ui/src/views/Matrix.tsx` | `buildCells` counts graded checks only; `AttemptRow` tags ungraded checks |
| `ui/src/views/Report.tsx` | Check list tags ungraded; experiments card shows `SDK recall n/m` |
| `ui/src/views/Attempt.tsx` | Check list tags ungraded |
| `scripts/seed-run.ts` | `seedChecks` adds an ungraded `sdk-wired` check; some passing attempts fail only that check |
| `ui/e2e/smoke.spec.ts` | `ungraded-tag` visible in a drill-down; "x/y checks" excludes it |
| `ui/dev-data/**` | Regenerated |
| `docs/writing-an-eval.md` | "Record a check without grading it" section with the `passed` convention |
| `docs/concepts.md` | SDK recall definition |

## Implementation Details

### `graded` on CheckResult and validation

**Pattern to follow**: `src/evals/result.ts` (5-line validator).

```typescript
// src/evals/types.ts
export interface CheckResult {
  name: string;
  passed: boolean;
  /**
   * false = recorded but not graded: the report tallies it and derives SDK
   * recall from it, and the scorer must leave it out of `passed`. Absent = true.
   */
  graded?: boolean;
  notes?: string;
  evidence?: EvidenceReference[];
}
```

Validator: `c.graded !== undefined && typeof c.graded !== "boolean"` → invalid.

Scorer convention (docs + fixtures):

```typescript
const graded = checks.filter((c) => c.graded !== false);
return { passed: graded.every((c) => c.passed), checks };
```

No feedback loop (type + one predicate; covered by the validation test cases).

### Report tally and SDK recall

**Pattern to follow**: `src/report/report.ts:246-304` (`collectPairs`) and `:343` (`collectExperiments`).

```typescript
export interface ReportCheck { name: string; passed: number; total: number; graded: boolean; }

export interface ReportRecall {
  /** Scored attempts of this experiment whose checks include at least one graded:false check. */
  attempts: number;
  /** Of those, attempts where every graded:false check passed. */
  recalled: number;
  /** recalled / attempts; null when attempts = 0. */
  rate: number | null;
}
export interface ReportExperiment { experiment_id: string; treatment: string | null; agent: ReportAgentIdentity; sdk_recall: ReportRecall; }

export function collectRecall(attempts: AttemptRecord[], experimentId: string): ReportRecall
```

Tally rule for `ReportCheck.graded`: `true` unless any attempt's check of that name carries `graded: false` (a scorer that flips it mid-run marks the whole tally ungraded; note it in the doc comment). Scored = `status === "completed"` (graded timeouts included).

Methodology sentence (append to `methodologyNote`; must pass `findBannedLanguage` — avoid "because"):

> SDK recall is reported per experiment as recalled / attempts, where attempts are the scored attempts that recorded at least one ungraded check and recalled are those whose ungraded checks all passed. Ungraded checks are recorded and tallied but never enter pass/fail.

Text renderer: under each experiment line, `sdk recall: 3/5 (60%)` or `sdk recall: n/a`.

**Implementation steps**:

1. Bump `REPORT_SCHEMA_VERSION` to 7; update the pin in `tests/report-v3.test.ts` if it is literal.
2. `collectPairs`: carry `graded` in the per-name tally.
3. `collectRecall`; wire into `collectExperiments(run, attempts)` (signature gains `attempts`).
4. Methodology + renderer.
5. `resolveReport` (`src/export.ts:175-205`): after parsing `stored`, `if (stored.schema_version !== REPORT_SCHEMA_VERSION) { log("stored report.json for <id> is schema <v> — rebuilding at <current>"); return buildReport(...) }` placed before the v3 verbatim-reuse `return stored`.

**Feedback loop**:

- **Playground**: `tests/graded-checks.test.ts` `describe("report")` over a hand-built `AttemptRecord[]` (the shape is in `src/store/db.ts:87-109`) and over `seedRun`.
- **Experiment**: (a) three attempts, one with `sdk-wired graded:false` failing and `passed: true` → pair `passed` 1, `checks` has `{name:"sdk-wired", graded:false, passed:0,total:1}`; (b) recall over an experiment with two qualifying attempts, one recalled → `{attempts:2, recalled:1, rate:0.5}`; (c) an experiment whose attempts record no ungraded check → `{attempts:0, recalled:0, rate:null}`; (d) `findBannedLanguage(methodologyNote(3))` is empty; (e) write a report with `schema_version: 6` into a temp results dir and `exportSite` → the exported `report.json` has `schema_version: 7`.
- **Check command**: `bun test tests/graded-checks.test.ts -t report`

### End-to-end invariant through the runner

**Overview**: prove "an attempt whose only failing check is ungraded scores passed=true" through the real pipeline.

**Implementation steps** (test-only):

1. Copy `tests/__fixtures__/evals/hello-local` into a temp evals root; replace `EVAL.ts` with a scorer that adds `{ name: "sdk-wired", passed: await ctx.fileExists("sdk.txt"), graded: false }` and uses the convention above.
2. `executeRunV3` with `tests/__fixtures__/experiments/echo-local.ts`, trials 1 → the attempt is `completed`, `result.passed === true`, and the `sdk-wired` check is `passed: false`.
3. `buildReport` → pair `passed: 1`; `experiments[0].sdk_recall` = `{attempts:1, recalled:0, rate:0}`.
4. `exportSite` → `run.json` attempt `checks[]` carries `graded: false`.

**Check command**: `bun test tests/graded-checks.test.ts -t invariant`

### UI tag and graded-only counts

**Pattern to follow**: `ui/src/views/Matrix.tsx:67-96` (`buildCells`), `:111-150` (`AttemptRow`), `ui/src/views/Report.tsx:50-53`, `ui/src/views/Attempt.tsx:78-80`.

```typescript
// ui/src/checks.ts
import type { CheckResult } from "../../src/evals/types.ts";
export const isGraded = (c: CheckResult): boolean => c.graded !== false;
export function countGradedChecks(checks: CheckResult[] | null): { passed: number; total: number } { /* graded only */ }
```

Render for an ungraded check: `<span className="tag" data-testid="ungraded-tag" title="Recorded, not graded: never enters pass/fail">recorded</span>` next to the name. `buildCells` uses `countGradedChecks`. `Report.tsx` experiments card: `SDK recall {recalled}/{attempts}` or `SDK recall n/a`.

**Feedback loop**:

- **Playground**: `bun run ui:dev` after regenerating dev data; open a drill-down with the seeded `sdk-wired` miss.
- **Experiment**: `countGradedChecks([{graded:false,passed:false},{passed:true}])` → `{passed:1,total:1}` (assert from `tests/graded-checks.test.ts` via `../ui/src/checks.ts`); e2e: the tag is visible and the cell sub-text reads `3/3 checks` for an attempt with a failed ungraded check.
- **Check command**: `bun test tests/graded-checks.test.ts -t matrix && bun run ui:build && bun run ui:e2e -g "drill"`

### Seeders and docs

1. `scripts/seed-run.ts` `seedChecks`: add `{ name: "sdk-wired", passed: <treatment === "mcp">, graded: false }` to every completed attempt; keep `passed` semantics (recall misses are pass outcomes with the ungraded check failing under docs/cli).
2. `bun run ui:dev-data`; update tests that pin seeded check arrays.
3. `docs/writing-an-eval.md`: new section after the check-naming rules; show the `passed` convention and say the report derives SDK recall from `graded: false` checks.

## Testing Requirements

| Test File | Coverage |
| --- | --- |
| `tests/graded-checks.test.ts` | validator accept/reject; tally `graded`; recall math incl. null; runner invariant; export carries flag; methodology guard; stale-schema rebuild; `countGradedChecks` |
| `ui/e2e/smoke.spec.ts` | `ungraded-tag` visible; graded-only count |

### Manual Testing

- [ ] `bun src/cli.ts report <seeded run>` prints `sdk recall:` per experiment.

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| Scorer returns `graded: "no"` | `validEvalResult` false → attempt `error` (existing path) |
| Check graded in one attempt, ungraded in another | Tally marks the name ungraded; doc comment says so |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Recall | Scorer marks a check ungraded but still folds it into `passed` | Author ignores the convention | Recall and pass rate double-count | Doc section + fixture; the oracle phase's validate surfaces it (solution fails an ungraded check → warning line) |
| Stale rebuild | Stored report has pricing fields the DB cannot reproduce | Old `cost_estimate` present | Rebuild drops estimates | Reuse `stored.cost_estimate.pricing` as the existing branch already does |

## Validation Commands

```bash
bun run typecheck
bun run lint
bun test tests/graded-checks.test.ts tests/report-v3.test.ts tests/export.test.ts tests/complete-export.test.ts tests/viewers-export.test.ts
bun test genericity
bun run ui:dev-data && git diff --quiet -- ui/dev-data && test -z "$(git status --porcelain -- ui/dev-data)"
bun run ui:build && bun run ui:e2e
```

## Rollout Considerations

- **Commit**: `feat(report): record ungraded checks and report SDK recall`.
- **Rollback plan**: revert; `graded` is optional so existing scorers are unaffected either way.
