# Implementation Spec: Prove the Bench - Phase 4

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

lemans refuses to call a bench ready until a reference solution scores 1.0 on every task and a no-op scores 0. quickstudy has the no-op (`echo`); this phase adds the other half in three pieces:

1. **Discovery** learns an optional `solution/` directory per eval (`solution/<framework>/` for framework-expanded evals), mirroring `local/`. Its tree hash is recorded on `EvalIdentity` as `solution` **outside** `components`, so it never enters the eval hash (agents never see it).
2. **A built-in `oracle` adapter** that is a no-op on both runner paths and declares `startingState: "solution"`. The overlay itself happens once, in the shared `prepWorkspaceSource`, which both paths already use for the fixture: copy `local/`, then copy `solution/` over it. The container path `docker cp`s the prepared source whole, so no container copy-in is needed. `run` fails fast at preflight if an oracle experiment is paired with an eval that has no solution.
3. **`quickstudy validate --oracle`**: scores every eval's overlaid solution on the host with a *capability-tracking* context. `exec`, `query` and `getClient` are runtime-only under validate: each records that it was called and throws `RuntimeCapabilityError`. Outcome per eval: `1.0` when `passed` and every graded check passed; `deferred` when a runtime capability was invoked and the eval did not reach 1.0; otherwise `FAILED` with check names; `MISSING` when there is no solution. Exit 1 on any FAILED or MISSING. Deferred evals are covered by running the oracle experiment under the real runtime, which costs no model spend.

## Decisions Considered and Rejected

- **Ship the oracle as a built-in adapter that consumers reference from their own experiment module** — rejected: a `--agent oracle` override flag; or both. The experiment's runtime owns every treatment.
- **Reference solutions are a `solution/` overlay directory mirroring `local/`** — rejected: a SOLUTION.patch per framework. No git dependency at score time; same expansion rules as local/.
- **Overlay solution/ once in the shared workspace-prep step, keyed off the adapter's `startingState`; the oracle adapter is a no-op on both paths** — rejected: each adapter performs the overlay. Container adapters have no host paths and `setupFiles` is string-only.
- **Record the solution tree hash unconditionally as `solution: string | null` on EvalIdentity outside `components`** — rejected: a `solution_hash` present only on oracle-run manifests. The component key set is snapshot-asserted; a conditional field adds a branch for one adapter.
- **`validate --oracle` reports an eval as deferred when its scorer invoked a runtime-only capability without reaching 1.0** — rejected: fail it; or skip exec-dependent checks. Probe-based evals would false-alarm, and which checks need a runtime is not knowable statically.
- **Under validate --oracle, `exec` is a runtime-only capability** — rejected: run exec on the host in the overlay directory. Consumer scorers call exec for framework commands; running them on an author's machine without the toolchain would report failures instead of deferrals.

## Feedback Strategy

**Inner-loop command**: `bun test tests/oracle.test.ts tests/evals-discovery.test.ts tests/identity-v3.test.ts`

**Playground**: the committed fixture roots under `tests/__fixtures__/oracle/` and the CLI itself: `bun src/cli.ts validate --oracle --evals-root tests/__fixtures__/oracle/ready`.

**Why this approach**: discovery and identity are pure functions over directories; the CLI is the user-facing surface and doubles as the acceptance check; the container adapter is Docker-gated and auto-skips.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `src/adapters/oracle.ts` | `OracleAdapter` (host) and `OracleContainerAdapter`; shared identity |
| `src/runner/workspace-source.ts` | `prepWorkspaceSource(loadedEval, startingState)` moved out of `execute.ts` and exported |
| `src/runner/oracle-validate.ts` | `validateOracle(evals, opts)` → per-eval outcomes; capability-tracking context |
| `tests/oracle.test.ts` | Discovery, identity, overlay, run, preflight, validate CLI, Docker-gated container case |
| `tests/__fixtures__/oracle/ready/hello-solution/{PROMPT.md,EVAL.ts,local/README.md,solution/NOTES.md}` | Plain eval whose solution scores 1.0 |
| `tests/__fixtures__/oracle/ready/multi-solution/{PROMPT.md,EVAL.ts,local/{alpha,beta}/…,solution/{alpha,beta}/…}` | Framework-expanded eval with per-framework solutions |
| `tests/__fixtures__/oracle/broken/hello-broken/{PROMPT.md,EVAL.ts,local/README.md,solution/OTHER.md}` | Solution missing `NOTES.md` → `notes-written` fails |
| `tests/__fixtures__/oracle/deferred/exec-needed/{PROMPT.md,EVAL.ts,local/README.md,solution/NOTES.md}` | Scorer calls `ctx.exec(["true"])` → deferred under validate |
| `tests/__fixtures__/experiments/oracle-local.ts` | `agent.adapter: "oracle"`, host runtime |

### Modified Files

| File Path | Changes |
| --- | --- |
| `src/evals/types.ts` | `LoadedEval.solutionDir: string \| null` |
| `src/evals/discovery.ts` | Detect `solution/` (plain) and `solution/<fw>/` (framework); error when `solution/` exists but lacks a listed framework dir |
| `src/manifest.ts` | `EvalIdentity.solution: string \| null` (tree hash) outside `components` |
| `src/adapters/types.ts` | `startingState?: "fixture" \| "solution"` on `AgentAdapter` and `ContainerAgentAdapter` with doc comment |
| `src/runner/execute.ts` | Import `prepWorkspaceSource`; pass the adapter's `startingState` at both call sites; register `oracle` in `defaultHostAdapters` and `defaultContainerAdapters`; preflight check for solution-less pairs |
| `src/runner/context.ts` | `RuntimeCapabilityError` class; default `query`/`getClient` throw it |
| `src/cli.ts` | `validate --oracle` flag, per-eval outcome lines, exit code; USAGE text; eval list shows `; solution/` |
| `src/index.ts` | Export `RuntimeCapabilityError` type if scorers may want to catch it (type-only) |
| `tests/manifest*.test.ts` / `tests/identity-v3.test.ts` | Snapshot/shape updates for the new `solution` field |
| `docs/writing-an-eval.md` | "Prove the scorer with a reference solution" section |
| `docs/getting-started.md`, `README.md` | One line each on `validate --oracle` and the oracle adapter |

## Implementation Details

### Discovery of `solution/`

**Pattern to follow**: `src/evals/discovery.ts:53-107` (the `local/` handling).

**Implementation steps**:

1. Plain evals: `solutionDir = existsSync(join(dir,"solution")) && isDirectory ? that : null`.
2. Framework evals: `solutionBase = join(dir, "solution")`; when it exists, each listed framework must have `solutionBase/<fw>` (directory) or throw `EvalLoadError(promptPath, 1, 'eval "<id>" has solution/ but no solution for framework "<fw>" (expected <path>)')`; when it does not exist every variant gets `null`.
3. No `solution:` frontmatter key (not needed; keep discovery dumb).

**Feedback loop**:

- **Playground**: `tests/oracle.test.ts` `describe("discovery")` over the fixture roots.
- **Experiment**: `ready/` yields `hello-solution` with `solutionDir` set and `multi-solution-alpha`/`-beta` each with their own dir; a temp copy of `multi-solution` with `solution/beta` removed throws naming `beta`; `hello-local` (no solution) yields `null`.
- **Check command**: `bun test tests/oracle.test.ts -t discovery`

### Identity

**Pattern to follow**: `src/manifest.ts:155-171`.

```typescript
export interface EvalIdentity {
  id: string;
  metadata: EvalMetadata;
  components: EvalIdentityComponents;   // unchanged — solution is NOT here
  hash: string;                          // contentHash(components) — unchanged
  /** Tree hash of solution/ when present; null otherwise. Recorded, never hashed into identity. */
  solution: string | null;
}
```

**Feedback loop**:

- **Experiment**: two temp evals identical except one has `solution/` → equal `hash`, different `solution`; `buildRunManifest` snapshot tests updated for the new field.
- **Check command**: `bun test tests/oracle.test.ts -t identity && bun test identity-v3`

### Overlay in workspace prep and the no-op adapters

**Pattern to follow**: `src/runner/execute.ts:559-566` (`prepWorkspaceSource`), `src/adapters/echo.ts` (host no-op), `src/adapters/types.ts:113-150` (container adapter contract).

```typescript
// src/runner/workspace-source.ts
export type StartingState = "fixture" | "solution";
export async function prepWorkspaceSource(loadedEval: LoadedEval, startingState: StartingState = "fixture"): Promise<string> {
  const sourceDir = await mkdtemp(join(tmpdir(), "quickstudy-v3-source-"));
  if (loadedEval.localDir !== null) await cp(loadedEval.localDir, sourceDir, { recursive: true });
  if (startingState === "solution") {
    if (loadedEval.solutionDir === null) throw new Error(`eval "${loadedEval.metadata.id}" has no solution/ — the oracle adapter needs one`);
    await cp(loadedEval.solutionDir, sourceDir, { recursive: true, force: true }); // overlay: solution files win
  }
  return sourceDir;
}
```

```typescript
// src/adapters/oracle.ts
const ORACLE_IDENTITY = { provider: "local", model: "oracle-v1", reasoning: "none", cliVersion: "built-in",
  surfacePolicies: { docs: "no-network", mcp: "no-network", cli: "no-network" }, nativeWebControl: "controlled" as const, reproducible: true };

export class OracleAdapter implements AgentAdapter {          // host
  readonly name = "oracle"; readonly identity = ORACLE_IDENTITY; readonly startingState = "solution" as const;
  async runAttempt(ctx) { await cp(ctx.fixtureDir, ctx.workspaceDir, { recursive: true });
    return { transcript: [{ role: "assistant", content: "oracle: applied the reference solution", at: new Date().toISOString() }], diff: "",
             metrics: { tokensIn: null, tokensOut: null, turns: 0, costUsd: 0 } }; }
}
export class OracleContainerAdapter implements ContainerAgentAdapter {
  readonly kind = "container" as const; readonly name = "oracle"; readonly identity = ORACLE_IDENTITY; readonly startingState = "solution" as const;
  readonly requiredHostEnv = [] as const;
  setupFiles() { return {}; }
  command() { return ["true"]; }
  parseStream() { return { tokensIn: null, tokensOut: null, turns: 0, costUsd: 0 }; }
}
```

Registration: `defaultHostAdapters()` adds `oracle: new OracleAdapter()`; `defaultContainerAdapters()` adds `oracle: () => new OracleContainerAdapter()`. Check `isMovingModelAlias("oracle-v1")` is false (`tests/adapters.test.ts` shows the alias rules); if it trips, pick `oracle-1.0`.

Call sites in `execute.ts`: host `:588` → `prepWorkspaceSource(loadedEval, adapter.startingState ?? "fixture")`; container `:694` → `prepWorkspaceSource(loadedEval, containerAgent?.startingState ?? "fixture")`.

Preflight (in `executeRunV3` before the first attempt, next to the existing adapter/key checks): for every planned pair whose resolved adapter has `startingState === "solution"` and whose eval has `solutionDir === null`, collect and throw one error listing `<experiment> × <eval>` pairs: "the oracle adapter needs solution/ — add it or drop the eval from the run".

**Key decisions**:

- `turns: 0` and `costUsd: 0` are true zeros (no model ran); token counts are `null` (no model to report them). This follows "unavailable is null, never 0".
- The oracle's `diff` is empty on the host path and the container path's git baseline already contains the solution (the overlay precedes the baseline commit), so the diff is empty there too. Acceptable: the solution tree is committed in the eval directory.

**Feedback loop**:

- **Playground**: `tests/oracle.test.ts` `describe("run")` with `executeRunV3`, `tests/__fixtures__/experiments/oracle-local.ts`, evals root `ready/`.
- **Experiment**: both evals' attempts `completed`, `result.passed === true`, `costUsd === 0`, `tokensIn === null`; preflight with evals root `tests/__fixtures__/evals` (no solutions) rejects before inserting any attempt row; Docker-gated (`requireDockerOrSkip` from `tests/helpers.ts`, image conventions from `tests/docker.test.ts`): a container experiment with `agent.adapter: "oracle"` and the agent-runtime image scores `hello-solution` 1/1.
- **Check command**: `bun test tests/oracle.test.ts -t run`

### `validate --oracle`

**Pattern to follow**: `src/cli.ts:128-199` (`commandValidate`), `src/runner/execute.ts:929-988` (`scoreAttempt`: `buildEvalContext` + `scoreInWorker` + `deadline`).

```typescript
// src/runner/context.ts
export class RuntimeCapabilityError extends Error { constructor(readonly capability: "exec" | "query" | "getClient", detail: string) { super(detail); } }
// default query/getClient throw RuntimeCapabilityError (message text unchanged)

// src/runner/oracle-validate.ts
export type OracleOutcome =
  | { kind: "pass"; ungradedFailures: string[] }
  | { kind: "deferred"; capabilities: string[] }
  | { kind: "failed"; failingChecks: string[]; error?: string }
  | { kind: "missing" };
export async function validateOracle(loaded: LoadedEval, opts: { timeoutMs?: number }): Promise<OracleOutcome>
```

Algorithm per eval: `missing` when `solutionDir === null`. Else `prepWorkspaceSource(loaded, "solution")` into a temp dir; build the context with `evalId`, `experimentId: "validate-oracle"`, `trialIndex: 0`, `framework`, `workspaceDir`, and tracking wrappers for `exec`/`query`/`getClient` that push the capability name into a `Set` and throw `RuntimeCapabilityError`. Score via `scoreInWorker` under `deadline("scoring", opts.timeoutMs ?? DEFAULT_BUDGETS.scoreMs)`. Then:

- scorer threw and the set is non-empty → `deferred`
- scorer threw and the set is empty → `failed` with `error`
- result `passed` and every `graded !== false` check passed → `pass` (list failing ungraded checks as `ungradedFailures`)
- otherwise: set non-empty → `deferred`; empty → `failed` with the failing graded check names

Always `rm -rf` the temp dir.

CLI: `oracle: { type: "boolean", default: false }` in `parseArgs`; after the eval list, when set: print `  oracle:` then one line per eval: `    - <id>: 1.0` / `    - <id>: 1.0 (ungraded checks failing: a, b)` / `    - <id>: deferred (scorer needs exec — run the oracle experiment under the real runtime)` / `    - <id>: FAILED (notes-written)` / `    - <id>: MISSING (no solution/)`. Exit 1 when any FAILED/MISSING, via the existing `fail()` with a one-line summary. Update `USAGE` and the eval list line to append `; solution/` when present.

**Feedback loop**:

- **Playground**: the CLI on the three fixture roots.
- **Experiment**: `ready` → exit 0, two `1.0` lines (three evals after framework expansion); `broken` → exit 1, output contains `notes-written`; `deferred` → exit 0, output contains `deferred`; `tests/__fixtures__/evals` (no solutions) → exit 1 with `MISSING` lines. Drive with `Bun.spawnSync(["bun", "src/cli.ts", "validate", "--oracle", "--evals-root", root])` and assert `exitCode` + `stdout`/`stderr`.
- **Check command**: `bun test tests/oracle.test.ts -t validate`

### Fixtures

`PROMPT.md` frontmatter copies `tests/__fixtures__/evals/hello-local/PROMPT.md` (id equals dirname; `multi-solution` copies `multi-fw`'s `frameworks:` list shape with `alpha`/`beta`). Scorers:

- `hello-solution`, `hello-broken`: the `hello-local` scorer verbatim (`local-state-preserved`, `notes-written`).
- `multi-solution`: checks `README.md` contains `<framework> starting state` and `NOTES.md` exists; `solution/<fw>/NOTES.md` present for both.
- `exec-needed`: `notes-written` plus a check `build-passes` that awaits `ctx.exec(["true"])` and passes on exit 0.

### Docs

`docs/writing-an-eval.md`: new section "Prove the scorer with a reference solution" — layout, what `validate --oracle` prints, the three outcomes, the oracle experiment module (five-line `defineExperiment` with `adapter: "oracle"`), and the rule "fix the scorer, not the solution, when an idiomatic solution fails". Update the pre-paid-run checklist (`:383-392`) with `validate --oracle`.

## Testing Requirements

| Test File | Coverage |
| --- | --- |
| `tests/oracle.test.ts` | discovery (4), identity (2), overlay precedence (solution file wins over local file), run (2) + preflight (1), validate outcomes (4), Docker-gated container run (1, auto-skip) |
| existing `tests/evals-discovery.test.ts`, `tests/identity-v3.test.ts`, `tests/adapters.test.ts`, `tests/cli.test.ts` | Must stay green; update shape snapshots for `solution` |

### Manual Testing

- [ ] `bun src/cli.ts validate --oracle --evals-root tests/__fixtures__/oracle/ready` prints three `1.0` lines and exits 0.

## Error Handling

| Error Scenario | Handling Strategy |
| --- | --- |
| Oracle paired with a solution-less eval at `run` | Preflight error listing pairs; no attempt rows written |
| `solution/` exists but a framework dir is missing | `EvalLoadError` at discovery (validate and run both fail early) |
| Scorer under validate hangs | `deadline` → `failed` with "scoring timed out" |
| Scorer swallows `RuntimeCapabilityError` into a failed check | The tracking set still records the call → `deferred` |

## Failure Modes

| Component | Failure Mode | Trigger | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| Overlay | Solution contains files that should be deleted from the fixture | Solution needs a removal | Stale fixture file remains | Documented limitation; solutions are additive overlays |
| Identity | Snapshot tests pin `EvalIdentity` keys | New `solution` field | Test churn | Update snapshots in the same commit |
| Validate | Scorer with `exec` that never throws on the host (mocked) | Test doubles | Not deferred | Tracking is by invocation, not by throw |
| Container oracle | `command: ["true"]` exits before the runner reads a stream | Empty stdout | `parseStream("")` must return nulls | Implemented to ignore input |

## Validation Commands

```bash
bun run typecheck
bun run lint
bun test tests/oracle.test.ts tests/evals-discovery.test.ts tests/identity-v3.test.ts tests/adapters.test.ts tests/cli.test.ts tests/runner-v3.test.ts
bun src/cli.ts validate --oracle --evals-root tests/__fixtures__/oracle/ready
out=$(bun src/cli.ts validate --oracle --evals-root tests/__fixtures__/oracle/broken 2>&1); test $? -eq 1 && printf '%s' "$out" | grep -q 'notes-written'
bun test genericity
```

## Rollout Considerations

- **Commit**: `feat(evals): reference solutions, oracle adapter and validate --oracle`.
- **Rollback plan**: revert; `solution/` directories in consumer repos are inert without it.
