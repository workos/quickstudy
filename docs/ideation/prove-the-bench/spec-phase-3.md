# Implementation Spec: Prove the Bench - Phase 3

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Every input for "the scorer, not the agent, failed this row" is already in `report.pairs[].checks`. This phase computes two things in `report.ts`, deterministically and without an LLM: a **band** per eval (discriminating, solved by every arm, failed by every arm), denormalised onto each pair; and a **scorer-health** block listing checks that failed in every scored attempt of an eval under every arm while another check in those same attempts passed. The UI partitions the matrix by band (uniform bands collapsed by default) and shows a banner from the block.

The report's language guard (`BANNED_LANGUAGE = ["caus", "effect of", "significant"]`) applies to every generated sentence. Check names and eval ids are data the harness does not control, so the `summary` sentence never interpolates them; the structured `suspects` array carries the names and the UI composes the display.

Depends on Phase 2 (`ReportCheck.graded`): scorer health considers graded checks only, so a recall miss is never a "suspect".

## Decisions Considered and Rejected

- **Compute scorer health in report.ts and render it in the UI** — rejected: client-side computation; or leave it to the diagnose layer. Deterministic, free, present on every run.
- **Fold the brief's §2 UI items into one report-honesty phase** — the band partition stayed in MVP under Goal 3 (the instrument finding belongs where the reader looks first).
- **Bump REPORT_SCHEMA_VERSION per report phase; keep DATA_SCHEMA_VERSION at 3** — rejected: bump DATA_SCHEMA_VERSION.
- **Drop matrix headers leading with the model pin** — rejected: keep. Already shipped in `Heatmap.tsx` `groupSpans`.

## Feedback Strategy

**Inner-loop command**: `bun test tests/scorer-health.test.ts`

**Playground**: hand-built `AttemptRecord[]` arrays into `collectPairs` → `collectBands` → `collectScorerHealth`; `seedRun` + `buildReport` for the wired result; `bun run ui:dev` for the bands and banner.

**Why this approach**: the math is over in-memory records; the UI is a re-layout of an existing component against regenerated dev data.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `src/report/scorer-health.ts` | `collectBands(pairs)`, `collectScorerHealth(attempts, pairs)`, types |
| `tests/scorer-health.test.ts` | Bands, suspects, guard, wiring (the contract's named suite) |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/report/report.ts` | `ReportPair.band`; `ReportJson.scorer_health`; wire both in `buildReport`; guard `scorer_health.summary`; methodology sentence; renderer prints bands and suspects; `REPORT_SCHEMA_VERSION` 7 → 8 |
| `ui/src/views/Matrix.tsx` | Load `report.json` alongside `run.json`; split rows by band; render three `Heatmap`s; banner |
| `ui/src/components/Heatmap.tsx` | Accept an optional `band` label for the header; no cell changes |
| `ui/src/styles.css` (or the existing stylesheet) | `details.band` styling |
| `scripts/seed-site.ts` | Cell-states run gains `uniform-pass` and `uniform-fail` evals (two arms each) so both collapsed bands and one suspect appear in dev data |
| `ui/e2e/smoke.spec.ts` | `matrix-band-discriminating` visible; `matrix-band-solved` and `matrix-band-failed` present and collapsed; `scorer-health-banner` names the suspect check |
| `ui/dev-data/**` | Regenerated |
| `docs/concepts.md` | "Bands and scorer health" section |

## Implementation Details

### Bands

**Pattern to follow**: `src/report/report.ts:246-304`.

```typescript
export type EvalBand = "discriminating" | "solved-by-all" | "failed-by-all";
// ReportPair gains: band: EvalBand | null

/** Per eval: over pairs with scored > 0. null when fewer than 2 arms scored. */
export function collectBands(pairs: ReportPair[]): Map<string /*eval_id*/, EvalBand | null>
```

Rules: pairs of the eval with `scored > 0`; fewer than 2 → `null`; every `pass_rate === 1` → `solved-by-all`; every `pass_rate === 0` → `failed-by-all`; otherwise `discriminating`. Suites are not mixed: a regression-suite eval is banded among its own pairs like any other (the UI's suite toggle already filters rows).

**Feedback loop**:

- **Playground**: `tests/scorer-health.test.ts` `describe("bands")`.
- **Experiment**: 2 arms both 1.0 → solved; both 0 → failed; 1.0 and 0.5 → discriminating; one arm only → null; an arm with scored 0 (all errors) is ignored in the decision.
- **Check command**: `bun test tests/scorer-health.test.ts -t bands`

### Scorer health

```typescript
export interface ScorerHealthSuspect {
  eval_id: string;
  check: string;
  /** Experiments whose scored attempts all failed this check. */
  experiments: string[];
  /** Scored attempts of the eval (across those experiments) — every one failed this check. */
  attempts: number;
  /** Graded checks that passed in every one of those attempts (the evidence the work was done). */
  passing_checks: string[];
}
export interface ScorerHealth {
  suspects: ScorerHealthSuspect[];
  /** Fixed template, names never interpolated — must pass findBannedLanguage. */
  summary: string;
}
export function collectScorerHealth(attempts: AttemptRecord[], pairs: ReportPair[]): ScorerHealth
```

Rule: for each eval with band `failed-by-all` (or `null`-banded evals whose only arm is at 0? — no: require ≥2 arms, i.e. band `failed-by-all`), for each **graded** check name: it is a suspect when it failed in every scored attempt of that eval, and at least one other graded check passed in every one of those attempts. Suspects sorted by `attempts` desc then eval id.

Summary template: `"{n} check{s} failed in every scored attempt of {m} eval{s} under every arm while another check passed in those attempts. Treat those evals' pass rates as unverified until the scorer is reviewed."` With zero suspects: `"No check failed under every arm while another check passed."` `buildReport` runs `findBannedLanguage(summary)` and throws `ReportError` on a hit, exactly as it does for methodology.

Methodology sentence to append: `"Scorer health lists checks that failed in every scored attempt of an eval under every arm while another check in the same attempts passed: a statement about the instrument, not about any treatment."`

**Feedback loop**:

- **Playground**: `describe("scorer health")`.
- **Experiment**: (a) eval with 2 arms × 2 attempts, check `shape` fails in all 4, check `e2e` passes in all 4 → one suspect `{check:"shape", attempts:4, passing_checks:["e2e"]}`; (b) all checks fail everywhere → no suspect (agent failure); (c) `shape` fails in 3 of 4 → no suspect; (d) an ungraded check failing everywhere → no suspect; (e) a check named `causal-link` as suspect → `findBannedLanguage(summary)` is `[]` and `suspects[0].check === "causal-link"`; (f) `buildReport` on `seedRun` output carries `scorer_health` and `pairs[].band`, and `JSON.parse(JSON.stringify(report))` round-trips.
- **Check command**: `bun test tests/scorer-health.test.ts -t "scorer health"`

### Wiring, renderer, schema

1. `REPORT_SCHEMA_VERSION` → 8 (update any literal pin in `tests/report-v3.test.ts`).
2. `buildReport`: after `pairs = collectPairs(attempts)`, `const bands = collectBands(pairs); for (const p of pairs) p.band = bands.get(p.eval_id) ?? null; const scorer_health = collectScorerHealth(attempts, pairs);` guard the summary; include `scorer_health` in the JSON.
3. `renderReportText`: after the pairs table print `bands: discriminating N · solved by all N · failed by all N` and, when suspects exist, one line per suspect: `suspect: <eval> · <check> failed in <attempts> attempts under <k> arms; passing: <checks>`.

### Matrix bands and banner

**Pattern to follow**: `ui/src/views/Matrix.tsx:300-472`, `ui/src/components/Heatmap.tsx:112-210`, `ui/src/data.ts:96` (`loadReport`).

**Overview**: Matrix currently loads only `run.json`. Load `report.json` too (`loadReport(runId)`; hosted mode fetches it like the Report view does). If the report lacks `pairs[].band` (older snapshot) render the single unbanded heatmap exactly as today.

Layout under the existing "Pass rate per eval × experiment" card head:

```
[scorer-health-banner]  (only when report.scorer_health?.suspects.length > 0)
<section data-testid="matrix-band-discriminating"> <h4>Discriminating (6 evals) — arms disagree</h4> <Heatmap rows=…/> </section>
<details data-testid="matrix-band-solved"> <summary>Solved by every arm (7 evals)</summary> <Heatmap…/> </details>
<details data-testid="matrix-band-failed"> <summary>Failed by every arm (4 evals) — suspect the eval</summary> <Heatmap…/> </details>
```

Rows with `band === null` (single-arm evals, or zero scored) go in the discriminating section with the header "(n evals with one scored arm)" appended, so nothing disappears. Empty bands render nothing. The banner: `<div className="notice" data-testid="scorer-health-banner">` with the `summary` followed by a `<ul>` of `eval_id · check failed in N attempts under K arms · passing: …`.

Existing e2e assertions use `toBeVisible()` on cells: in the sweep seed every eval is discriminating (arms disagree), so they stay visible. Cells inside a collapsed `<details>` are asserted with `toBeAttached()` instead.

**Feedback loop**:

- **Playground**: `bun run ui:dev` after regenerating dev data; the cell-states run shows both collapsed bands and the banner.
- **Experiment**: expand/collapse works with keyboard; banner absent on the sweep run (no suspects); present on the cell-states run naming `uniform-fail`'s check.
- **Check command**: `bun run ui:build && bun run ui:e2e -g "matrix"`

### Seed data

`scripts/seed-site.ts` `seedCellStatesRun` (`:182`): add two evals with **two** experiments each (bands need ≥2 arms): `uniform-pass` — every attempt passes all checks; `uniform-fail` — every attempt fails check `shape-check` and passes check `works-e2e` (→ one suspect). Regenerate dev data; update e2e/test assertions that enumerate the cell-states rows.

## Testing Requirements

| Test File | Coverage |
| --- | --- |
| `tests/scorer-health.test.ts` | bands (5 cases), suspects (6 cases incl. banned-substring name), wiring + round-trip, renderer lines |
| `ui/e2e/smoke.spec.ts` | three band test ids; banner text; collapsed bands attached not visible |

### Manual Testing

- [ ] `bun src/cli.ts report <cell-states run>` prints a `suspect:` line.

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| Summary trips the language guard | `ReportError` at build time (same as methodology) — the template is fixed, so this only fires if someone edits it |
| Report without `band`/`scorer_health` (old snapshot) | UI renders the unbanded matrix and no banner |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Bands | Zero-scored arm counted as an arm | All attempts of an arm errored | Wrong band | Filter `scored > 0` before deciding |
| Suspects | Recall check flagged as suspect | Ungraded check failing everywhere | False instrument alarm | Graded checks only (Phase 2 flag) |
| Suspects | Single-arm eval flagged | Only one experiment ran | "Under every arm" meaningless | Require band `failed-by-all` (≥2 arms) |
| Matrix | Hidden cells break e2e visibility checks | Collapsed `<details>` | Flaky smoke | Sweep seed stays all-discriminating; collapsed cells asserted attached |

## Validation Commands

```bash
bun run typecheck
bun run lint
bun test tests/scorer-health.test.ts tests/report-v3.test.ts tests/export.test.ts tests/graded-checks.test.ts
bun test genericity
bun run ui:dev-data && git diff --quiet -- ui/dev-data && test -z "$(git status --porcelain -- ui/dev-data)"
bun run ui:build && bun run ui:e2e
```

## Rollout Considerations

- **Commit**: `feat(report): band evals and surface scorer health`.
- **Rollback plan**: revert; the UI tolerates reports without the fields.
