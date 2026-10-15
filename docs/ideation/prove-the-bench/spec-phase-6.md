# Implementation Spec: Prove the Bench - Phase 6

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Three honesty fixes, none of which need a schema change:

1. **Compare n-notice.** The Compare view shows raw per-arm counts with no colour, so the gap is a missing statement: when the run has fewer than three trials per pair, or any shared eval in a compared group has an arm with nothing scored, say that the counts are listed but not comparable.
2. **Diagnosis clustering.** `DiagnosisFinding` carries no check name, but `report.pairs[].checks` does. The Diagnosis view loads the report, derives each finding's failing-check set by joining on `(eval_id, experiment_id)`, and groups findings into clusters keyed by `(eval_id, failing checks)`, largest first. When `eval-defect` findings are at least a quarter of the total, that target leads inside every cluster; otherwise the existing `DIAGNOSIS_TARGETS` order holds.
3. **Excerpt anchoring.** `excerptTranscript` anchors on the *first* error marker and caps forward, which yields L1–40 whenever a marker sits in the transcript's first lines. Anchor on the *last* marker cluster instead: walk matches backwards from the last one while they fit in the 40-line window, then pad with context.

No prerequisites; this phase can run in the first wave. It touches `scripts/seed-site.ts` and `ui/dev-data`, which Phases 1, 3 and 5 also touch, so the engine serialises it against them.

## Decisions Considered and Rejected

- **Compare gets a not-comparable notice below three trials, no colour** — rejected: grey out deltas. Current Compare has no deltas to grey.
- **Diagnosis grouping derives the failing-check set in the UI from report.pairs[].checks** — rejected: add a `check` field to `DiagnosisFinding` with a schema bump. A bump would force regenerating the real sweep's diagnosis at LLM cost.
- **Excerpt selector anchors on the last error-marker cluster** — rejected: keep the first-marker window. A marker in the first five lines is a system-prompt false positive.
- **Fold the brief's §2 UI items into one report-honesty phase in the Full tier** — rejected: defer or Stretch.

## Feedback Strategy

**Inner-loop command**: `bun test tests/diagnose-clusters.test.ts tests/diagnose.test.ts`

**Playground**: pure functions (`excerptTranscript`, `clusterFindings`) under the test runner; `bun run ui:dev` for the two views against regenerated dev data.

**Why this approach**: the anchoring and clustering logic are pure and testable in milliseconds; the views are small re-layouts.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `ui/src/diagnosis-clusters.ts` | `clusterFindings(findings, pairs)` and `targetOrder(findings)` pure helpers |
| `tests/diagnose-clusters.test.ts` | Anchoring, clustering, ordering (the contract's named suite) |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/diagnose/excerpt.ts` | Last-cluster anchoring |
| `src/diagnose/types.ts` | `DIAGNOSIS_PROMPT_VERSION` 1 → 2 (evidence windows changed) |
| `tests/diagnose.test.ts` | Update assertions that encoded first-marker windows |
| `ui/src/views/Compare.tsx` | `compare-n-notice` |
| `ui/src/views/Diagnosis.tsx` | Load report; cluster sections; target ordering |
| `scripts/seed-run.ts` | `SeedOptions.idSalt?: string` mixed into `seedIdBase` so a second seeded run in one DB gets distinct ids |
| `scripts/seed-site.ts` | Third run: `seedRun({ trials: 1, idSalt: "n1", … })`; report written for it; `runIds` gains it |
| `ui/e2e/fixture-server.ts`, `ui/e2e/smoke.spec.ts` | Three runs; `compare-n-notice` visible on the trials-1 run and absent on the sweep run; `diagnosis-cluster` sections |
| `ui/dev-data/**` | Regenerated |
| `docs/concepts.md` | One paragraph on clustering and on the notice |

## Implementation Details

### Excerpt anchoring

**Pattern to follow**: `src/diagnose/excerpt.ts:48-85`.

```typescript
// matches: ascending 0-based indexes of ERROR_MARKER lines
const last = matches.at(-1)!;
let first = last;
for (let i = matches.length - 2; i >= 0; i -= 1) {
  const candidate = matches[i]!;
  if (last - candidate + 2 * EXCERPT_CONTEXT_LINES + 1 > EXCERPT_MAX_LINES) break;
  first = candidate;
}
const start = Math.max(0, first - EXCERPT_CONTEXT_LINES);
const end = Math.min(totalLines - 1, last + EXCERPT_CONTEXT_LINES);
```

No-marker fallback (last 12 lines) unchanged. Bump `DIAGNOSIS_PROMPT_VERSION` to 2 and update the doc comment ("excerpt windows anchor on the last marker cluster").

**Feedback loop**:

- **Playground**: `tests/diagnose-clusters.test.ts` `describe("excerpt")`.
- **Experiment**: markers at lines 2 and 500 of a 600-line transcript → `lines` within `[496, 504]`; markers at 2, 480, 500 → window covers 480..500 with context (fits in 40); markers at 2, 400, 500 → 400 excluded; no markers → last 12; a single marker at line 1 → `[1, 5]`.
- **Check command**: `bun test tests/diagnose-clusters.test.ts -t excerpt`

### Compare n-notice

**Pattern to follow**: `ui/src/views/Compare.tsx:208-212` (the incomplete banner).

Condition: `run.trials < 3` **or** any compared (non-withheld) group has an eval where some arm has `scored === 0` (use `countArms` at `:31-46`). Text: `With fewer than 3 trials per pair (this run: {trials}), per-arm counts are listed but not comparable.` / `Some shared evals have an arm with nothing scored; those rows are listed but not comparable.` — pick the applicable sentence(s). `data-testid="compare-n-notice"`. No colour changes anywhere.

**Feedback loop**:

- **Playground**: `bun run ui:dev`, Compare view, switch between the sweep run (3 trials) and the new trials-1 run.
- **Experiment**: notice absent on the sweep run, present on the trials-1 run with "this run: 1".
- **Check command**: `bun run ui:build && bun run ui:e2e -g compare`

### Diagnosis clustering

**Pattern to follow**: `ui/src/views/Diagnosis.tsx:100-108` (current by-target grouping), `ui/src/views/Report.tsx` (loads `report.json`), `src/report/report.ts:93-123` (`ReportPair.checks`).

```typescript
// ui/src/diagnosis-clusters.ts
export interface FindingCluster {
  evalId: string;
  /** Sorted failing graded check names for the pairs the findings cite; [] when the report has none. */
  failingChecks: string[];
  findings: DiagnosisFinding[];
  /** Experiments among the cluster's findings. */
  experiments: string[];
}
export function clusterFindings(findings: DiagnosisFinding[], pairs: ReportPair[] | null): FindingCluster[]
/** DIAGNOSIS_TARGETS order, with "eval-defect" moved first when it is >= 25% of findings. */
export function targetOrder(findings: DiagnosisFinding[]): DiagnosisTarget[]
```

Cluster key: `eval_id + "\u0000" + failingChecks.join(",")` where `failingChecks` for a finding = names with `passed < total` (graded only, via `ui/src/checks.ts` from Phase 2 if present, else all) on the pair `(finding.eval_id, finding.experiment_id)`. Sort clusters by `findings.length` desc, then eval id. Inside a cluster, group by target in `targetOrder` order, document order within a target. Without a report (`null`) clusters are per eval id with `failingChecks: []`.

View: `<section className="cluster" data-testid="diagnosis-cluster">` with heading `{evalId} · {failingChecks.join(", ")} failed under {experiments.length} arm(s) · {n} findings` (or `{evalId} · {n} findings` when no checks), then the existing target sub-sections and `FindingCard`s. Keep the target filter buttons (`:154-173`); they filter within clusters. Keep `diagnosis-disclaimer`, provenance KPI row and the errors table.

**Feedback loop**:

- **Playground**: `tests/diagnose-clusters.test.ts` `describe("clusters")` importing `../ui/src/diagnosis-clusters.ts`.
- **Experiment**: 6 findings across 2 evals, one eval's pairs all failing `shape` → two clusters, the `shape` cluster first with 4 findings; `targetOrder` with 2 of 6 eval-defect (33%) → `eval-defect` first; with 1 of 6 → default order; `pairs: null` → per-eval clusters.
- **Check command**: `bun test tests/diagnose-clusters.test.ts -t clusters`

### Seed: a trials-1 run

**Pattern to follow**: `scripts/seed-run.ts:326-345` (`seedRun`), `scripts/seed-site.ts:260-324`.

1. `SeedOptions.idSalt?: string`; `seedIdBase(dbPath, startedAtMs, idSalt)` mixes it in so ids differ from the sweep run in the same DB.
2. `seedSite`: `const n1 = seedRun({ dbPath, resultsDir, trials: 1, idSalt: "n1" })` (takes the first of each pair's three outcomes); `writeReportJson(buildReport({ … runId: n1.runId … }))`; `runIds: [sweep, cellStates, n1.runId]`.
3. `ui/e2e/fixture-server.ts` header comment and any "two runs" assertion → three; `scripts/make-dev-data.ts` unchanged.
4. `bun run ui:dev-data`; update tests that count runs in `meta.json` (`tests/export.test.ts`, e2e run-select assertions).

## Testing Requirements

| Test File | Coverage |
| --- | --- |
| `tests/diagnose-clusters.test.ts` | excerpt anchoring (5), clustering (3), target ordering (2) |
| `tests/diagnose.test.ts` | existing window assertions updated |
| `ui/e2e/smoke.spec.ts` | `compare-n-notice` present/absent; `diagnosis-cluster` sections; filter buttons still work |

### Manual Testing

- [ ] `bun run ui:dev` → Diagnosis → cluster headings show failing check names from the seeded report.

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| Report missing for the run | Clusters per eval id, no check names |
| Finding cites a pair absent from the report | Treated as `failingChecks: []` |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Excerpt | Trailing markers exceed 40 lines | Long error tail | Earliest tail markers cut | Documented; window ends at the last marker |
| Seed | Duplicate run ids in one DB | Deterministic id base | Insert conflict | `idSalt` |
| Diagnosis | Old `diagnosis.json` with `prompt_version: 1` | Existing exports | Windows differ from new runs | Version recorded; UI shows provenance already |

## Validation Commands

```bash
bun run typecheck
bun run lint
bun test tests/diagnose-clusters.test.ts tests/diagnose.test.ts tests/export.test.ts
bun test genericity
bun run ui:dev-data && git diff --quiet -- ui/dev-data && test -z "$(git status --porcelain -- ui/dev-data)"
bun run ui:build && bun run ui:e2e
```

## Rollout Considerations

- **Commit**: `feat(ui): compare notice, diagnosis clusters, last-marker excerpts`.
- **Rollback plan**: revert; no schema changes.
