# Implementation Spec: Prove the Bench - Phase 5

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Every column of a leaderboard row already exists per attempt in `run.json`; nothing aggregates it per experiment. This phase adds an `aggregate` object to each `report.experiments[]` entry (pass rate over all evals and over discriminating evals only, median agent time, mean tokens, cost with reported/estimated counts, and the Phase 2 SDK recall alongside), bumps `REPORT_SCHEMA_VERSION`, and renders one table above the matrix sorted by discriminating pass rate. Old snapshots without the field get a one-line "regenerate" note instead of a broken table.

Depends on Phase 1 (`agent_started_at`/`agent_finished_at`), Phase 2 (`sdk_recall`, stale-schema rebuild at export), Phase 3 (`pairs[].band`).

## Decisions Considered and Rejected

- **Bump REPORT_SCHEMA_VERSION and make export rebuild a stale-schema stored report; keep DATA_SCHEMA_VERSION at 3** — rejected: bump DATA_SCHEMA_VERSION too.
- **Drop per-attempt cost_source; mirror `ReportTelemetry`'s `cost_usd`/`cost_attempts` plus estimated counts on the aggregate** — rejected: a `cost_source` enum. Counts render "$X · n/m reported" and "est." without a new value domain.
- **Drop the run-list, KPI-collapse and model-pin-header items** — rejected: keep. Not in this repo's UI; headers already lead with the model.
- **Persist only the agent-phase timestamp pair** — rejected: score-phase pair. Nothing displays scorer time.

## Feedback Strategy

**Inner-loop command**: `bun test tests/leaderboard.test.ts`

**Playground**: `seedRun` + `buildReport` (deterministic outcomes in `scripts/seed-run.ts:217-226` give known expected rates); `bun run ui:dev` for the table.

**Why this approach**: aggregate math over a seeded store is exact and fast; the table is a new component against regenerated dev data.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `src/report/aggregate.ts` | `collectExperimentAggregate(attempts, pairs, experimentId, costEstimate?)` and types |
| `ui/src/components/Leaderboard.tsx` | The table |
| `tests/leaderboard.test.ts` | Aggregate math, nulls, discriminating subset, estimated counts, stale-schema rebuild (the contract's named suite) |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/report/report.ts` | `ReportExperiment.aggregate`; wire in `collectExperiments`; renderer table; `REPORT_SCHEMA_VERSION` 8 → 9 |
| `ui/src/format.ts` (+ `format.test.ts`) | `fmtMs` ("6m 51s"), `fmtTokens` ("2.2M"), `fmtUsd` ("$1.99") |
| `ui/src/views/Matrix.tsx` | Render `<Leaderboard report={report} />` above the matrix card; stale note when `aggregate` absent |
| `ui/src/agent-label.ts` | Reuse for the row's `model · reasoning` label (export a `modelLabel(agent)` if only a group form exists) |
| `ui/e2e/smoke.spec.ts` | `leaderboard` visible; rows sorted; cost cell reads `reported` |
| `ui/dev-data/**` | Regenerated |
| `docs/concepts.md` | Leaderboard columns and their denominators |

## Implementation Details

### Aggregate

**Pattern to follow**: `src/report/report.ts:318-332` (`collectTelemetry`: sums only over non-null, null when none) and `src/report/costs.ts:52-69` (`AttemptCostEstimate`).

```typescript
export interface ExperimentAggregate {
  attempts: number; completed: number; passed: number; failed: number; incomplete: number; errors: number; timeouts: number;
  /** passed / (passed + failed) over benchmark-suite pairs; null when nothing scored. */
  pass_rate_all: number | null;
  /** Same, restricted to evals whose band is "discriminating". */
  pass_rate_discriminating: number | null;
  discriminating_evals: number;
  /** Median of (agent_finished_at - agent_started_at) over scored attempts with both stamps; null when none. */
  median_agent_ms: number | null;
  agent_time_attempts: number;
  mean_tokens_in: number | null; mean_tokens_out: number | null; token_attempts: number;
  /** Provider-reported. */
  cost_usd: number | null; cost_attempts: number;
  /** Present only when the report was built with --pricing. */
  estimated_cost_usd?: number | null; estimated_attempts?: number;
}
```

Rules: suite filter `suite === "benchmark"` (regression never moves headline numbers — `EVAL_SUITES` comment); scored = `status === "completed"`; `timeouts` counts `limitHit === "timeout"`; median over an even count is the mean of the two middle values; means are sums over attempts that reported divided by that count; estimated fields come from `costEstimate.attempts` filtered to this experiment (shape in `src/report/costs.ts`).

**Implementation steps**:

1. Write `collectExperimentAggregate`; `collectExperiments(run, attempts, pairs, costEstimate)` attaches it.
2. Bump `REPORT_SCHEMA_VERSION` to 9 (update literal pins).
3. Renderer: a fixed-width table `experiment · model · pass (all/disc) · agent median · tokens in · cost · recall` after the experiments block.

**Feedback loop**:

- **Playground**: `tests/leaderboard.test.ts` `describe("aggregate")`.
- **Experiment**: from the seed (`claude-docs` all pass, `claude-mcp` all fail, `claude-cli` 2/3 …): assert exact `pass_rate_all`; discriminating subset equals all here (every seeded eval discriminates) — add a hand-built case with a solved-by-all eval to show it is excluded; median with 3 and with 4 stamps; experiment with no stamps → `median_agent_ms === null`, `agent_time_attempts === 0`; no cost → `cost_usd === null`, `cost_attempts === 0`; `estimated_*` absent without pricing and present with `--pricing` (use `tests/costs.test.ts`'s pricing fixture).
- **Check command**: `bun test tests/leaderboard.test.ts -t aggregate`

### Stale-schema rebuild (verification only)

Phase 2 added the rebuild in `resolveReport`. Add the acceptance case here: write `report.json` with `schema_version: 6` into a seeded results dir, `exportSite`, read `data/runs/<id>/report.json` → `schema_version === REPORT_SCHEMA_VERSION` and `experiments[0].aggregate` present. If Phase 2 shipped without it (check `git log -S"schema_version !==" -- src/export.ts`), implement it here.

**Check command**: `bun test tests/leaderboard.test.ts -t stale`

### Leaderboard component

**Pattern to follow**: `ui/src/views/Compare.tsx:108-157` (a plain table with test ids), `ui/src/components/Heatmap.tsx:89-110` (`groupSpans` model label).

```
<div className="card" data-testid="leaderboard">
  <div className="head"><h3>Which experiment is best?</h3><span className="muted">sorted by pass rate on discriminating evals</span></div>
  <table>
    <thead> Experiment · Pass rate (all · discriminating) · Agent time (median) · Tokens/run (in) · Cost/run · SDK recall
    <tbody> one <tr data-testid="leaderboard-row-{experiment_id}"> per experiment
```

Cell rules: first cell `model · reasoning` on the first line and `experiment_id · treatment` muted beneath; pass rate `11/17 · 6/6` with the discriminating count grey when `discriminating_evals === 0`; agent time `fmtMs` or "—"; tokens `fmtTokens` or "—"; cost `$1.99 · 12/17 reported` when `cost_attempts > 0`, else `not reported (0/17)`; when `estimated_cost_usd` is a number append `· $0.41 est.`; recall `14/17` or `n/a`. Sort: `pass_rate_discriminating` desc, nulls last, then `pass_rate_all` desc, then id. When `report.experiments.some(e => e.aggregate === undefined)` render `<div className="notice" data-testid="leaderboard-stale">This report predates the leaderboard. Regenerate it with <code>quickstudy report {runId}</code>.</div>` instead of the table.

**Feedback loop**:

- **Playground**: `bun run ui:dev` after `bun run ui:dev-data`.
- **Experiment**: sweep run shows six rows sorted with `claude-docs` first; cost cell on codex rows reads `not reported`; a run whose report lacks aggregates shows the stale note (hand-edit a dev-data report locally to check, do not commit it).
- **Check command**: `bun run ui:build && bun run ui:e2e -g leaderboard`

### Formatters

`fmtMs(411_000) → "6m 51s"`, `fmtMs(59_000) → "59s"`, `fmtMs(null) → "—"`; `fmtTokens(2_200_000) → "2.2M"`, `fmtTokens(512_000) → "512k"`; `fmtUsd(1.987) → "$1.99"`. Add cases to `ui/src/format.test.ts`.

## Testing Requirements

| Test File | Coverage |
| --- | --- |
| `tests/leaderboard.test.ts` | aggregate math (8 cases), stale rebuild (1), renderer table present (1) |
| `ui/src/format.test.ts` | the three formatters |
| `ui/e2e/smoke.spec.ts` | leaderboard visible, first row id, cost cell text |

### Manual Testing

- [ ] `bun src/cli.ts report <seeded run>` prints the leaderboard table.

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| Report lacks `aggregate` | Stale note, no table |
| Experiment with zero attempts in this run | Row rendered with all "—" (never 0) |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Aggregate | Regression-suite attempts inflate pass rate | Suite not filtered | Wrong headline | Filter `suite === "benchmark"` and test with `withRegression: true` seed |
| Median | Stamps present on some attempts only | Old rows | Median over a subset | `agent_time_attempts` shown next to the median in the UI tooltip |
| Sort | All `pass_rate_discriminating` null | Single-arm run | Arbitrary order | Fallback sort keys |

## Validation Commands

```bash
bun run typecheck
bun run lint
bun test tests/leaderboard.test.ts tests/report-v3.test.ts tests/export.test.ts ui/src/format.test.ts
bun test genericity
bun run ui:dev-data && git diff --quiet -- ui/dev-data && test -z "$(git status --porcelain -- ui/dev-data)"
bun run ui:build && bun run ui:e2e
```

## Rollout Considerations

- **Commit**: `feat(report): per-experiment leaderboard`.
- **Rollback plan**: revert; the UI shows the stale note for reports it cannot tabulate.
