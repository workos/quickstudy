# Implementation Spec: Prove the Bench - Phase 1

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Attempts today end in one of three statuses (`completed | incomplete | error`), a timed-out agent is discarded unscored, and every failure shares one `error` bucket. This phase adds four nullable columns to the `attempts` table through the existing additive-column path, grades timed-out attempts on the workspace they left behind, classifies every error site, and exports the new fields on `run.json` attempts as additive nullable fields (no `DATA_SCHEMA_VERSION` bump).

The runner already does most of the work. On the container path a timed-out agent is `docker kill`ed and then `docker start`ed so the diff can be captured (`src/isolation/docker.ts:252-255`); export and scoring are the two steps that follow a normal agent exit, so a graded timeout is "fall through instead of return". On the host path the adapter never returned, but the scratch workspace it was writing into exists; export it and score it. Error classification uses a stage variable that advances as the attempt proceeds; anything thrown carries the stage it was in, and the outer loop maps a bare throw to `harness`.

The UI change is one badge on the attempt row, and the seeders gain one graded-timeout cell state so dev data and the Playwright smoke exercise it.

## Decisions Considered and Rejected

_Carried from the contract; consult before making gap decisions._

- **Grade a timed-out attempt on the tree it leaves behind (status completed, limit timeout)** — rejected: keep timeouts unscored; or score them but exclude from pass rate. A limit hit is a statement about the agent, not the harness; the container is already restarted after kill to capture the diff.
- **Promote the outcome taxonomy to MVP** — rejected: Full tier, after the leaderboard. The first tier's numbers should already distinguish infra from agent failures and grade what agents left behind.
- **Persist only the agent-phase timestamp pair** — rejected: agent and score phase pairs. Nothing displays scorer time; harness overhead is derivable from the existing `started_at`/`finished_at`.
- **Agent-phase timestamps land in MVP with the taxonomy columns** — rejected: Full tier with the leaderboard. Same ALTER block and the same runner call sites.
- **Bump REPORT_SCHEMA_VERSION and make export rebuild a stale-schema stored report; keep DATA_SCHEMA_VERSION at 3 with additive nullable attempt fields** — rejected: bump DATA_SCHEMA_VERSION too. Hosted run snapshots are immutable and would show a mismatch banner.
- **Drop the run-list badge, KPI identity collapse, model-pin header and per-attempt cost_source items** — rejected: keep them as Full-tier items. The run list and KPI identity rows exist only in the hosted site's wrapper; matrix headers already lead with model (reasoning).

## Feedback Strategy

**Inner-loop command**: `bun test tests/outcome-taxonomy.test.ts tests/store-v3.test.ts tests/runner-v3.test.ts`

**Playground**: the test suite (host-path runs through `executeRunV3` with injected fake adapters, exactly as `tests/runner-v3.test.ts:147-160` does for the existing stall adapter); `bun run ui:dev` against regenerated `ui/dev-data` for the badge.

**Why this approach**: every behaviour here is a store column or a runner disposition, both of which the existing host-path tests already drive in under 10 seconds without Docker.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `tests/outcome-taxonomy.test.ts` | Graded timeout, error-kind classification, column repair, export mapping (the contract's named suite) |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/store/schema.ts` | Add `limit_hit TEXT`, `error_kind TEXT`, `agent_started_at INTEGER`, `agent_finished_at INTEGER` to `SCHEMA_SQL` with the NULL-means-unavailable comment |
| `src/store/db.ts` | `ErrorKind` type + `ERROR_KINDS`; `LimitKind = "timeout"`; new optional fields on `NewAttempt`/`AttemptRecord`/`AttemptRow`; row mapping; `insertAttempt` columns; four `ALTER TABLE ... ADD COLUMN` repairs next to the existing `turns` repair |
| `src/runner/execute.ts` | `AttemptDisposition.errorKind?`; stage tracking on both paths; graded timeout on both paths; agent timestamps around the agent stage; outer loop maps disposition → `persisted.errorKind`/`limitHit` |
| `src/export-types.ts` | `DataAttempt.limit`, `error_kind`, `agent_started_at`, `agent_finished_at` (all nullable; doc comments) |
| `src/export.ts` | `toDataAttempt` maps the four fields (`iso()` for timestamps) |
| `ui/src/components/StatBadge.tsx` | Optional `testId` prop; `errorKindTone(kind)` helper |
| `ui/src/views/Matrix.tsx` | `AttemptRow` renders `error-kind-badge` and `limit-badge`; the `timedOut` KPI count includes `limit === "timeout"` |
| `ui/src/views/Attempt.tsx` | Same two badges in the attempt header |
| `scripts/seed-run.ts` | Seeded `error` outcome gets `errorKind: "agent"`; every completed seeded attempt gets agent timestamps (`startedAt + 5s`, `finishedAt - 3s`) |
| `scripts/seed-site.ts` | `CELL_STATES` gains a `timeout` state: status completed, passed false, `limitHit: "timeout"` |
| `ui/e2e/smoke.spec.ts` | Cell-states assertions include the new cell; drill-down shows `error-kind-badge` on the seeded error attempt and `limit-badge` on the timeout cell |
| `ui/dev-data/**` | Regenerated by `bun run ui:dev-data` |
| `docs/concepts.md` | "Outcomes" paragraph: statuses, `limit`, the four error kinds, agent time vs wall time |

### Deleted Files

None.

## Implementation Details

### Store columns and record types

**Pattern to follow**: `src/store/db.ts:216-229` (the `turns` / `judge_usage_json` / `retry_of` additive repairs).

**Overview**: four nullable columns; NULL is the standard "unavailable" value, so existing rows need no backfill.

```typescript
// src/store/db.ts
export const ERROR_KINDS = ["environment", "agent", "scorer", "harness"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];
export type LimitKind = "timeout";

// NewAttempt / AttemptRecord additions (all optional | null)
limitHit?: LimitKind | null;        // column limit_hit
errorKind?: ErrorKind | null;       // column error_kind
agentStartedAt?: number | null;     // column agent_started_at (epoch ms)
agentFinishedAt?: number | null;    // column agent_finished_at (epoch ms)
```

**Key decisions**:

- The SQL column is `limit_hit`, not `limit` (`LIMIT` is a reserved word in SQLite). The wire field on `DataAttempt` is `limit`.
- `AttemptStatus` is unchanged. A graded timeout is `status = "completed"` with `limit_hit = "timeout"`.

**Implementation steps**:

1. Add the four columns to `SCHEMA_SQL` and to the `attemptColumns` repair block (one `if (!attemptColumns.includes(...))` each).
2. Extend `NewAttempt`, `AttemptRecord`, `AttemptRow`, the row→record mapping, and `insertAttempt` (the column list and the bound parameters; count goes 21 → 25).
3. Type-guard `error_kind` on read: a value outside `ERROR_KINDS` maps to `null` (a newer binary may add kinds later).

**Feedback loop**:

- **Playground**: `tests/outcome-taxonomy.test.ts` `describe("store")`.
- **Experiment**: (a) insert with all four set, read back equal; (b) insert with none set, read back all null; (c) open a database created from `SCHEMA_SQL` with the four columns stripped and `PRAGMA user_version = 3` → after `new ResultsStore(path)`, `pragma_table_info('attempts')` lists all four.
- **Check command**: `bun test tests/outcome-taxonomy.test.ts -t store`

### Error-kind classification in the runner

**Pattern to follow**: `src/runner/execute.ts:474-520` (outer loop) and `:647-927` (container path stages).

**Overview**: a stage variable names what the attempt is doing; every thrown error inherits the current stage; explicit error returns name their kind.

```typescript
// src/runner/execute.ts
interface AttemptDisposition {
  status: AttemptStatus;
  result?: EvalResult;
  error?: string;
  errorKind?: ErrorKind;          // NEW: set on every status: "error" disposition
  judgeRecords?: JudgeRecord[];
}

class StageFailure extends Error {
  constructor(readonly kind: ErrorKind, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
```

Stage → kind mapping (container path, in order):

| Stage | Kind |
| --- | --- |
| provision, workspace source prep, egress network, sidecar, container create, git baseline, setupFiles | `environment` |
| agent exec (the `execInWorkspace(command, …)` call) — non-zero exit or adapter throw | `agent` |
| workspace export | `environment` |
| scoring (`scoreAttempt` catch: scorer threw, invalid result, scoring deadline) | `scorer` |
| anything else reaching the outer `catch` without a `StageFailure` | `harness` |

Host path: `prepWorkspaceSource` failure → `environment`; adapter throw (not `StageTimeoutError`) → `agent`; scoring → `scorer`.

**Key decisions**:

- Wrap with `StageFailure` at the boundary of each stage's `try` rather than annotating every `throw` inside helpers; helpers stay unaware of the taxonomy.
- The outer loop: `persisted.errorKind = disposition.status === "error" ? (disposition.errorKind ?? "harness") : null;` and in its own `catch`: `errorKind: err instanceof StageFailure ? err.kind : "harness"`.
- The existing error messages and `artifacts.writeError` calls are untouched; only the kind is added.

**Implementation steps**:

1. Add `errorKind` to `AttemptDisposition` and `StageFailure`.
2. Container path: wrap the provision block (`:673-687`), setup (`:694-707`), create (`:751-761`), baseline/setupFiles (`:765-803`) in `try { … } catch (e) { throw new StageFailure("environment", e) }`; agent non-zero exit return gains `errorKind: "agent"`; export `deadline` block wrapped as `environment`.
3. `scoreAttempt`'s catch return gains `errorKind: "scorer"`.
4. Host path: wrap `prepWorkspaceSource` as `environment`; catch non-timeout adapter errors and return `{ status: "error", error, errorKind: "agent" }`.
5. Outer loop mapping as above.

**Feedback loop**:

- **Playground**: `tests/outcome-taxonomy.test.ts` `describe("error kinds")` using `executeRunV3` with `hostAdapters` injection (see `tests/runner-v3.test.ts:147-160, 306`).
- **Experiment**: (a) an adapter whose `runAttempt` throws → `error_kind = "agent"`; (b) an eval whose `EVAL.ts` throws → `"scorer"` (write the fixture into a temp dir; `tests/runner-v3.test.ts:288` shows a hanging-scorer fixture to copy); (c) an eval whose `localDir` points at a missing path → `"environment"`; (d) unit-test the outer mapping with a bare `Error` → `"harness"`; (e) a completed attempt has `error_kind = null`.
- **Check command**: `bun test tests/outcome-taxonomy.test.ts -t "error kinds"`

### Graded timeouts and agent timestamps

**Pattern to follow**: `src/runner/execute.ts:836-876` (container: capture diff → export → score) and `:596-621` (host).

**Overview**: on timeout, record `limitHit = "timeout"` on `persisted`, then continue into export and scoring instead of returning `incomplete`.

Container path (replace `:847-850`):

```typescript
if (agentResult.timedOut) {
  await artifacts.writeError(runId, attemptId, `attempt timed out after ${args.attemptTimeoutMs}ms — container killed; workspace graded as left`);
  persisted.limitHit = "timeout";
  // fall through: captureDiff already ran; export + score below
} else if (agentResult.exitCode !== 0) {
  return { status: "error", error: `agent command exited ${agentResult.exitCode}`, errorKind: "agent" };
}
```

The container was restarted by `runDocker`'s timeout handling (`docker.ts:252-255`), so `container.exportWorkspace` and `execInWorkspace` work. Guard: if `exportWorkspace` throws after a timeout, return `{ status: "incomplete", error: "attempt timed out after …ms; workspace could not be exported" }` — `incomplete` keeps its meaning "no workspace to score".

Host path (replace `:602-606`): catch `StageTimeoutError`, set `persisted.limitHit = "timeout"`, set `persisted.agentFinishedAt = Date.now()`, leave `transcriptRef`/`diffRef`/metrics null (the adapter never returned), then export `scratchDir` and call `scoreAttempt` with no `agentOutput`. If `scratchDir` is empty the scorer sees an empty workspace and grades that.

Timestamps: `persisted.agentStartedAt = Date.now()` immediately before `deadline("agent", …)` (host) / `container.execInWorkspace(command, …)` (container); `persisted.agentFinishedAt = Date.now()` immediately after either returns or throws (a `finally`).

**Key decisions**:

- `incomplete` survives only for "the workspace could not be exported" and for cancellation; the contract keeps it for attempts with nothing to score.
- A graded timeout counts in `pass_rate` like any completed attempt (the report's `collectPairs` needs no change).

**Implementation steps**:

1. Add timestamps around the agent stage on both paths (with `finally`).
2. Container: fall-through on timeout as above; export guard.
3. Host: catch, mark, export, score.
4. `scoreAttempt` unchanged except the `errorKind` on its error return.

**Feedback loop**:

- **Playground**: `tests/outcome-taxonomy.test.ts` `describe("graded timeout")`.
- **Experiment**: a host adapter that copies the fixture, writes `NOTES.md` containing `Notes`, then awaits forever; `attemptTimeoutMs: 50` with the `hello-local` fixture → attempt `status = "completed"`, `limitHit = "timeout"`, `result.passed === true` (both checks pass on the tree left behind), `agentStartedAt !== null`, `agentFinishedAt >= agentStartedAt`, `transcriptRef === null`. Second case: the adapter writes nothing → `completed`, `passed === false`, checks present.
- **Check command**: `bun test tests/outcome-taxonomy.test.ts -t "graded timeout"`

### Export mapping

**Pattern to follow**: `src/export.ts:137-169` (`toDataAttempt`).

**Overview**: four additive fields; ISO strings for timestamps via the existing `iso()` helper. `DATA_SCHEMA_VERSION` stays 3.

```typescript
// src/export-types.ts (DataAttempt additions)
/** "timeout" when the agent hit its wall-clock limit and the tree it left was graded; null otherwise. */
limit: "timeout" | null;
/** Which stage failed when status = "error"; null for completed/incomplete rows and for rows written before this field existed. */
error_kind: "environment" | "agent" | "scorer" | "harness" | null;
/** Agent phase only (excludes provisioning, container start, export, scoring); null = not recorded. */
agent_started_at: string | null;
agent_finished_at: string | null;
```

No feedback loop beyond the export assertions in the test file (write-once mapping).

### UI badges

**Pattern to follow**: `ui/src/components/StatBadge.tsx` and `ui/src/views/Matrix.tsx:111-150` (`AttemptRow`).

**Overview**: when `attempt.error_kind !== null` render `<StatBadge tone={errorKindTone(kind)} testId="error-kind-badge">{kind}</StatBadge>`; when `attempt.limit === "timeout"` render `<StatBadge tone="gray" testId="limit-badge">timeout</StatBadge>`. Tones: environment → amber, agent → red, scorer → blue, harness → gray.

`StatBadge` gains `testId?: string` rendered as `data-testid`. `Matrix.tsx:354`'s `timedOut` count becomes `status === "completed" && limit === "timeout"` plus the legacy incomplete-with-timeout-message case.

**Feedback loop**:

- **Playground**: `bun run ui:dev` after `bun run ui:dev-data`; open the cell-states run, click the new timeout cell and the seeded error cell.
- **Experiment**: badge text and tone per kind; no badge on a completed non-timeout attempt.
- **Check command**: `bun run ui:build && bun run ui:e2e -- -g "cell states"` (after adding the assertions)

### Seeders and dev data

**Pattern to follow**: `scripts/seed-site.ts:101-106` (`CELL_STATES`) and `scripts/seed-run.ts:217-260`.

**Implementation steps**:

1. `seed-run.ts`: the `error` outcome row sets `errorKind: "agent"`; completed rows set `agentStartedAt = startedAt + 5_000`, `agentFinishedAt = finishedAt - 3_000`.
2. `seed-site.ts`: add `timeout` to `CELL_STATES` (completed, `passed: false`, checks as a failing attempt, `limitHit: "timeout"`, timestamps as above).
3. `bun run ui:dev-data`; commit the regenerated `ui/dev-data`.
4. Update every test that enumerates cell states or seeded totals (`bun test export complete-export completeness viewers-export report-v3` will point at them).

## Data Model

### Schema Changes

```sql
-- additive, nullable, repaired on open for existing v3 databases
ALTER TABLE attempts ADD COLUMN limit_hit TEXT;          -- 'timeout' | NULL
ALTER TABLE attempts ADD COLUMN error_kind TEXT;         -- 'environment'|'agent'|'scorer'|'harness' | NULL
ALTER TABLE attempts ADD COLUMN agent_started_at INTEGER; -- epoch ms | NULL
ALTER TABLE attempts ADD COLUMN agent_finished_at INTEGER;
```

## Testing Requirements

### Unit Tests

| Test File | Coverage |
| --- | --- |
| `tests/outcome-taxonomy.test.ts` | store round-trip + column repair; error-kind per stage; graded timeout (tree scored, timestamps, null transcript); export mapping incl. ISO timestamps and nulls |

**Key test cases**:

- Timed-out host attempt with a written tree → completed, passed, `limit_hit = timeout`.
- Timed-out host attempt with an empty tree → completed, failed.
- Adapter throw → `agent`; scorer throw → `scorer`; bad `localDir` → `environment`; bare error → `harness`.
- Old v3 database without the columns opens and gains them.
- `toDataAttempt` emits `limit`, `error_kind`, ISO timestamps, and nulls when absent.

### Integration Tests

| Test File | Coverage |
| --- | --- |
| `ui/e2e/smoke.spec.ts` | cell-states run shows the timeout cell; drill-down shows `limit-badge`; seeded error attempt shows `error-kind-badge` |

### Manual Testing

- [ ] `bun run ui:dev` → cell-states run → timeout cell → badge reads "timeout".

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| Export fails after a container timeout | Return `incomplete` with the combined message; `limit_hit` is still recorded |
| Unknown `error_kind` string in the DB | Read as `null` |
| Adapter keeps writing after the host timeout | Accepted race: export snapshots whatever exists; documented in Failure Modes |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Graded timeout (host) | Adapter still writing during export | Adapter ignores the abort | Partially copied tree graded | Accept; host adapters are test doubles and `echo`-class |
| Graded timeout (container) | Container failed to restart after kill | Docker daemon hiccup | No workspace | Export guard → `incomplete` with message |
| Stage tracking | A helper throws before the stage is set | Early failure in setup | Mis-labelled as `harness` | Stage variable initialised to `environment` at function entry |
| Column repair | Concurrent openers race on ALTER | Two processes open a fresh DB | Second ALTER fails "duplicate column" | Wrap each ALTER in try/catch that ignores duplicate-column errors |

## Validation Commands

```bash
bun run typecheck
bun run lint
bun test tests/outcome-taxonomy.test.ts tests/store-v3.test.ts tests/runner-v3.test.ts tests/export.test.ts tests/report-v3.test.ts tests/complete-export.test.ts tests/completeness.test.ts
bun test genericity
bun run ui:dev-data && git diff --quiet -- ui/dev-data && test -z "$(git status --porcelain -- ui/dev-data)"
bun run ui:build && bun run ui:e2e
```

## Rollout Considerations

- **Commit**: `feat(runner): grade timed-out attempts and classify error kinds`. PR titles must be conventional commits (`lint-pr-title.yml`).
- **Rollback plan**: revert the commit; the added columns are nullable and harmless to older code.
