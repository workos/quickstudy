# Companion goal — hosted site (evals.workos.tools)

Paste this into a Claude Code session whose cwd is
`/Users/gjtorikian/workos/evals.workos.tools`. It is the third part of the
**Prove the Bench** plan: the harness half ships in `quickstudy`
(`docs/ideation/prove-the-bench/` in that repo), the benchmark half is
`evals-repo-goal.md`, and this is the control plane that renders the results.

Read `AGENTS.md` first and keep every invariant in it. Two matter most here:
`compare_runs` (`workers/compare.ts`) is the only place counts, rates and
differences are computed and the UI only formats them; and copy never says
"significant", "caused" or "effect of".

## Precondition

Already met. quickstudy 0.4.0 shipped Prove the Bench (`report.json`
`schema_version` 9 with `pairs[].band`, `scorer_health`,
`experiments[].aggregate`, `experiments[].sdk_recall`, `checks[].graded`; and
`run.json` attempts with `error_kind`, `limit`, `agent_started_at`,
`agent_finished_at`). This repo already pins `^0.4.0` (installed 0.4.0), and
the evals repo's `bun.lock` pins 0.4.0 too. The runner runs
`bunx --no-install @workos/quickstudy` from the evals checkout
(`runner/src/sweep.ts:13`), so the next sweep dispatched from this site
produces a bundle in the new shape; every bundle before it stays in the old
shape for good (no re-report path exists, see Constraints). The report
schemas in `workers/compare.ts`, `workers/results.ts` and `workers/attempts.ts`
are `.loose()` with optional `schema_version`, so both shapes parse.

The exact field shapes are in the installed package:
`node_modules/@workos/quickstudy/src/report/report.ts`,
`src/report/scorer-health.ts`, `src/report/aggregate.ts`,
`src/export-types.ts`. Copy shapes from there, not from memory.

## Goal

Make the run page answer "which experiment is best" and "is this the scorer
or the agent" from the fields the new reports carry, and stop the rest of
the site implying more than the data supports. Old bundles keep rendering and
say what they lack.

Done when all of these hold:

1. `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run deploy:dry-run`
   all exit 0.
2. `fixtures/report-sample-next.json` exists with `schema_version: 9` and
   the new fields (built from the shapes above, at least two experiments,
   one eval solved by every arm, one failed by every arm with a single
   failing check and another check passing, one attempt with an ungraded
   check failing while `passed` is true). `fixtures/run-sample-next.json`
   carries attempts with `error_kind`, `limit: "timeout"` and agent
   timestamps. The existing `fixtures/report-sample.json` (schema 5) and
   `fixtures/run-sample.json` stay and keep passing every test they pass
   today.
3. `npx vitest run --project workers workers/results.test.ts workers/compare.test.ts workers/attempts.test.ts app/lib/runFormat.test.ts app/lib/compareFormat.test.ts app/lib/resultsFormat.test.ts app/components/RunResults.test.tsx app/components/Diagnosis.test.tsx app/components/AttemptsTable.test.tsx`
   exits 0 and those files assert every behaviour under **Work** below
   (leaderboard rows and order, bands, banner, ungraded tag, error-kind and
   timeout badges, diagnosis clusters, infra label, one-line cost, metadata
   fold, low-trials greying).
4. Rendering `fixtures/report-sample.json` (schema 5) through `MatrixTab`
   shows the note "This run predates the leaderboard" and no leaderboard,
   band sections or banner; rendering `report-sample-next.json` shows all
   three.
5. `npm run test:e2e` passes locally after its cost-string and section
   assertions are updated (local only; needs `.dev.vars` with
   `DEV_ACCESS_BYPASS=1`, see `AGENTS.md`).
6. Judgment, after the next sweep: `/runs/<id>` shows the leaderboard, the
   bands and, if any eval fails under every arm for one check, the banner.
   Record the run id in the PR.

## Work

Group A can start immediately. Group B is fixture-driven and renders nothing
for old runs until live data arrives, by design.

### A. Honesty fixes on data the site already has

1. **Run list: infra failures get their own label.** A run with
   `status === "failed"` and `attempts === null` never produced a result
   (`install_failed`, `clone_failed`, `validate_failed`, `plan_drift`,
   `invalid_job_spec`, `docker_unavailable`, `mcp_credentials_missing`,
   `heartbeat_timeout`, `dispatch via … failed`). In
   `app/lib/runFormat.ts` add `runLabel(run)` returning `"infra failed"` for
   that case and the status verbatim otherwise; `StatusBadge`
   (`app/components/RunStatusLine.tsx:13-19`) renders the label. Keep the
   red colour and the `failureLabel` note. No D1 change: the status enum in
   `workers/db.ts:18` is untouched.
2. **Run list: one-line cost.** `costLabel` (`app/lib/runFormat.ts:93-100`)
   becomes `` `${dollars} · ${reported}/${attempts} reported` `` (null cost
   stays "not reported" / "not reported yet"; unknown ratio stays
   "reported attempts unknown"). `RecordedCost`
   (`app/components/CostEstimate.tsx:38-54`) moves "this reported subtotal
   understates the spend" into a `title` on the cell instead of appending it.
   Update `e2e/ui.spec.ts:42-45` ("$0.00 (1 of 1 attempt reported)") and the
   AGENTS.md sentence that quotes the old parenthetical form; the ratio stays
   visible, which is what the invariant protects.
3. **Run page: fold the metadata.** In `app/routes/runs.$id.tsx:293-408` the
   `DataList` keeps Selection, Ref (short SHA), Attempts, Cost, Duration,
   Failure (when set) and the Export bundle link visible; Evals,
   Experiments, full SHA, Concurrency, Dispatched, Started, Finished, Last
   heartbeat, quickstudy run id, Runner image and Actions run move behind a
   "Details" disclosure (a WorkDS primitive if one fits, else `<details>`),
   collapsed by default. Test by `renderToStaticMarkup`: visible rows
   present, folded rows inside the disclosure.
4. **`/compare`: stop colouring noise.** In `workers/compare.ts`
   `buildComparison` (569-649) add `lowTrials: boolean` to the comparison
   (true when any compared run's `report.trials < 3`) and a note of kind
   `trials` with the message "Fewer than 3 trials per pair in <run ids>;
   differences are listed, not coloured." Extend `comparisonSchema` in
   `workers/actions/compare.ts:57-145`. In `app/lib/compareFormat.ts`,
   `changeTone` (61-67) and `changeColor` (69-81) take the flag and return
   `"gray"` whenever it is true; `changeLabel` keeps printing the numbers.
   `Comparison.tsx` passes it through to `ExperimentTable` (393-474) and
   `EvalMatrix` (492+), and the legend at 565 says so. Tests in
   `workers/compare.test.ts` (flag and note from two fixtures, one with
   `trials: 1`) and `app/lib/compareFormat.test.ts`.
5. **Matrix tab: headers lead with the model pin.** Column headers in
   `app/components/RunResults.tsx:241-298` show `agent.model · agent.reasoning`
   from `report.experiments[].agent` first and `experimentId · treatment`
   beneath; when `agent` is null (older reports) fall back to today's header.
   Format in `app/lib/resultsFormat.ts`.

### B. Consume the new report fields

6. **Schemas.** Add the optional fields to `reportPairSchema` /
   `reportExperimentSchema` / `reportSchema` in `workers/compare.ts:34-117`
   (`band`, `sdk_recall`, `aggregate`, `scorer_health`, `checks[].graded`),
   to `resultsReportSchema` in `workers/results.ts:22-90`, and to
   `attemptRecordSchema` in `workers/attempts.ts:12-80` (`error_kind`,
   `limit`, `agent_started_at`, `agent_finished_at`). All optional/nullable;
   `.loose()` stays.
7. **Leaderboard.** `resultsView` (`workers/results.ts:299`) emits
   `leaderboard: LeaderboardRow[] | null` (null when any experiment lacks
   `aggregate`): `experimentId`, `treatment`, `model`, `reasoning`,
   `passed`, `scored` (passed + failed), `passRateAll`,
   `discriminatingPassed`, `discriminatingScored`, `passRateDiscriminating`,
   `discriminatingEvals`, `medianAgentMs`, `meanTokensIn`, `costUsd`,
   `costAttempts`, `attempts`, `estimatedCostUsd`,
   `sdkRecall {attempts, recalled, rate}` (all straight from
   `aggregate` and `sdk_recall`, camelCased); sorted by
   `passRateDiscriminating` desc, nulls last, then `passRateAll`, then id.
   The wire schema in `workers/actions/results.ts:21-141` gains it.
   `MatrixTab` (`RunResults.tsx:79`) renders it above the matrix as a table
   with one row per experiment (model pin first, then the five metrics; cost
   as `$X · n/m reported`, `est.` when an estimate exists, `not reported
   (0/N)` otherwise; time as `6m 51s`; tokens as `2.2M`). When `leaderboard`
   is null render the one-line note "This run predates the leaderboard;
   runs dispatched after quickstudy 0.4.0 show it." Formatting lives
   in `app/lib/resultsFormat.ts`; the browser computes nothing.
8. **Bands and banner.** `resultsView` emits each eval row's `band`
   (`discriminating | solved-by-all | failed-by-all | null`) and
   `scorerHealth: { suspects[], summary } | null`. `MatrixTab` renders three
   groups: discriminating (plus null-banded rows) open, "Solved by every arm
   (n)" and "Failed by every arm (n) — suspect the eval" collapsed. When
   `scorerHealth.suspects.length > 0`, `runs.$id.tsx` renders a callout above
   the tabs with the `summary` and one line per suspect (`evalId · check
   failed in N attempts under K arms · passing: …`). Reports without `band`
   render the single ungrouped matrix as today.
9. **Ungraded checks.** In `CellDetails` (`RunResults.tsx:115-168`) and the
   attempt page's check list (`app/routes/runs.$id.attempts.$attemptId.tsx`),
   a check with `graded === false` gets a gray "recorded, not graded" badge
   and is excluded from any "x of y checks" wording; `checkTone` (108-113)
   returns gray for it.
10. **Attempt badges.** `attemptsView` (`workers/attempts.ts:248`) passes
    `errorKind` and `limit` through; `AttemptsTable.tsx` and the attempt page
    show an `error kind` badge (environment → yellow, agent → red, scorer →
    blue, harness → gray) and a gray `timeout` badge for `limit === "timeout"`.
    `attemptProblems` in `runFormat.ts:20-25` is unchanged (counts come from
    D1, not the bundle).
11. **Diagnosis clusters.** `diagnosisView` (`workers/results.ts:410-435`)
    takes the report's pairs as well (read `report.json` in
    `diagnosisAction`, `workers/actions/results.ts:209-235`; when it is
    unavailable pass `null`) and groups findings first by
    `(evalId, failing graded checks of the cited pair)` sorted by finding
    count desc, then by target inside each cluster; `eval-defect` leads the
    target order when it is at least 25% of all findings, otherwise
    `DIAGNOSIS_TARGETS` order (`workers/diagnosis.ts:55-73`). The wire
    schema gains `clusters[]`. `app/components/Diagnosis.tsx:130-156`
    renders cluster sections with the heading
    `{evalId} · {checks} failed under {arms} arm(s) · {n} findings`, keeping
    every existing per-finding element (confidence badge, recurrence and
    verdict flags, PR badge, `FixControls`) untouched. The cross-run
    `findings` action and its fingerprints are not touched.

## Constraints

- Do not implement re-export or re-report of stored runs. The `export`
  action (`workers/actions/export.ts`) stays `dispatch_unconfigured`; old
  bundles keep their old `report.json` and the UI says so (item 7).
- Do not edit `fixtures/routing.json` (byte-pinned across repos),
  `app/vendor/design-system`, or anything under `workers/fixes.ts` /
  `workers/findings.ts`.
- Do not bump `wrangler`, `@cloudflare/vite-plugin` or
  `@cloudflare/vitest-pool-workers` (pinned together).
- Compute nothing in the browser that `workers/results.ts` or
  `workers/compare.ts` can compute; format only.
- Conventional commits (`feat(runs): …`, `feat(compare): …`); one PR per
  group (A, then B) is fine.
