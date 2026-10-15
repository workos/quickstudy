# Context Map: prove-the-bench

**Phase**: 5 (Per-experiment leaderboard), extending Phases 1, 2, 3 and 4
**Gates**: 5/5 ready
**Verdict**: GO

Committed so far:
- Phase 1: `7f58dc9`
- Phase 2: `e552338`
- Phase 4: `08805a8`
- Phase 6: `8ba1e80`. Phase 6 made no schema change. It touched `scripts/seed-site.ts`, `docs/concepts.md` and `ui/dev-data`, and it has no section in this map.
- Phase 3: `15568b8` (HEAD). `REPORT_SCHEMA_VERSION` is now 8.

Phase 5 has NOT been implemented: `rg -i leaderboard src ui scripts docs` (excluding ideation) finds nothing. Phase 5 line numbers are from HEAD `15568b8`. Line numbers in the Phase 3, 4, 2 and 1 sections are historical.

---

# Phase 5: Per-experiment leaderboard

## Gates (Phase 5)

| Gate                 | Status | Evidence |
| -------------------- | ------ | -------- |
| Scope clarity        | ready  | The spec names 3 new files (`src/report/aggregate.ts`, `ui/src/components/Leaderboard.tsx`, `tests/leaderboard.test.ts`) and 7 modified paths, each with a concrete change. Scouting found 5 more required changes (see Risks):<br>(1) `tests/scorer-health.test.ts:207` pins `expect(report.schema_version).toBe(8)` as a literal. It must become 9, or be deleted, because `:206` already asserts the symbolic value.<br>(2) `fmtTokens` ALREADY exists (`ui/src/format.ts:2-7`), and it prints `512000` as `"512.0k"`, not the spec's `"512k"`. Strip a trailing `.0`. The existing `format.test.ts:4-11` cases (`148.1M`, `1.8M`, `40.9k`, `512`, `0`, `—`) still pass. `fmtTokens` is also used by `Report.tsx:233` and `Matrix.tsx:156`.<br>(3) The spec's `ExperimentAggregate` has no discriminating passed/scored counts, but the cell renders `11/17 · 6/6`. Add `discriminating_passed` and `discriminating_scored` (or render percentages instead).<br>(4) There is no `.muted` CSS class. The spec's `<span className="muted">` needs a rule, or reuse `.group-sub` / `.attribution-reason`.<br>(5) `agent-label.ts` already exports the non-group `formatAgentLabel(model, reasoning)` (`:16-19`), which gives `"model (reasoning)"`. The spec wants `model · reasoning`. Either reuse it as it is, or add `modelLabel`. |
| Pattern familiarity  | ready  | Patterns read:<br>- `collectTelemetry` `src/report/report.ts:364-378` (the spec's "318-332" has shifted): sums over non-null values, null when there are none.<br>- `collectRecall` `:394-405` and `collectExperiments` `:407-425`.<br>- `buildReport` `:569-641`: bands are assigned at `:583-584` BEFORE `collectExperiments` runs at `:625`, and `costEstimate` is computed at `:591`.<br>- The renderer experiments block `:663-678` and the telemetry lines `:688-706`.<br>- `AttemptCostEstimate`/`RunCostEstimate` in `src/report/costs.ts:52-69`, and `estimateRunCosts` `:106-114`.<br>- `resolveReport` `src/export.ts:179-222`.<br>- `table.data` in `Compare.tsx:166-209` (the spec's "108-157" is now `GroupHeading`/`GroupCard` card heads) and `Report.tsx:247`.<br>- `groupSpans` `Heatmap.tsx:85-112`.<br>- The Matrix report load `Matrix.tsx:318-330` and its card `:503-566`.<br>- The stale-rebuild test `tests/graded-checks.test.ts:161-174`.<br>- The `attempt()`/`trials()` helpers in `tests/scorer-health.test.ts:37-62`.<br>- `seedRun` `scripts/seed-run.ts:361-480` and `pairOutcomes` `:225-234` (the spec's "217-226"). |
| Dependency awareness | ready  | `ReportExperiment` (+`aggregate`) is built only by `collectExperiments` (`report.ts:407`, called once at `:625`). Its readers are `ui/src/views/Report.tsx:155,315-330` (label map and SDK recall card, unaffected) and the renderer `report.ts:663`. `REPORT_SCHEMA_VERSION` 8 → 9 is read by `src/export.ts:198` (a stale report is rebuilt, and a stored `cost_estimate.pricing` is reused) and by `readReportJson` `report.ts:819` (it refuses v8 files on disk). Test pins: `scorer-health.test.ts:207` (literal 8, **must update**); `report-v3:250,279,319`, `export:122,181`, `graded-checks:135,170` and `scorer-health:206` are symbolic. `fmtTokens` is used by `Report.tsx:233` and `Matrix.tsx:156`. `formatAgentLabel` is used by `Report.tsx:157`. `Matrix.tsx` is covered by `ui/e2e/smoke.spec.ts` (served, offline, hosted). `seedRun` costs are pinned by `tests/invariants-v3.test.ts:90-91` (`cost_attempts === completed.length`, `cost_usd ≈ n × 0.11`). |
| Edge case coverage   | ready  | Edge cases:<br>- Regression and other suites are excluded from ALL aggregate numbers (use the seed with `withRegression: true`).<br>- `error`/`incomplete` attempts are not scored, but they count in `attempts`.<br>- A graded timeout is completed, `limitHit === "timeout"`.<br>- Median over odd, even and zero stamps, and stamps on only some attempts.<br>- `pass_rate_*` is null when nothing was scored.<br>- An experiment in `config.experimentIds` with zero attempts (publication-filtered or dropped): every field is null, counts are 0, and the UI shows "—".<br>- A pair whose band is null (one scored arm) is not discriminating.<br>- `discriminating_evals === 0` makes the discriminating rate null, and it sorts last.<br>- Estimated fields only exist when `--pricing` is used, and they are keyed by `attempt_id`: `AttemptCostEstimate` has no experiment id.<br>- `report.experiments` is absent on schema < 4 reports. `[].some(...)` is false, so that report would render an empty table instead of the stale note.<br>- The report load fails (Matrix degrades to `null`): render no leaderboard and no error.<br>- An all-null sort needs the fallback keys.<br>- `-0`/NaN in means when the count is 0. |
| Test strategy        | ready  | Inner loop: `bun test tests/leaderboard.test.ts` (`-t aggregate`, `-t stale`). Then `bun test tests/report-v3.test.ts tests/export.test.ts tests/scorer-health.test.ts tests/graded-checks.test.ts tests/invariants-v3.test.ts tests/costs.test.ts ui/src/format.test.ts`, `bun test genericity`, `bun run typecheck` and `bun run lint`. Then `bun run ui:dev-data`, then `git status --porcelain -- ui/dev-data` (expected: changes once, then is stable on a rerun). Then `bun run ui:build && bun run ui:e2e -g leaderboard` (the test title must contain "leaderboard"), then the full `bun run ui:e2e`. Seed facts give exact expectations (see Key Patterns). Manual check: `bun src/cli.ts report <id> --db seed-results.db --results seed-results/` after `bun scripts/seed-run.ts`. |

## Key Patterns (Phase 5)

- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:364-378` (`collectTelemetry`): `attempts.map(a => a.costUsd).filter((v): v is number => v !== null)`, then `sum` → `length > 0 ? sum : null`. `cost_attempts` is the count of non-null values. `token_attempts = Math.max(in.length, out.length)`. For means, divide each sum by its own non-null count.
  - The spec has a single `token_attempts`. Mirror `Math.max`, or keep separate counts internally.
- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:394-425`:
  - `collectRecall(attempts, experimentId)` filters by `experimentId` and `status === "completed"`.
  - `collectExperiments(run, attempts)` maps the sorted `run.config.experimentIds`.
  - Change the signature to `(run, attempts, pairs, costEstimate)` and add `aggregate: collectExperimentAggregate(attempts, pairs, experimentId, costEstimate)`.
  - Call site: `:625`. `pairs` (bands already set at `:583-584`) and `costEstimate` (`:591`) are both in scope.
  - `ReportExperiment` (`:108-117`) gets `aggregate?: ExperimentAggregate`, optional on the wire, with a JSDoc "absent in schema_version < 9 artifacts; readers must tolerate absence" (precedent: `sdk_recall` JSDoc `:112-115`).
- `/Users/gjtorikian/workos/quickstudy/src/report/scorer-health.ts:11-12, :33+`: the precedent for a sibling module. It has a module JSDoc header and `import type { ReportPair } from "./report.ts"`, a type-only import that avoids a runtime cycle. `report.ts:35-37` imports from the sibling and re-exports its types (`export type { ... } from "./scorer-health.ts"`). Do the same for `ExperimentAggregate`.
- `/Users/gjtorikian/workos/quickstudy/src/report/costs.ts:52-69, :106-114`: `estimateRunCosts` estimates ONLY attempts with `costUsd === null`, and `attempts[]` entries carry `attempt_id`, not an experiment. To filter per experiment, build a `Set` of this experiment's (benchmark) attempt ids and keep the `costEstimate.attempts` entries in it. Then `estimated_cost_usd` = the sum of non-null `cost_usd` (null when none), and `estimated_attempts` = that count. Omit both keys entirely when `costEstimate === undefined` (use a conditional spread, like `cost_estimate` at `report.ts:623`).
- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:663-678`: the renderer's `experiments:` block. The spec wants a fixed-width table after it (before the `retry_history` line at `:680`). Use `padEnd`, and guard with `experiments.some(e => e.aggregate)` so older reports render without it. `pct()` is at `:643`. Header: `experiment · model · pass (all/disc) · agent median · tokens in · cost · recall`.
- `/Users/gjtorikian/workos/quickstudy/src/export.ts:196-201`: the stale rebuild (`!==` REPORT_SCHEMA_VERSION) is ALREADY implemented (Phase 2, `e552338`; `git log -S"schema_version !=="` confirms). Phase 5 only adds the acceptance test. Copy `tests/graded-checks.test.ts:161-174`: a seeded report with `schema_version: 6`, then `exportSite({ store, resultsDir, runIds: [runId], outDir, log })`, then read `data/runs/<id>/report.json`. Additionally assert `experiments[0].aggregate` is defined.
- `/Users/gjtorikian/workos/quickstudy/ui/src/views/Compare.tsx:166-209`: a `.card` > `.head` (h3 + badge) > `.body` > `<table className="data" data-testid=...>` with `<code>` ids and `.attribution-reason` sub-lines, using "—" for missing values. `table.data` CSS is at `styles.css:740-758` (tabular-nums, uppercase th).
- `/Users/gjtorikian/workos/quickstudy/ui/src/components/Heatmap.tsx:85-112` (`groupSpans`): the model label leads and the group name is a demoted sublabel (`.matrix-group-sub, .group-sub` at `styles.css:429-440`). For the first cell: model label, then a muted `experiment_id · treatment` beneath.
- `/Users/gjtorikian/workos/quickstudy/ui/src/views/Matrix.tsx:318-330, :368, :394, :503`:
  - Matrix already loads the report (`useAsync(() => loadReport(runId).then(v => v, () => null))`) and waits for it (`:368`).
  - `reportValue` is `ReportJson | null` (`:394`).
  - Render `<Leaderboard report={reportValue} runId={runId} />` just before the `<div className="card">` at `:503`, only when `reportValue !== null`.
  - Do not add a second load.
- `/Users/gjtorikian/workos/quickstudy/ui/src/agent-label.ts:16-19`: `formatAgentLabel(model, reasoning)` returns null when the model is `"unspecified"`, and omits reasoning when it is `"unspecified"`. `ReportAgentIdentity` (`report.ts:84-91`) has `model`/`reasoning` fields, so no `DataRun` is needed.
- `/Users/gjtorikian/workos/quickstudy/ui/src/format.ts:1-7`: the doc comment lists examples. Add `fmtMs`/`fmtUsd` in the same style, with null returning "—".
- `/Users/gjtorikian/workos/quickstudy/scripts/seed-run.ts:225-234, :428-474`: deterministic expectations for the default seed (3 benchmark evals × 6 experiments × 3 trials):
  - Pass rates (passed/scored):
    - `claude-docs` 9/9 = 1
    - `claude-mcp` 0/9 = 0
    - `claude-cli` 6/9
    - `codex-docs` 6/9
    - `codex-mcp` 3/8 (django has fail/pass/error)
    - `codex-cli` 6/8 = 0.75 (django has pass/pass/incomplete)
  - Every benchmark eval is discriminating, so `pass_rate_discriminating === pass_rate_all` and `discriminating_evals === 3`.
  - Expected sort: claude-docs, codex-cli, claude-cli, codex-docs (6/9 tie broken by id), codex-mcp, claude-mcp.
  - Agent stamps exist only on completed attempts. Duration = `82_000 + sequence*100` ms, where sequence is the 1-based plan index (eval, then experiment, then trial).
  - `tokensIn = 200 + sequence`.
  - EVERY completed attempt has `costUsd: 0.11`, codex included.
  - `withRegression: true` adds `callback-redirect-loop` (suite regression) to the two docs arms. It must not change any aggregate.
- `/Users/gjtorikian/workos/quickstudy/tests/scorer-health.test.ts:37-62`: a hand-built `AttemptRecord` via `as AttemptRecord`, and `trials(evalId, expId, outcomes)`. Extend it with `suite`, `agentStartedAt/agentFinishedAt`, `costUsd`, `tokensIn/Out` and `limitHit` for the unit cases. Build pairs via `collectPairs`, and bands via `collectBands` assigned onto the pairs, the way `buildReport` does.
- `/Users/gjtorikian/workos/quickstudy/tests/costs.test.ts:12-20, :26-61`: the `PRICING` constant and the codex-manifest `beforeEach` store. They are NOT exported, so copy them into `leaderboard.test.ts`. Estimates only apply to `adapter: "codex", provider: "openai"` attempts with `costUsd === null` and a readable transcript (`__fixtures__/streams/codex-turns.jsonl` → $0.00545).

## Dependencies (Phase 5)

- `src/report/report.ts` `ReportExperiment` (+`aggregate`) has these consumers:
  - `collectExperiments` (sole builder).
  - `renderReportText` `:663`.
  - `ui/src/views/Report.tsx:155-158` (label map) and `:315-330` (SDK recall card).
  - The new `Leaderboard.tsx`.
  - `ReportJson` flows through `src/export.ts` (`resolveReport`, `InlineData.reports` in `src/export-types.ts`), `src/cli.ts` and `ui/src/data.ts` `loadReport`. An additive field is safe for all of them.
- `REPORT_SCHEMA_VERSION` 8 → 9 (`report.ts:47`):
  - `src/export.ts:198` rebuilds any stored report ≠ 9, so every committed `ui/dev-data/runs/*/report.json` changes on regeneration.
  - `readReportJson` `:819` refuses v8 files on disk.
  - Literal pin `tests/scorer-health.test.ts:207` (`toBe(8)`) must change.
- `ui/src/format.ts` `fmtTokens` (behaviour tweak) is consumed by `ui/src/views/Report.tsx:22,233` and `ui/src/views/Matrix.tsx:24,156`. Only whole-number k/M values change (`"1.0M"` → `"1M"`). No e2e asserts those strings (`rg "\.0k|\.0M" ui/e2e` is worth a check before editing).
- `ui/src/views/Matrix.tsx` is rendered by `ui/src/App.tsx` for `#/run/:id` and the cell routes. Its e2e coverage is in `ui/e2e/smoke.spec.ts:64-88` (served matrix), `:140-305` (cell states/bands), `:411-450` (offline), `:483-515` (single-suite and hosted). The leaderboard adds DOM above the heatmap card, so no existing locator should collide unless it uses a generic `table`/`tr`. `rg "locator\(\"table|locator\(\"tr" ui/e2e` shows none are expected.
- `scripts/seed-run.ts` is consumed by `seed-site.ts:306,310` (the sweep with `withRegression: true`, and n1) and many tests. Do NOT change its cost values, because `tests/invariants-v3.test.ts:90-91` pins them.
- `docs/concepts.md`: "## What a run tells you" is at `:167` and "### Bands and scorer health" at `:195`. Add a "### Leaderboard" subsection after bands (before "## Isolation and secrets" at `:242`).

## Conventions (Phase 5 additions)

- **Wire naming**: snake_case aggregate fields (`pass_rate_all`, `median_agent_ms`, `cost_attempts`). Rates and means are `number | null`, and null means unavailable, never 0 (CLAUDE.md telemetry rule).
- **Optional fields on the wire**: `estimated_*` keys are omitted entirely without pricing, not set to null. This matches `cost_estimate`'s conditional spread (`report.ts:623`).
- **Determinism**: aggregates are pure functions of `attempts`/`pairs`, so regenerated dev data stays byte-identical. The sort comparator must be total (id last).
- **UI**: kebab-case test ids (`leaderboard`, `leaderboard-row-<experiment_id>`, `leaderboard-stale`). Missing values render as "—". An optional report never shows an `ErrorPanel`. `.notice` is the stale-banner class (`styles.css:157`).
- **Tests**: `bun:test`, `mkdtempSync` roots cleaned in `afterEach`, and `describe("aggregate")` / `describe("stale ...")` names so `-t aggregate` and `-t stale` scope correctly.

## Risks (Phase 5)

- **Literal schema pin outside the spec's list.** `tests/scorer-health.test.ts:207` `toBe(8)` fails at v9.
- **The spec's e2e/playground expectation contradicts the seed.** The spec says "cost cell on codex rows reads `not reported`", but `seed-run.ts:463` gives EVERY completed attempt, codex included, `costUsd: 0.11`. Every sweep row will read `$0.xx · n/m reported`. Do not change the seed, because `invariants-v3.test.ts:90-91` pins `n × 0.11`. Assert "reported" in e2e (which matches the spec's Testing table). Cover `not reported (0/N)` in the unit test, or in a hand-built report, instead.
- **Missing discriminating counts.** The `11/17 · 6/6` display needs discriminating passed/scored. The spec's interface only has rates. Add `discriminating_passed`/`discriminating_scored`, or show `pct()`. Also decide what `discriminating_evals` counts. Recommended: the distinct benchmark evals with band `"discriminating"` in which this experiment has at least one scored attempt.
- **Suite filter scope is ambiguous.** The spec says the pass rate is over benchmark pairs. Recommended: apply `suite === "benchmark"` to EVERY aggregate field (counts, median, tokens, cost, estimated), so that one denominator (`attempts`) applies across the row. Note that `cost_usd` will then differ from `report.telemetry.cost_usd` on runs with regression evals. Document this in `docs/concepts.md`.
- **`fmtTokens` already exists.** Change it in place; do not add a duplicate. `512_000` currently prints `"512.0k"`, and the spec wants `"512k"`. Strip a trailing `.0` in both the k and M branches, and keep the existing tests green.
- **`sdk_recall` for the recall column.** It is computed over ALL suites (`collectRecall` has no suite filter). The recall column is therefore not benchmark-filtered, unlike the other columns. Accept this and note it in docs, or leave `collectRecall` unchanged (changing it would alter Phase 2 numbers).
- **Stale detection edge.** `report.experiments` is absent on schema < 4 reports, so `(report.experiments ?? []).some(e => e.aggregate === undefined)` is false and renders an empty table. Use `!report.experiments?.length || report.experiments.some(...)` for the stale note.
- **Old stored `report.json` on disk.** After the bump, `quickstudy report --read` (via `readReportJson`) refuses v8 files, which is existing behaviour. The export path auto-rebuilds.
- **Rendering null/zero.** For an experiment with zero benchmark attempts, all rates, the median and the means are null and the counts are 0. The UI must show "—" rather than `0/0`. Guard divide-by-zero in the means.
- **Decision log check.** No contradiction with the codebase:
  - `DATA_SCHEMA_VERSION` is still 3 (`src/export-types.ts:38`), and the stale-schema rebuild exists at `src/export.ts:196-201`.
  - There is no per-attempt `cost_source` anywhere; `ReportTelemetry` has `cost_usd`/`cost_attempts` (`report.ts:238-245`).
  - The model-pin headers already lead with the model (`groupSpans`).
  - Only the agent-phase stamps are persisted (`AttemptRecord.agentStartedAt/agentFinishedAt`, `src/store/db.ts:134-136`), with no score-phase pair.

---

# Phase 3: Eval bands and scorer health (retained, implemented in `15568b8`)

## Gates (Phase 3)

| Gate                 | Status | Evidence |
| -------------------- | ------ | -------- |
| Scope clarity        | ready  | The spec names 2 new files and 8 modified paths, each with a concrete change. Scouting found 4 more required changes (see Risks):<br>(1) `tests/graded-checks.test.ts:135` pins `expect(report.schema_version).toBe(7)` as a literal. It must become 8 or `REPORT_SCHEMA_VERSION`. The spec points at `report-v3.test.ts`, but every pin there is symbolic.<br>(2) `collectPairs` (`src/report/report.ts:278-292`) builds the `ReportPair` literal. A required `band` field needs `band: null` in that initializer, or typecheck breaks. `src/diagnose/select.ts:9` also consumes `collectPairs`.<br>(3) `ui/e2e/smoke.spec.ts:230` runs `expect(page.locator(".scroll-hint")).toBeVisible()` on the cell-states run. With three `Heatmap`s there are three `.scroll-hint` nodes, which is a Playwright strict-mode violation. Use `.first()`, or render one hint outside the heatmaps.<br>(4) `seedCellStatesRun` builds its manifest and `config.evalIds` from `SEED_EVALS` (`scripts/seed-site.ts:194-203`). The new evals need a `CELL_STATE_EVALS` list, or `trialCoverage` marks the run incomplete and the manifest lacks their metadata. `CellStateSpec` also needs a per-spec checks override so `uniform-fail` can emit `shape-check` and `works-e2e`. |
| Pattern familiarity  | ready  | Patterns read:<br>- `collectPairs` `report.ts:273-327`<br>- `collectRecall` `:370-381`, a per-attempt, completed-only filter to mirror<br>- the `buildReport` methodology guard `:568-573`<br>- the returned JSON `:575-611`<br>- the renderer pairs loop `:683-701`<br>- `Matrix.tsx` `grid` memo `:338-358` and card `:458-485`<br>- `Heatmap.tsx` `Heatmap` `:112-210` and `groupSpans` `:88-110`<br>- `data.ts:100` `loadReport`<br>- the degrade-on-error `loadReport` pattern in `ui/src/views/Diagnosis.tsx:272-280`<br>- `.notice` CSS `styles.css:157-164`<br>- `seedCellStatesRun` `seed-site.ts:188-255`<br>- the `attempt()` helper style in `tests/graded-checks.test.ts:48-70` |
| Dependency awareness | ready  | `ReportPair` consumers: `src/diagnose/select.ts:9,24` (`collectPairs`, a `Pick` of the tallies), `ui/src/views/Report.tsx:13,36,50`, `ui/src/views/Diagnosis.tsx:24,107,277`, `ui/src/diagnosis-clusters.ts:2,27,45`, and `tests/diagnose-clusters.test.ts:61` (an `as unknown as` cast, which is safe). `ReportJson` consumers are `src/export.ts`, `src/cli.ts`, `src/export-types.ts:127` (`InlineData.reports`), `ui/src/data.ts` and `Report.tsx`.<br><br>`REPORT_SCHEMA_VERSION` consumers:<br>- `src/export.ts:198`: a stored report with a different version is rebuilt, so committed v7 dev-data reports rebuild.<br>- `readReportJson` `report.ts:778` refuses other versions, so a v7 `report.json` on disk must be regenerated with `quickstudy report`.<br>- Tests: `report-v3:250,279,319` and `export:122,181` (symbolic), plus `graded-checks:135` (literal 7).<br><br>`seedSite` consumers are `scripts/make-dev-data.ts` and `ui/e2e/fixture-server.ts` only. |
| Edge case coverage   | ready  | Edge cases:<br>- An arm with scored 0 is excluded from the band.<br>- An eval with one scored arm gets band null and still appears in the discriminating section.<br>- A check absent from some scored attempts must not count as "failed in every attempt".<br>- A pair tally is ungraded if any attempt flags `graded:false`.<br>- Several suspects can come from one eval.<br>- Every graded check failing gives no suspect.<br>- A publication-filtered report must feed the same `attempts`.<br>- A check name containing "caus" must stay out of `summary`. It can still appear in the renderer's `suspect:` line.<br>- Old reports without `band`/`scorer_health` must render unbanded.<br>- A failed or offline report load in Matrix must degrade.<br>- Filters or suite can empty a band.<br>- An eval present in `run.json` but absent from `report.pairs` (publication omitted) must be treated as null.<br>- Duplicate `aria-label="Pass-rate matrix"` regions.<br>- Focus return into a collapsed `<details>`. |
| Test strategy        | ready  | Inner loop: `bun test tests/scorer-health.test.ts` (`-t bands`, `-t "scorer health"`).<br>Then `bun test tests/report-v3.test.ts tests/export.test.ts tests/graded-checks.test.ts tests/diagnose-clusters.test.ts tests/diagnose.test.ts`, `bun test genericity`, `bun run typecheck` and `bun run lint`.<br>Then `bun run ui:dev-data`, then `git status --porcelain -- ui/dev-data` (expected: changed once, then stable on a rerun).<br>Then `bun run ui:build && bun run ui:e2e -g "matrix"`, then the full `bun run ui:e2e`.<br>Manual check: seed with `bun scripts/seed-site.ts` if it runs standalone. Otherwise use `buildReport` on the cell-states run in a test, and assert that `renderReportText` contains `suspect: uniform-fail · shape-check`. |

## Key Patterns (Phase 3)

- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:273-327` (`collectPairs`), the spec's "246-304", now shifted:
  - Pairs come from a `Map` keyed `${evalId}|${experimentId}` and are sorted by eval, then experiment.
  - `scored = passed + failed`. `pass_rate` is null at 0.
  - Checks are tallied over EVERY attempt with `result.checks`, not only completed ones.
  - For `collectBands`, group `pairs` by `eval_id` and filter `scored > 0`. Then: fewer than 2 gives null; all `pass_rate === 1` gives solved-by-all; all `=== 0` gives failed-by-all; anything else is discriminating.
- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:370-381` (`collectRecall`): the per-attempt pattern to copy for `collectScorerHealth`.
  - Filter `attempt.status === "completed"`. "Scored" means completed, and graded timeouts are completed.
  - Read `attempt.result?.checks ?? []`.
  - `check.graded === false` means ungraded.
- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:51-74`: `BANNED_LANGUAGE`, `findBannedLanguage` and the `methodologyNote(trials)` concatenated string. Append the spec's scorer-health sentence to the end, after the "Ungraded checks are recorded..." sentence. It is guard-clean: no "caus", "effect of" or "significant".
- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:564-611` (`buildReport`):
  - `attempts` is the publication-filtered set (:566), and `pairs = collectPairs(attempts)` (:567).
  - Guard: `findBannedLanguage(methodology)` followed by `throw new ReportError("report methodology violates the language guard: ...")` (:570-573). Copy it for `scorer_health.summary`.
  - Add `scorer_health` to the returned object after `pairs` (:604).
- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:683-701`: the renderer's pairs loop. Put the `bands:` line and the `suspect:` lines right after it and before `comparison groups` (:703).
  - Use `report.pairs.some(p => p.band !== undefined)` or optional chaining so old reports render without the lines.
  - Existing optional-field precedent: `experiment.sdk_recall` at :676.
- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:113-126, :146, :238-262`: new optional-on-wire fields get a JSDoc such as "absent in schema_version < N artifacts; readers must tolerate absence".
  - Recommended: `ReportPair.band: EvalBand | null` required in the TS type (always emitted), but UI readers use `pair.band === undefined` as the old-snapshot signal.
  - `ReportJson.scorer_health?: ScorerHealth` optional, with a JSDoc "absent in schema_version < 8".
- `/Users/gjtorikian/workos/quickstudy/ui/src/views/Diagnosis.tsx:272-283`: the pattern for Matrix's second load.
  - It uses `useAsync(() => loadReport(runId).then(v => v.pairs ?? null, () => null), [runId])`, so a failure degrades and never shows an error.
  - It waits for `report.status === "loading"` before rendering.
- `/Users/gjtorikian/workos/quickstudy/ui/src/views/Matrix.tsx:338-358`: `grid` memo (suite plus metadata filters, then `rows`/`columns`/`cells`).
  - Partition `grid.rows` by a `Map<eval_id, band>` built from `report.pairs`. `columns` and `cells` are shared by all three heatmaps.
  - The card is at :458-485 (`.card > .head h3` + `HeatmapLegend`, then `<Heatmap .../>`). Put the banner and the three sections inside the card, below the head.
- `/Users/gjtorikian/workos/quickstudy/ui/src/components/Heatmap.tsx:112-210`: one `matrix-region` holding a `.scroll-hint` and a `role="region" aria-label="Pass-rate matrix"` scroller.
  - Add an optional `band?: string` prop and use it in the `aria-label` (e.g. `Pass-rate matrix — ${band}`) so the three regions get distinct names. The spec calls it a header label.
  - Leave cells and `groupSpans` untouched. `groupSpans` at :88-110 already leads with the model pin, which confirms that decision-log entry.
- `/Users/gjtorikian/workos/quickstudy/ui/src/styles.css:157-164`: `.notice` (amber) is the banner class, reused by `incomplete-banner` (`Matrix.tsx:430`).
  - There is no `details` styling except `.usage-values summary` (:699).
  - Add a small `details.band` / `details.band > summary` rule.
  - Keep it tiny: `scripts/check-bundle-size.ts` enforces a 1.5 MiB gzip budget, but only warns.
- `/Users/gjtorikian/workos/quickstudy/scripts/seed-site.ts:188-255` (`seedCellStatesRun`):
  - It iterates `CELL_STATES` (:103-109) and writes `result: { passed, checks: cellStateChecks(passed) }` (:236). `cellStateChecks` (:181-186) returns `flow-wired` and `build-passes`.
  - The manifest is built with `buildSeedManifest(SEED_EVALS, CELL_STATE_EXPERIMENTS, ...)` and `config.evalIds` with `SEED_EVALS.map(...)`.
  - `CELL_STATE_EXPERIMENTS` is `claude-docs` + `claude-mcp` (:91-93), so there are exactly 2 arms.
  - `SeedEvalSpec` is `{id, framework, suite}` (`scripts/seed-run.ts:115-125`). Metadata topics are derived from `framework`.

## Dependencies (Phase 3)

- `src/report/report.ts` `ReportPair` (+`band`) consumers:
  - `collectPairs` itself: the literal at :278-292 needs `band: null`.
  - `src/diagnose/select.ts:9,24,102`: tallies/flaky only, unaffected.
  - `ui/src/views/Report.tsx:36,50`: reads `pass_at_k` and checks.
  - `ui/src/views/Diagnosis.tsx:277` and `ui/src/diagnosis-clusters.ts:27`: read checks.
  - `tests/diagnose-clusters.test.ts:61-62`: an `as unknown as ReportPair` cast.
- `src/report/report.ts` `ReportJson` (+`scorer_health`) consumers are `src/export.ts:36,179-212` (`resolveReport`), `src/export-types.ts:127` (`InlineData.reports`), `src/cli.ts` (report command), `ui/src/data.ts:100` (`loadReport`) and `ui/src/views/Report.tsx`. Adding a field is safe for all of them.
- `REPORT_SCHEMA_VERSION` 7 → 8:
  - `src/export.ts:198-199` rebuilds stored reports whose version differs, so committed `ui/dev-data/runs/*/report.json` changes on regeneration. The seeder writes through `buildReport` anyway.
  - `readReportJson` (`report.ts:778`) refuses v7 files on disk.
  - Tests: `tests/graded-checks.test.ts:135` (literal `7`, **must update**). `:163` uses a stale literal of 6 and stays stale, which is fine. `tests/report-v3.test.ts:250,279,319` and `tests/export.test.ts:122,181` are symbolic.
- `ui/src/views/Matrix.tsx` is rendered by `ui/src/App.tsx` for `#/run/:id` and the cell routes. Its test ids are exercised by `ui/e2e/smoke.spec.ts:65-88, 140-262, 368-380, 439-470`.
- `ui/src/components/Heatmap.tsx` is used only by `Matrix.tsx`. `formatRate` is also used by `Matrix.tsx` DrillDown.
- `scripts/seed-site.ts` is consumed by `scripts/make-dev-data.ts` and `ui/e2e/fixture-server.ts` (the `/site`, `/site-hosted` and `/site-single` exports).
  - The `runIds` order `[sweep, cellStates, n1]` is asserted at `smoke.spec.ts:48-51`.
  - No `tests/*.test.ts` imports `seedSite`.

## Conventions (Phase 3 additions)

- **Wire naming**: snake_case (`scorer_health`, `passing_checks`, `eval_id`). Band literals are kebab-case (`solved-by-all`).
- **Sorting**: deterministic. Suspects are sorted by `attempts` desc, then `eval_id` (then `check` for stability). `experiments` and `passing_checks` are sorted with `localeCompare`, so dev data stays byte-identical.
- **Guarded prose**: fixed templates only. Names travel in structured fields. The UI composes `eval_id · check failed in N attempts under K arms · passing: …`.
- **UI degradation**: an optional report load must never show an `ErrorPanel` (Diagnosis precedent). A missing `band` means an old snapshot, which renders exactly today's single heatmap.
- **Test ids**: kebab-case, `matrix-band-discriminating|solved|failed` and `scorer-health-banner`, per the spec.
- **Tests**: `bun:test`, a hand-built `AttemptRecord` helper like `tests/graded-checks.test.ts:48-70`, `seedRun` from `scripts/seed-run.ts` for wiring, and `mkdtempSync` temp roots cleaned in `afterEach`.

## Risks (Phase 3)

- **Literal schema pin outside the spec's list.** `tests/graded-checks.test.ts:135` `toBe(7)` fails at v8. Change it to `REPORT_SCHEMA_VERSION`.
- **Playwright strict mode on `.scroll-hint`.** `smoke.spec.ts:230` targets the cell-states run, which will render three heatmaps: discriminating, solved (`uniform-pass`) and failed (`uniform-fail`). `page.locator(".scroll-hint")` then matches three nodes and `toBeVisible()` throws. Fix it with `.first()`, or hoist a single hint out of `Heatmap`. Collapsed `<details>` content is hidden, but it still counts toward the strict-mode match.
- **Cell-states seed plumbing.**
  - Add `CELL_STATE_EVALS = [...SEED_EVALS, {id:"uniform-pass",...}, {id:"uniform-fail",...}]` and use it for both `buildSeedManifest` and `config.evalIds`. Otherwise `trialCoverage` flags the run incomplete and the incomplete banner appears, and metadata filters lose the rows.
  - Give each 3 trials × 2 arms (`claude-docs`, `claude-mcp`) so coverage stays complete.
  - Add an optional `checks?: (passed) => CheckResult[]` to `CellStateSpec`.
  - `uniform-fail` records `passed: false` with `[{shape-check, false}, {works-e2e, true}]`.
  - Pick a framework value carefully: a new one such as `"generic"` adds an option to `filter-framework`. That is harmless, because no e2e test enumerates the options.
- **Existing bands in the cell-states run.**
  - `auth-nextjs` is 0/3 against 1/1, so discriminating.
  - `auth-rails` is 3/3 against 0/3, so discriminating.
  - `auth-django` has only `claude-docs`, so its band is null and it lands in the discriminating section with the "(1 eval with one scored arm)" suffix.
  - All currently asserted cells stay visible. `auth-nextjs×claude-docs` (flow-wired fails, build-passes passes) produces NO suspect, because its eval is discriminating. So the cell-states run has exactly one suspect.
  - The sweep and n1 runs are all discriminating (claude-docs 1.0 against claude-mcp 0; regression eval 0/3 against 1/3), which confirms the spec's claim.
- **"Failed in every scored attempt" is ambiguous when a check is missing from some attempts.** Recommended: count a check as a suspect only when it is PRESENT with `passed:false` in every completed attempt of the ≥2 scored arms. Count a passing check only when it is present with `passed:true` in all of those attempts. Add a test.
- **Graded determination.** Per-attempt `check.graded === false` is ungraded. Mirror the pair tally: if any attempt flags a name ungraded, exclude that name from both the suspect and passing sets.
- **Population.** `collectScorerHealth` must receive the same publication-filtered `attempts` as `collectPairs` (`report.ts:566`). "Experiments" are the pairs with `scored > 0`. `attempts` counts completed attempts across them.
- **Renderer lines interpolate names.** The `suspect:` line prints check and eval names, so a `causal-link` check would put "caus" into the text. `tests/report-v3.test.ts:241` asserts that the rendered text is guard-clean, but only on seeded data, which is safe. Do not add a renderer-guard assertion in the banned-name test (e).
- **Matrix load and latency.**
  - Hosted mode fetches `report.json` for the selected run. The hosted e2e (`smoke.spec.ts:458-470`) only asserts that `/runs/<sweep>/snapshots/` was requested and `/runs/<cellStates>/` was not, so the extra fetch in the same run dir is fine.
  - Offline `/site` reads `inline.reports`.
  - `/site-single` builds reports at export time via `resolveReport`.
  - Wait for both loads, as Diagnosis does, to avoid an unbanded-then-banded layout flip. On report error, fall back to the unbanded heatmap.
- **Collapsed `<details>` and drill-down focus return.** `Matrix.tsx` DrillDown restores focus to `cell-<eval>-<exp>` (`:236-245`). A cell inside a `<details>` the user collapsed after opening the drill-down cannot be focused, and restoration fails silently. Leave `<details>` uncontrolled, with no `open` prop, so React keeps the user's toggle across re-renders.
- **Band map vs filtered rows.** Bands come from `report.pairs` for the whole run, and rows come from the suite and metadata filters. Compute section counts from the FILTERED rows. Treat an eval missing from `report.pairs` (publication-omitted) as null.
- **Docs.** `docs/concepts.md` "## What a run tells you" (:167-215) is where a "Bands and scorer health" subsection belongs. `concepts.md` is not in `SMOKE_DOCS`, so bash blocks are unconstrained there, but prefer inline code anyway. Keep the prose vendor-neutral for genericity.
- **Decision log check.** No contradiction with the codebase:
  - `DATA_SCHEMA_VERSION` is still 3 (`src/export-types.ts:38`).
  - `REPORT_SCHEMA_VERSION` is 7 (`report.ts:44`). Phase 6 did not bump it.
  - `groupSpans` already leads with the model pin (`Heatmap.tsx:88-110`).
  - No band or scorer-health computation exists client-side or in diagnose.

---

# Phase 4: Oracle adapter, solution/ convention, validate --oracle (retained, implemented in `08805a8`)

## Gates (Phase 4)

| Gate                 | Status | Evidence |
| -------------------- | ------ | -------- |
| Scope clarity        | ready  | The spec names 9 new paths and 12 modified paths, each with a concrete change. Scouting found 5 more required changes (see Risks):<br>(1) `scripts/seed-run.ts:154-170` builds `EvalIdentity` literals. A required `solution` field breaks `bun run typecheck` unless `solution: null` is added.<br>(2) `tests/plan-v3.test.ts:7-15` builds a `LoadedEval` literal. It needs `solutionDir: null`.<br>(3) `tests/identity-v3.test.ts:73` pins the EvalIdentity key set `["components","hash","id","metadata"]`. Add `"solution"`.<br>(4) Putting `oracle-local.ts` in `tests/__fixtures__/experiments/` breaks `tests/runner-v3.test.ts:49` (`toEqual(["echo-local"])`), `:166-178` and `tests/graded-checks.test.ts:195`. Those tests plan over every fixture experiment, so oracle × a solution-less eval trips the new preflight. Move the fixture to `tests/__fixtures__/oracle/experiments/oracle-local.ts`.<br>(5) The `HELP.validate` string at `src/cli.ts:107` needs `--oracle` alongside `USAGE`. |
| Pattern familiarity  | ready  | Read `src/evals/discovery.ts:53-115` (local/ handling: plain at :53-60, framework at :62-115), `src/manifest.ts:152-171` (`buildRunManifest` eval loop), `src/adapters/echo.ts`, `src/adapters/types.ts:76-150`, `src/runner/execute.ts:587-594` (`prepWorkspaceSource`), host path `:597-661`, container path `:698-988`, `scoreAttempt` `:992-1045`, `src/runner/context.ts`, `src/runner/score-worker.ts`, `src/runner/scorer-worker.ts`, `src/cli.ts:128-199` (`commandValidate`), and the fixtures `hello-local`, `multi-fw` and `experiments/echo-local.ts`. |
| Dependency awareness | ready  | `LoadedEval` is built only in discovery, plus one test literal. `EvalIdentity` is built in `manifest.ts` and `scripts/seed-run.ts:154`, and read by `ui/src/views/Matrix.tsx:40` (metadata only), `groups.ts:51` (keys only) and the seeders (`.hash` only). `prepWorkspaceSource` is private to `execute.ts`, with 2 call sites (:616 host, :733 container). `buildEvalContext` is used by `scoreAttempt` :1026 and `scorer-worker.ts:45`. The `defaultHostAdapters`/`defaultContainerAdapters` registries are at `execute.ts:168-178`. Adding `solution` changes `manifest.hash` (`manifest.ts:205-213` hashes all of `evals`), which gates resume at `execute.ts:440`. |
| Edge case coverage   | ready  | Edge cases:<br>- Scorers run in a worker. `RuntimeCapabilityError` identity is lost across the boundary, but parent-side tracking still works.<br>- A scorer that swallows the capability error.<br>- A scorer that times out under validate.<br>- A semantic scorer with no `agentOutput`.<br>- `solution/` present but missing one framework dir.<br>- The solution file overrides the local file (`cp force`).<br>- An eval with no `local/` but with `solution/`.<br>- Oracle container experiments must not set `runtime.command`, which bypasses adapter resolution at `execute.ts:352`.<br>- Empty stdout from `true` goes through `parseStream("")` and `extractAgentOutput("")`.<br>- `alpine:3` has no git, so the diff is empty with a log line.<br>- `validate` with no experiments root present.<br>- The `ready` output count: 3 lines, not 2.<br>- A resume across the upgrade is refused.<br><br>Details are under Risks. |
| Test strategy        | ready  | Inner loop: `bun test tests/oracle.test.ts tests/evals-discovery.test.ts tests/identity-v3.test.ts`. Scoped with `-t discovery`, `-t identity`, `-t run`, `-t validate`. Then `bun test adapters cli runner-v3 graded-checks plan-v3 outcome-taxonomy`, `bun test genericity`, `bun test docs-smoke` (if docs get new bash blocks), `bun run typecheck` and `bun run lint`. The CLI checks: `bun src/cli.ts validate --oracle --evals-root tests/__fixtures__/oracle/ready` (exit 0, 3 × `1.0`), then `broken` (exit 1, `notes-written`), `deferred` (exit 0, `deferred`), and `tests/__fixtures__/evals` (exit 1, 6 × `MISSING`). Baseline `validate --evals-root tests/__fixtures__/evals` currently lists 6 evals and exits 0. The Docker case uses `requireDockerOrSkip` (`tests/helpers.ts:26`) and `alpine:3` (`tests/docker.test.ts:36`). |

## Key Patterns (Phase 4)

- `/Users/gjtorikian/workos/quickstudy/src/evals/discovery.ts:53-60`: plain evals use `existsSync(x) && statSync(x).isDirectory()` and push `{ metadata, dir, promptPath, promptBody, scorerPath, localDir }`. Add `solutionDir` the same way.
- `/Users/gjtorikian/workos/quickstudy/src/evals/discovery.ts:90-115`: the framework loop.
  - It throws `EvalLoadError(promptPath, 1, "eval \"<id>\" lists framework ... (expected <dir>)")` when a per-framework dir is missing. Mirror that for `solution/<fw>` using the spec's message.
  - Solutions always resolve under `join(dir, "solution")`. There is no `local:`-style shared path.
  - Error-message style: `metadata.id` (the unexpanded id) inside quotes, and the expected absolute path in parentheses.
- `/Users/gjtorikian/workos/quickstudy/src/manifest.ts:155-171`: per-eval `components` object, then `{ id, metadata, components, hash: contentHash(components) }`. Add `solution: loaded.solutionDir === null ? null : hashTree(loaded.solutionDir).sha256` next to `hash` and outside `components`. `hashTree` is already imported (`:16`). Document the field on the `EvalIdentity` interface (`:55-60`).
- `/Users/gjtorikian/workos/quickstudy/src/adapters/echo.ts`: this is the host no-op template.
  - It defines an `identity` object literal with `nativeWebControl: "controlled" as const`.
  - `runAttempt` does `cp(ctx.fixtureDir, ctx.workspaceDir, { recursive: true })`.
  - The file opens with a JSDoc header explaining why the adapter exists.
  - Echo writes NOTES.md. The oracle must not.
- `/Users/gjtorikian/workos/quickstudy/src/adapters/types.ts:76-81, :113-150`:
  - `AgentAdapter` is `{ name, identity?, runAttempt }`.
  - `ContainerAgentAdapter` is `{ kind: "container", name, identity?, versionCommand?, keyProbe?, requiredHostEnv, egressHosts?, setupFiles, command, parseStream }`.
  - Add a documented `startingState?: "fixture" | "solution"` to both.
  - Consider exporting `StartingState` from `types.ts` (or from `workspace-source.ts`) so both files share one union.
- `/Users/gjtorikian/workos/quickstudy/src/runner/execute.ts:587-594`: the current `prepWorkspaceSource(loadedEval)`. Move it to `src/runner/workspace-source.ts`. `execute.ts:23-25` imports `cp`, `mkdtemp`, `rm`, `tmpdir` and `join`. Keep them, because they are still used elsewhere in the file (`rm` and `mkdtemp` at :617 and :660).
- `/Users/gjtorikian/workos/quickstudy/src/runner/execute.ts:168-178`: the registries. `defaultHostAdapters` keys by `echo.name`. `defaultContainerAdapters` maps name → `(agent) => adapter`. Add `oracle` to both.
- `/Users/gjtorikian/workos/quickstudy/src/runner/execute.ts:329-362`: the preflight loop over `plan` (unknown eval/experiment, host adapter presence, container adapter resolution via `resolveContainerAdapter` :186-216). Put the solution check after this loop and before the `validateProviderKeys` at :377, which runs before any run row.
  - Host adapter: `hostAdapters[experiment.agent.adapter].startingState`.
  - Container adapter: `containerAgents.get(experiment.id)?.startingState`.
  - Collect every offending `<experiment> × <eval>` pair, then throw once.
- `/Users/gjtorikian/workos/quickstudy/src/runner/execute.ts:992-1045` (`scoreAttempt`): wraps the work in `deadline("scoring", budgets.scoreMs ?? DEFAULT_BUDGETS.scoreMs, async (signal) => scoreInWorker(scorerPath, buildEvalContext({...}), signal))`, then runs `validEvalResult(result)`. `validateOracle` should copy this shape, including the `validEvalResult` check (`src/evals/result.ts`). `DEFAULT_BUDGETS` lives in `src/execution-policy.ts:14`.
- `/Users/gjtorikian/workos/quickstudy/src/runner/context.ts:85-94`: the default `query`/`getClient` throw a plain `Error("this experiment runtime does not provide query() (experiment \"<id>\")")`. Swap in `RuntimeCapabilityError` with the same message text. No test pins the text (`rg` finds none).
- `/Users/gjtorikian/workos/quickstudy/src/runner/score-worker.ts:45-89`: the worker issues RPCs, and the PARENT calls `context.exec`, `context.query` and `context.getClient`. So parent-side tracking wrappers do see every invocation. Errors are serialised as `error.message` only (`:76`, and on the worker side `scorer-worker.ts:38`). This is why the tracking Set, not `instanceof`, has to decide `deferred`.
- `/Users/gjtorikian/workos/quickstudy/src/cli.ts:128-199` (`commandValidate`):
  - `parseArgs` options at :134-137.
  - The eval list is at :163-175. Append `; solution/` there, after `; local/`.
  - `fail()` is at :123 (`console.error` + `process.exit(1)`). Print every per-eval line to stdout BEFORE calling `fail()`.
  - `USAGE` is at :68-71 and `HELP.validate` at :107.
- Fixtures: `/Users/gjtorikian/workos/quickstudy/tests/__fixtures__/evals/hello-local/{PROMPT.md,EVAL.ts,local/README.md}`.
  - The scorer checks that README.md contains `"hello-local starting state"` and that NOTES.md contains `"Notes"`.
  - A verbatim copy therefore needs `local/README.md` to contain `hello-local starting state` and `solution/NOTES.md` to contain `Notes`.
  - `multi-fw/PROMPT.md` shows the `frameworks: [alpha, beta]` shape.
  - `experiments/echo-local.ts` is the `defineExperiment` host template. It pins `model: "echo-v1"`; pin `model: "oracle-v1"` the same way.

## Dependencies (Phase 4)

- `src/evals/types.ts` `LoadedEval` (+`solutionDir`) is built only by `src/evals/discovery.ts`. It is also built as a literal in `tests/plan-v3.test.ts:7-15` (needs `solutionDir: null`), spread in `tests/outcome-taxonomy.test.ts:192` (fine) and exported from `src/index.ts:17` as a public type. Consumer repos do not construct it.
- `src/manifest.ts` `EvalIdentity` (+`solution`) consumers:
  - `scripts/seed-run.ts:152-170` (literal, needs `solution: null`, or the field must be optional).
  - `ui/src/views/Matrix.tsx:40` (`.metadata`).
  - `src/experiments/groups.ts:51` (keys).
  - `scripts/seed-run.ts:428` and `scripts/seed-site.ts:232` (`.hash`).
  - `tests/identity-v3.test.ts:73` (key snapshot).
  - `manifest.hash` includes `evals`, which is persisted as `runs.manifest_hash` (`src/store/db.ts:286`) and compared on resume (`execute.ts:440`).
  - `attemptIdentityHash` (`:217-228`) uses only `evalIdentity.hash`, so attempt identity is unchanged.
- `src/adapters/types.ts`: the optional field is safe for the `claude.ts`, `codex.ts` and `echo.ts` adapters and for test doubles.
- `src/runner/execute.ts` `executeRunV3` is consumed by `src/cli.ts`, `scripts/dev-attempt.ts`, and the tests runner-v3, docker, egress-e2e, treatment-runtime, lifecycle, experiments-v3, semantic-runner, outcome-taxonomy and graded-checks. The preflight only fires for adapters with `startingState: "solution"`, so it is inert unless a plan includes oracle, with the fixture-location caveat under Risks.
- `src/runner/context.ts` `buildEvalContext` is consumed by `execute.ts:1026` and `scorer-worker.ts:45`. The error-class swap keeps the same message text.
- `src/cli.ts` `validate`: `tests/cli.test.ts:88-104` covers the positional refusal and the no-roots message, and neither changes. `tests/docs-smoke-inventory.ts` plus `scripts/docs-smoke.ts:35` (`SMOKE_DOCS` = README.md, docs/getting-started.md, docs/writing-an-eval.md) apply a drift guard: every new ```bash block in those docs needs an INVENTORY entry.
- `src/index.ts`: adding `export type { RuntimeCapabilityError }` is allowed, but see Risks for its limited value.

## Conventions (Phase 4 additions)

- **Adapter identity**: `{ provider: "local", model: "<name>-v1", reasoning: "none", cliVersion: "built-in", surfacePolicies: {docs,mcp,cli: "no-network"}, nativeWebControl: "controlled" as const, reproducible: true }` (echo.ts). `isMovingModelAlias("oracle-v1")` is false: `src/model-identity.ts:3-11` matches only auto/default/latest/sonnet/opus/haiku/fable, `-latest`, and pre-4.6 claude dateless names.
- **Discovery errors**: `EvalLoadError(promptPath, 1, msg)`. The first error aborts the scan.
- **Metrics**: unavailable is `null` (`tokensIn`/`tokensOut`). `turns: 0` and `costUsd: 0` are true zeros for a no-model adapter.
- **CLI output**: indented `  label:` then `    - item` lines on stdout, and `quickstudy: <msg>` on stderr via `fail()`.
- **Genericity**: `grep -ri workos src/` must stay empty. "oracle", "solution" and "reference solution" are neutral.

## Risks (Phase 4)

- **The fixture location breaks existing tests.** `tests/runner-v3.test.ts:48-49` asserts `discoverExperiments(FIXTURES/experiments)` ids `toEqual(["echo-local"])`. `:166-178` (2 trials) and `tests/graded-checks.test.ts:195` plan hello-local or temp evals against EVERY fixture experiment, so oracle × a no-solution eval hits the preflight. Recommended: put the oracle experiment at `tests/__fixtures__/oracle/experiments/oracle-local.ts` (deviating from the spec's path), or update all three tests to filter.
- **Typecheck breaks outside the spec's list.** `scripts/seed-run.ts:154` (EvalIdentity literal, no `solution`) and `tests/plan-v3.test.ts:13` (LoadedEval literal, no `solutionDir`). Add `null` in both. The seeders are deterministic, so `ui/dev-data/` manifests gain `"solution": null` if they are regenerated. Regeneration is optional; the UI reads only metadata.
- **The worker boundary erases the error class.** `score-worker.ts:76` sends only `error.message` back to the worker, and `scorer-worker.ts:38` rethrows a plain `Error`. Scorers can never `instanceof RuntimeCapabilityError`, so a type-only export from `src/index.ts` is of little use. `validateOracle` must decide `deferred` from the parent-side tracking Set, which is exactly the spec's algorithm. Put the wrappers on the context passed to `scoreInWorker`. The worker's own defaults are always overridden by RPC stubs (`scorer-worker.ts:47-50`).
- **The manifest hash shifts.** `solution` sits outside `components`, so `eval.hash` and `attemptIdentityHash` are stable. But `manifest.hash` hashes all of `evals` (`manifest.ts:205-213`). Consequences:
  - A run started before this change cannot be resumed after it: `execute.ts:440` refuses with "code or environment identity changed".
  - Editing `solution/` also blocks resume.
  - Report `source_fingerprint` (`report.ts:592`) changes for new runs only.

  This is acceptable. Mention it in the commit or docs.
- **`validateOracle` signature mismatch in the spec.** The file table says `validateOracle(evals, opts)`; the code block says `(loaded: LoadedEval, opts)` → `OracleOutcome`. Pick the per-eval form and loop in the CLI.
- **Output count mismatch in the spec.** The validate experiment says "`ready` → two `1.0` lines (three evals after framework expansion)". Manual Testing says three `1.0` lines. `ready` yields `hello-solution`, `multi-solution-alpha` and `multi-solution-beta`, so assert 3.
- **Semantic scorers under validate.** `src/semantic.ts:88-93` throws `SemanticScoringError` when `ctx.agentOutput` is absent. Validate provides none, so these report `failed`, not `deferred`. A judge call from the host would also spend money. Not covered by the spec; either document it or treat a missing `agentOutput` as a tracked capability.
- **Container oracle constraints.**
  - The experiment must not set `runtime.command`, because `execute.ts:352` only resolves adapters when the command is empty.
  - `requiredHostEnv: []` works with `collectProviderKeys`.
  - `keyProbe` and `versionCommand` are absent, so they are skipped.
  - `surfaceUsageVendor("oracle")` is null (`src/surface-usage.ts:200`).
  - On `alpine:3`, git is absent, so the diff is empty and a log line is written (`execute.ts:824-829`).
- **Overlay order.** `cp(solutionDir, sourceDir, { recursive: true, force: true })` must run after the local copy. An eval with `solution/` but no `local/` is valid; the solution alone becomes the tree. Solutions cannot delete files, as the spec documents.
- **Docs.**
  - The pre-paid-run checklist is now `docs/writing-an-eval.md:411` ("## Checklist before a paid run"), not `:383-392`.
  - The new section fits naturally after "## Test the scorer before paying for attempts" (:308).
  - Any new ```bash block in README.md, getting-started.md or writing-an-eval.md needs a `tests/docs-smoke-inventory.ts` entry, or the docs-smoke drift guard fails. Inline code spans avoid this.
- **Decision log check.** No contradiction with the codebase:
  - Container adapters really have no host paths, and `setupFiles` returns `Record<string,string>` (`types.ts:84-88, :145`).
  - The EvalIdentity key set really is snapshot-asserted (`identity-v3.test.ts:73`).
  - No oracle, solution or `--agent` override exists yet. `--agent` is an unknown-flag error (`tests/cli.test.ts:34-38`).

---

# Phase 2: Ungraded checks and SDK recall (retained, implemented in `e552338`)

## Gates (Phase 2)

| Gate                 | Status | Evidence |
| -------------------- | ------ | -------- |
| Scope clarity        | ready  | The spec names 12 modified files and 2 new files, each with a concrete change. Scouting found 3 more changes the spec does not list:<br>(1) pinned assertions that will break: `tests/report-v3.test.ts:83` (`toEqual({name:"flow-wired",passed:0,total:3})`, which now needs `graded:true`), `tests/export.test.ts:105` (the check-name array, which now includes `sdk-wired`), and `tests/export.test.ts:177-188` (a verbatim-embed marker report with no `schema_version`, which the new stale rule would rebuild).<br>(2) There is no "experiments card" in `ui/src/views/Report.tsx`, so SDK recall needs a new card or a line in an existing section.<br>(3) There is no `.tag` CSS class in `ui/src/styles.css`, so one must be added. |
| Pattern familiarity  | ready  | Read these patterns:<br>- `src/evals/result.ts` (validator, one `.some(...)` predicate per rule)<br>- `src/report/report.ts:246-304` (`collectPairs`) and `:343-361` (`collectExperiments`)<br>- `methodologyNote` `:60-74` and `BANNED_LANGUAGE` `:51`<br>- renderer experiments block `:589-601` and checks lines `:650-652`<br>- `src/export.ts:179-212` (`resolveReport`)<br>- `ui/src/views/Matrix.tsx:67-96` (`buildCells`) and `:119-150` (`AttemptRow`)<br>- `ui/src/views/Report.tsx:49-60` (`ChecksCell`) and `:309-328` (the usage card, a model for a per-experiment card)<br>- `ui/src/views/Attempt.tsx:79-87`<br>- `scripts/seed-run.ts:228-242`<br>- `tests/__fixtures__/evals/hello-local/EVAL.ts` |
| Dependency awareness | ready  | `CheckResult` is exported via the `quickstudy` package (`tsconfig.json:18`) and flows into `DataAttempt.checks` (`src/export-types.ts:77`, `src/export.ts:154`). `ReportCheck` is consumed by `src/diagnose/select.ts:103` (failedChecks), `ui/src/views/Report.tsx:49-60`, and the text renderer. `ReportExperiment` is consumed by `Report.tsx:147-153` and the renderer, and `collectExperiments` is called once (`report.ts:553`). `REPORT_SCHEMA_VERSION` is consumed by `readReportJson` `:729` (tests only) and by tests `report-v3:250,279,319` and `export:122`, all symbolic (not literal pins). |
| Edge case coverage   | ready  | Edge cases: a non-boolean `graded`; `graded:true` stated explicitly; a name that is graded in one attempt and ungraded in another; an experiment with no ungraded checks (rate null); incomplete or error attempts excluded from recall; graded timeouts (completed) included; a stored report with no `schema_version` or a newer one; a stale report carrying `cost_estimate` (reuse its pricing); ungraded failures leaking into diagnose failedChecks; e2e targeting the wrong seeded run. Details are under Risks. |
| Test strategy        | ready  | Inner loop: `bun test tests/graded-checks.test.ts tests/report-v3.test.ts`. Scoped: `-t report`, `-t invariant`, `-t matrix`. Then `bun test export complete-export viewers-export diagnose`, `bun test genericity`, `bun run typecheck`, `bun run lint`, `bun run ui:dev-data`, `bun run ui:build && bun run ui:e2e`. The runner invariant uses `executeRunV3` plus `tests/__fixtures__/experiments/echo-local.ts`, following the `writeTmpEval` helpers in `tests/runner-v3.test.ts:1-41`. |

## Key Patterns (Phase 2)

- `/Users/gjtorikian/workos/quickstudy/src/evals/types.ts:43-49`: `CheckResult {name, passed, notes?, evidence?}` with a JSDoc on the interface. Insert `graded?: boolean` after `passed`.
- `/Users/gjtorikian/workos/quickstudy/src/evals/result.ts:6`: the per-check predicate is one `.some((c) => !c \|\| typeof c.name !== "string" \|\| ...)` line. Add `\|\| (c.graded !== undefined && typeof c.graded !== "boolean")` there. The file style is terse, long single-line predicates.
- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:246-304` (`collectPairs`):
  - The per-pair `checks: Map<string, {passed,total}>` is declared at :247 and tallied at :282-287.
  - It is materialised at :296-298 via `.map(([name, tally]) => ({ name, passed, total }))`.
  - Add `graded: boolean` (init true; set false when `check.graded === false`) to the tally type and the map output.
- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:343-361` (`collectExperiments(run)`): builds identity cards from the manifest, sorted by id. Change the signature to `(run, attempts)` and add `sdk_recall: collectRecall(attempts, experimentId)`. The call site is at :553. `attempts` there is the publication-filtered current set (:521), which is the right population.
- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:51-74`:
  - `BANNED_LANGUAGE = ["caus", "effect of", "significant"]`.
  - `methodologyNote(trials)` is one concatenated string. Append the spec sentence, which is clean against the guard.
  - `buildReport` also guards the combined methodology at :525-530.
- `/Users/gjtorikian/workos/quickstudy/src/report/report.ts:589-601`: the text renderer's `experiments:` block pushes one line per experiment. Add a `    sdk recall: r/a (pct)` or `n/a` line under each. `pct()` is at :569. `report.experiments` is optional on the wire (`?? []`), so guard `experiment.sdk_recall` with optional chaining for older reports.
- `/Users/gjtorikian/workos/quickstudy/src/export.ts:179-212` (`resolveReport`):
  - When `pricing` is set, the report is always rebuilt.
  - Otherwise it parses `stored`, then does a v3 verbatim-reuse `return stored` (when `cost_estimate === undefined`), then does a fingerprint compare that reuses `stored.cost_estimate.pricing`.
  - The unreadable case falls through to a plain `buildReport`.
  - Put the stale check right after `const run = ...`. For a stale report with `cost_estimate`, pass `pricing: parsePricing(stored.cost_estimate.pricing)` (spec Failure Modes).
- `/Users/gjtorikian/workos/quickstudy/ui/src/views/Matrix.tsx:82,92`: `buildCells` flattens completed attempts' checks and counts them, and `Heatmap.tsx:168,191` renders `x/y checks`. Replace the count with `countGradedChecks`, keeping `null` when the graded total is 0 so Heatmap's "no checks" rendering stays consistent.
- `/Users/gjtorikian/workos/quickstudy/ui/src/views/Matrix.tsx:129-137`, `Attempt.tsx:79-87`, `Report.tsx:53-57`: these are `.crit pass/fail` chips keyed by `check.name`. Append the `ungraded-tag` span inside the chip or right after it.
- `/Users/gjtorikian/workos/quickstudy/ui/src/views/Report.tsx:309-328`: the usage card (`.card > .head h3` plus `.body` with `.attribution-arm` per experiment). This is the closest pattern for the SDK recall display, since there is no existing experiments card. Give it a testid such as `sdk-recall` for e2e.
- `/Users/gjtorikian/workos/quickstudy/scripts/seed-run.ts:228-242`: `seedChecks(outcome, treatment)` returns the `flow-wired`, `no-secrets-in-client` and `build-passes` checks, or undefined for error/incomplete. Append `{ name: "sdk-wired", passed: treatment === "mcp", graded: false }` to both arrays. `result.passed` is set from the outcome at :408, not from the checks, so pass semantics are unchanged.
- `/Users/gjtorikian/workos/quickstudy/tests/__fixtures__/evals/hello-local/EVAL.ts`: the base for the invariant-test scorer. It uses `import type` from `"quickstudy"`, which is type-only, so it resolves fine in a temp dir.

## Dependencies (Phase 2)

- `src/evals/types.ts` `CheckResult` is consumed by `src/export-types.ts:77` (`DataAttempt.checks`), `src/export.ts:154`, all UI check renderers, `scripts/seed-run.ts`, `scripts/seed-site.ts:178` (`cellStateChecks`), consumer scorers (the evals repo), and the new `ui/src/checks.ts`. The field is optional, so no consumer breaks.
- `src/evals/result.ts` `validEvalResult` is consumed by the runner's `scoreAttempt` (an invalid result makes the attempt `error`, errorKind `scorer`, via Phase 1's path).
- `src/report/report.ts`:
  - `ReportCheck`: `graded` is a required new field. It is built only in `collectPairs`. Readers are `src/diagnose/select.ts:103` (failedChecks = `passed < total`, which will now include ungraded misses), `ui/src/views/Report.tsx:49-60`, and the renderer :650.
  - `ReportExperiment.sdk_recall`: built only in `collectExperiments`. It is read by `Report.tsx:147-153` (label map, unaffected) and the renderer.
  - `REPORT_SCHEMA_VERSION`: read by `readReportJson` :729 and by tests (all symbolic).
- `src/export.ts` `resolveReport` is called at `:271` (pricing fallback) and `:342` (per-run export).
- `scripts/seed-run.ts` is consumed by `scripts/seed-site.ts:272` (the sweep run), `scripts/make-dev-data.ts`, and the tests `report-v3`, `export`, `completeness`, `surface-usage-v3`, `invariants-v3` and `diagnose`.

## Risks (Phase 2)

- **The stale-schema rule breaks the verbatim-embed test.** `tests/export.test.ts:177-188` writes `{ run: {id}, verbatim_marker, pairs: [] }` with no `schema_version` and expects it exported verbatim. With `stored.schema_version !== REPORT_SCHEMA_VERSION` it would be rebuilt. Fix the test by adding `schema_version: REPORT_SCHEMA_VERSION` to the marker. Also decide how to handle a newer stored schema. The comment at `src/export.ts:193-195` promises to preserve "forward-compatible fields a newer report producer may add". Using `!==` rebuilds (downgrades) newer reports. Using `< REPORT_SCHEMA_VERSION` (or missing) keeps that promise, but deviates from the spec's literal `!==`. Pick one and test it.
- **Other pinned seeded-check assertions will break:**
  - `tests/report-v3.test.ts:83` `toEqual({ name: "flow-wired", passed: 0, total: 3 })` needs `graded: true`.
  - `tests/export.test.ts:105` expects exactly `["flow-wired","no-secrets-in-client","build-passes"]` and needs `"sdk-wired"` appended.
  - The jq assertion at `tests/report-v3.test.ts:288` is structural and unaffected.
- **Diagnose leakage.** `src/diagnose/select.ts:103` lists every check with `passed < total` as a failed check. Seeded docs/cli pairs will now report `sdk-wired` as a failure in diagnosis prompts. The spec is silent on this. Consider filtering `graded !== false` there, or accept it and check `tests/diagnose.test.ts` (it builds its own checks at :355-362, so it is likely unaffected).
- **Recall denominator wording differs between the decision log and the implementation.** The decision log says "scored attempts on evals that *declare* at least one ungraded check". The `ReportRecall` doc says "attempts whose checks *include* at least one graded:false check" (per attempt). The two differ if a scorer emits the ungraded check only conditionally. Follow the Implementation Details definition (per attempt) and word the doc comment and methodology to match. This is a wording mismatch, not a contradiction with the codebase.
- **No experiments card exists in `Report.tsx`.** The spec says "experiments card shows SDK recall". The builder must add a card (model: the usage card at :309-328) or a column. Give it a testid so e2e can assert on it.
- **There is no `.tag` CSS class.** `ui/src/styles.css` has `.crit` but no `.tag`, so add a small style. The UI has a gzip budget check in `ui:build`; keep the addition tiny.
- **E2E must target the sweep run.** `sdk-wired` is added by `seed-run.ts` (the `sweep` run). The `cellStates` run uses `seed-site.ts:178` `cellStateChecks`, which is NOT in the spec. Point the ungraded-tag and "3/3 checks" e2e assertions at `runIds().sweep`, for a docs/cli cell whose passing attempt misses `sdk-wired` (e.g. an all-pass pair), or else also extend `cellStateChecks`.
- **Count semantics in cells.** The Heatmap sub-text sums checks across all completed attempts of a pair (e.g. 3 trials × 3 graded = `9/9`), not per attempt. The spec's example "`3/3 checks` for an attempt" only holds for a one-trial cell. Assert the graded-only total for the chosen cell, not a literal `3/3`.
- **Older report JSON in the UI.** Hosted snapshots are immutable, so `sdk_recall` and `graded` will be absent in old artifacts. Render `n/a` when `sdk_recall` is undefined, and treat a missing `ReportCheck.graded` as graded.
- **Genericity.** `sdk-wired` and "SDK recall" are vendor-neutral. Keep docs and help text free of consumer names (`tests/genericity.test.ts`).
- **Decision log check.** No codebase contradiction found. `DATA_SCHEMA_VERSION` is still 3 (`src/export-types.ts:38`). Reports are rebuilt from the DB (`resolveReport` already rebuilds on fingerprint mismatch). No client-side pair math exists for recall, and there is no per-attempt `cost_source`.

## Conventions (Phase 2 additions)

- **Report wire fields** are snake_case (`sdk_recall`, `pass_rate`), and rates are `number | null`, never 0 by default. New optional-on-wire fields get a JSDoc noting which older schema lacks them (see `pass_at_k` at `report.ts:113-118`).
- **UI helpers** are small pure modules in `ui/src/` (`format.ts`, `agent-label.ts`). They import harness types by relative path (`../../src/evals/types.ts`) with `import type`.
- **Report prose** must pass `findBannedLanguage`: no "caus" (so no "because"), no "effect of", no "significant".

---

# Phase 1: Outcome taxonomy and agent timestamps (retained)

**Gates (Phase 1)**: 5/5 ready, **Verdict**: GO (implemented in `7f58dc9`)

## Gates (Phase 1)

| Gate                 | Status | Evidence |
| -------------------- | ------ | -------- |
| Scope clarity        | ready  | Spec names 13 files plus the new test file. Scouting found 4 more changes, all concrete: timeout tests that flip (`tests/runner-v3.test.ts:139-161, :293-309, :344-365`, Docker-gated `tests/docker.test.ts:377-399, :446-460`), the container IIFE catch at `src/runner/execute.ts:899-903`, `docs/extensions.md:44-45`, and `ui/src/format.ts:14-25` `incompleteReason`. |
| Pattern familiarity  | ready  | Read the additive-column repair at `src/store/db.ts:213-226`, host path `execute.ts:575-622`, container path `:644-926`, `scoreAttempt` `:929-986`, `toDataAttempt` `src/export.ts:137-169`, `StatBadge.tsx`, `Matrix.tsx:111-150`, and the seeders. |
| Dependency awareness | ready  | `AttemptRecord`/`NewAttempt` are consumed by report.ts, costs.ts, completeness.ts, diagnose/{run,select}.ts, export.ts, and 7 test files. The new fields are optional. `DataAttempt` is built only in `src/export.ts`. |
| Edge case coverage   | ready  | The container catch swallowing StageFailure; provision returning instead of throwing; a graded timeout whose scoring then errors; the empty host scratch tree; export failing after a container timeout; an unknown `error_kind` on read; teardown-note merging; `incompleteReason` double-counting. |
| Test strategy        | ready  | `bun test tests/outcome-taxonomy.test.ts tests/store-v3.test.ts tests/runner-v3.test.ts`, then export, report-v3, complete-export, completeness and viewers-export, then genericity, typecheck, lint, `ui:dev-data`, `ui:build && ui:e2e`. |

## Key Patterns (Phase 1)

- `src/store/db.ts:213-226`: additive `ALTER TABLE attempts ADD COLUMN` repair driven by `pragma_table_info`. `NewAttempt` has optional fields; `insertAttempt` binds `?? null`.
- `src/runner/execute.ts`:
  - `AttemptDisposition` :134-139 gains `errorKind?`.
  - Outer loop :474-520.
  - Host path :575-622.
  - Container path :644-926: the provision block returns rather than throws, and the IIFE catch is at :899-903.
  - `scoreAttempt` :929-986.
- `src/runner/deadline.ts`: `StageTimeoutError` aborts at expiry and at scope end.
- `src/isolation/docker.ts:252-255`: a timed-out container is killed and then restarted, so export still works.
- `src/export.ts` `toDataAttempt` and `src/export-types.ts` `DataAttempt`: snake_case wire, `iso()` timestamps.
- `ui/src/components/StatBadge.tsx`: conditional-spread props and the `statusTone` helper pattern. `OutcomeBadges` now renders `limit-badge` and `error-kind-badge`.
- `scripts/seed-site.ts` cell-states run and `scripts/seed-run.ts` outcomes. The error outcome is codex-mcp × django trial 3 with `errorKind: "agent"`.
- `tests/runner-v3.test.ts:1-41`: `makeStores`, `writeTmpEval`, `hostExperiment` helpers. `tests/store-v3.test.ts:84-120`: the legacy-DB repair test.

## Dependencies (Phase 1)

- `src/store/db.ts` is consumed by runner, export, report, costs, completeness, diagnose, the seeders, and 8 test files (the optional fields are safe).
- `src/runner/execute.ts` `executeRunV3` is consumed by `src/cli.ts`, `scripts/dev-attempt.ts`, and the tests runner-v3, docker, egress-e2e, treatment-runtime, lifecycle, experiments-v3 and semantic-runner.
- `src/export-types.ts` `DataAttempt` is built only by `src/export.ts`, and read by `ui/src/data.ts` and the Matrix, Compare, Attempt and StatBadge UI files.
- `tests/export.test.ts:108` depends on the seeded error text "timed out".

## Conventions (Phase 1)

- **Naming**: camelCase in TS store fields, snake_case in SQL and on the wire. SQL `limit_hit` maps to wire `limit`. Test ids are kebab-case.
- **Imports**: ESM with explicit `.ts` extensions and relative paths; `import type` for types.
- **Error handling**: an attempt failure never aborts the run; `writeError` is called, then a disposition is returned; secrets are redacted.
- **Types**: interfaces for records; unavailable telemetry is `null`, never `0`; `as const` arrays plus derived unions.
- **Testing**: `bun:test`, `mkdtempSync` temp dirs, `:memory:` stores; positional filters (not `--filter`), `-t` for test names.

## Risks (Phase 1, historical)

- The container IIFE catch hides StageFailure, so it must map `err.kind`.
- Provision returns instead of throwing, so add `errorKind` on the return.
- Existing timeout tests flip from incomplete to completed, including the Docker-gated ones.
- The `timedOut` KPI and `incompleteReason` over-report incompleteness.
- `docs/extensions.md:44-45` and `docs/publishing-a-benchmark.md:195-199` contradict graded timeouts.
- The seeded error text "timed out" is tagged `agent`; leave it as is (`tests/export.test.ts:108`).
- `error_kind` and `limit_hit` must be read through type guards, not bare casts.
