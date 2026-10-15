# Prove the Bench Contract

**Created**: 2026-09-24
**Readiness**: All 5 gates ready
**Status**: Approved
**Approval**: Express — single consolidated confirmation, no per-artifact review
**Supersedes**: None

## Problem Statement

The latest paid sweep (136 attempts) produced 52 red cells, and by the run's own per-check data roughly 60% of them are not agent failures: 20 attempts passed their end-to-end check and failed only a static shape check (a regex expecting `request.method == "POST"` or a session dict under a fixed key), and 11 more delivered a working webhook endpoint and failed only for verifying the signature by hand instead of through the SDK. Four evals fail 0/8 under every experiment for the same single check. The harness has no way to say any of this: no reference solution ever proves a scorer before money is spent, every check is a hard gate, and the report's no-attribution stance is applied to instrument failures as well as treatment claims.

The run page records but does not answer. It is an eval × experiment ledger of 1/1 and 0/1 cells with no per-experiment aggregate, so 'does MCP help this agent?' is a column someone sums by eye. A timed-out attempt is discarded unscored even when it left a working tree. A provisioning failure, an agent crash and a scorer exception all land in one `error` status. The only duration recorded brackets provisioning, container start, export and Playwright probes together with the agent.

Who feels it: the benchmark author, who pays for a sweep and cannot tell whether a 0/8 row indicts the agents or the scorer, and the SDK and docs readers of the hosted report, who are steered toward documentation fixes when the scorer is the problem. The diagnose layer did find the defect pattern (40 eval-defect findings) but ranked it under 52 docs findings.

## Goals

1. A benchmark author can prove a scorer before paying: `quickstudy validate --oracle` scores each eval's committed `solution/` on the host path and reports 1.0, the failing checks, or 'deferred to runtime' per eval, exiting non-zero on any failing or missing solution; `quickstudy run` against an experiment whose agent is the built-in `oracle` adapter scores the solution under the real runtime for zero model spend.
2. A check can be recorded without being graded: `CheckResult.graded` (default true) is carried through the report and export, an attempt whose only failing check is ungraded still counts as passed, the matrix's checks count excludes ungraded checks, and every experiment gets an SDK-recall metric (share of scored attempts whose ungraded checks all passed) that never enters pass/fail.
3. Every report separates instrument failures from agent failures without an LLM: each pair carries a band (discriminating, solved by every arm, failed by every arm), the report carries a scorer-health summary naming checks that failed under every arm while another check passed in the same attempts, worded to pass the banned-language guard, and the matrix renders the bands with the two uniform bands collapsed by default under a banner.
4. Outcomes are classified: a timed-out attempt is exported and scored with `limit: "timeout"`; every errored attempt carries `error_kind` (environment | agent | scorer | harness) badged on the attempt row; attempts record `agent_started_at` and `agent_finished_at` so 'agent time' can be reported apart from harness overhead.
5. The run page answers 'which experiment is best' in one block: per-experiment rows led by the model pin with pass rate (all evals and discriminating evals only), median agent time, mean tokens, mean cost with reported-vs-estimated counts, and SDK recall, sorted by discriminating pass rate.
6. The rest of the UI stops implying more than the data supports: Compare states when trials are below three, and Diagnosis groups findings by (eval, failing check) with eval-defect first when it is at least a quarter of findings and excerpts anchored on the last error-marker cluster.

## Success Criteria

- [ ] Oracle suite: the no-op oracle adapter plus solution/ overlay scores a fixture eval at 1.0 on the host path; a Docker-gated case (auto-skips without a daemon) does the same in a container; validate --oracle distinguishes pass, fail and deferred-to-runtime — check: `test -f tests/oracle.test.ts && bun test tests/oracle.test.ts` → exits 0
- [ ] validate --oracle exits 0 on a fixture root where every eval's solution/ scores 1.0 (one plain eval, one framework-expanded eval with solution/<fw>/) — check: `bun src/cli.ts validate --oracle --evals-root tests/__fixtures__/oracle/ready` → exits 0
- [ ] validate --oracle exits 1 on a fixture root whose solution/ omits NOTES.md, and names the failing check — check: `out=$(bun src/cli.ts validate --oracle --evals-root tests/__fixtures__/oracle/broken 2>&1); test $? -eq 1 && printf '%s' "$out" | grep -q 'notes-written'` → exit 1 from validate and the check name in its output
- [ ] Graded checks: CheckResult.graded round-trips through result validation, report and export; an attempt whose only failing check is graded:false scores passed=true and the pair's checks count excludes it; SDK recall is null when no eval declares an ungraded check — check: `test -f tests/graded-checks.test.ts && bun test tests/graded-checks.test.ts` → exits 0
- [ ] Scorer health: pair bands and the scorer_health block are computed from seeded report data; the summary text passes findBannedLanguage even when a fixture check name contains a banned substring — check: `test -f tests/scorer-health.test.ts && bun test tests/scorer-health.test.ts` → exits 0
- [ ] Taxonomy: a timed-out host attempt is exported and scored with status completed and limit=timeout; error_kind is set for environment, agent, scorer and harness failures; agent_started_at/agent_finished_at are persisted and exported as ISO strings — check: `test -f tests/outcome-taxonomy.test.ts && bun test tests/outcome-taxonomy.test.ts` → exits 0
- [ ] Leaderboard: report.json carries a per-experiment aggregate (pass rate all/discriminating, median agent time, mean tokens, cost_usd/cost_attempts plus estimated counts, SDK recall), null never zero; export rebuilds a stored report whose schema_version is stale — check: `test -f tests/leaderboard.test.ts && bun test tests/leaderboard.test.ts` → exits 0
- [ ] Diagnosis clustering: findings group by (eval, failing check), eval-defect leads at >=25%, and the excerpt window anchors on the last error-marker cluster (marker at line 2 and line 500 yields a window around 500) — check: `test -f tests/diagnose-clusters.test.ts && bun test tests/diagnose-clusters.test.ts` → exits 0
- [ ] The Docker-independent suites covering everything this plan touches still pass: identity, discovery, runner, lifecycle, scheduler, adapters, plan, invariants, report, export, store, CLI, costs, completeness — check: `bun test report-v3 export store-v3 cli identity-v3 evals-discovery runner-v3 lifecycle scheduler adapters plan-v3 invariants-v3 complete-export costs completeness` → exits 0
- [ ] Harness and UI typecheck — check: `bun run typecheck` → exits 0
- [ ] Lint is clean — check: `bun run lint` → exits 0
- [ ] No consumer name in shipped harness code (src, ui/src, scripts) — check: `bun test genericity` → exits 0
- [ ] UI production bundle builds — check: `bun run ui:build` → exits 0
- [ ] Playwright smoke asserts on each new block by test id (leaderboard, matrix-band-discriminating, scorer-health-banner, ungraded-tag, compare-n-notice, error-kind-badge) and passes — check: `for t in leaderboard matrix-band-discriminating scorer-health-banner ungraded-tag compare-n-notice error-kind-badge; do grep -q "$t" ui/e2e/smoke.spec.ts || exit 1; done; bun run ui:e2e` → every test id appears in the spec and the suite exits 0
- [ ] Committed dev data is regenerated by the seeders, matches byte-for-byte, and leaves no untracked files — check: `bun run ui:dev-data && git diff --quiet -- ui/dev-data && test -z "$(git status --porcelain -- ui/dev-data)"` → exits 0
- [ ] The companion evals-repo goal (docs/ideation/prove-the-bench/evals-repo-goal.md, written alongside this contract) reads as a complete, self-contained prompt — judgment call: Garen reads docs/ideation/prove-the-bench/evals-repo-goal.md and confirms it can be pasted into a session in the evals repo without this conversation
- [ ] On the real sweep, the scorer-health summary names the four 0/8 evals and their single failing check — judgment call: Garen copies /Users/gjtorikian/workos/evals/results.db to a scratch path (opening it with the new store adds nullable columns), runs quickstudy report 01M37JJD8CG7EYR20QGXX3XGHY --db <copy> --results /Users/gjtorikian/workos/evals/results, then export, and reads the banner

## Scope Boundaries

### In Scope

- Built-in `oracle` adapter that is a no-op on both runner paths (host: copy the prepared workspace like `echo`; container: command `true`, null metrics) and declares `startingState: "solution"`; the overlay of `solution/` onto the fixture happens once in the shared workspace-prep step keyed off that declaration; identity provider local, reproducible, cost 0 — The no-op (`echo`) exists; the oracle is the missing half of lemans' bench gate, and one overlay serves both paths
- `solution/` convention in eval discovery: `solution/` or `solution/<framework>/` mirroring `local/`, surfaced as `LoadedEval.solutionDir`; its tree hash recorded unconditionally as `solution: string | null` on EvalIdentity outside `components`, so it never enters the eval hash — Agents never see the solution, so it must not rotate eval ids; mirroring local/ needs no new mental model; an unconditional nullable field avoids a per-adapter manifest branch
- `quickstudy validate --oracle`: host-path scoring of every eval's solution with three outcomes: 1.0; failing checks; or deferred, when the scorer invoked a runtime-only capability (`exec`, `query`, `getClient`) and did not reach 1.0. The validate context records those calls and throws the existing capability error for them, so no framework toolchain is ever run on the author's machine. Non-zero exit on any failing or missing solution — $0 in model spend and decides whether the four 0/8 evals are broken before the next sweep
- `CheckResult.graded?: boolean` (default true) validated in result.ts, carried into ReportCheck, exported, and shown as an ungraded tag in the UI; `passed` stays the scorer's call; matrix 'x/y checks' counts graded only — The most-quoted lemans finding (API recall) is only possible when a check can be recorded without deciding pass/fail
- Per-experiment SDK recall in report.json: share of scored attempts on evals declaring at least one ungraded check where every ungraded check passed; null when none declare one — 'Does MCP make agents use the SDK more?' is the benchmark's reason to exist and is currently folded into a binary fail
- Pair band in report.json (discriminating | solved-by-all | failed-by-all) and a deterministic scorer_health block listing checks that failed under every arm while another check passed in the same attempts, plus the affected eval ids — Every input already exists in the per-pair checks[]; this is the single most useful sentence the run could show
- Matrix partitioned into three bands, uniform bands collapsed by default with 'solved by every arm' / 'failed by every arm, suspect the eval' notes; scorer-health banner above the matrix — Goal 3's UI half: takes the matrix from 17 rows to the 6 that matter and puts the instrument finding where the reader looks first
- Methodology note gains one sentence separating instrument findings from treatment claims; all generated prose passes findBannedLanguage (note: 'because' contains 'caus') — Keeps the no-attribution stance intact while letting the report describe its own instrument
- Outcome taxonomy: on agent timeout the container/host workspace is still exported and scored with status completed and new nullable column `limit` ('timeout'); `incomplete` remains for attempts with no workspace to score — A working tree left behind is a real result; discarding it throws away paid work
- Nullable `error_kind` column (environment | agent | scorer | harness) set at every error site in execute.ts, exported on DataAttempt, badged on the UI attempt row — A provisioning failure and an agent crash must not share a badge
- Nullable `agent_started_at`, `agent_finished_at` columns via the existing v3 ALTER path; exported as ISO strings or null; harness overhead is derivable from the existing started_at/finished_at — Same ALTER block and runner call sites as the taxonomy columns; the leaderboard's speed metric depends on them
- Per-experiment aggregate in report.json (`experiments[]` gains pass rate all/discriminating, median agent time, mean tokens in/out, `cost_usd`/`cost_attempts` plus `estimated_cost_usd`/`estimated_attempts` mirroring ReportTelemetry, SDK recall, attempt counts by status); REPORT_SCHEMA_VERSION bump; export rebuilds a stored report whose schema_version is stale — Data exists in run.json; nothing aggregates it per experiment on the run page
- Leaderboard block above the matrix, one row per experiment led by `model · reasoning`, sorted by discriminating pass rate; cost cell reads '$X · n/m reported' or 'est.'; graceful 'regenerate the report' note when the field is absent from an older snapshot — Answers 'which is best' in one table, as the Rails page does
- Compare view: when run.trials < 3 or any shared eval is unscored, a notice states that per-arm counts are not comparable; no colour added — Current Compare shows raw counts with no deltas; the honesty gap is the missing statement, not a colour
- Diagnosis UI: findings grouped by (eval, failing checks) then target, the failing-check set derived by joining report.pairs[].checks (passed < total) on (eval_id, experiment_id), so no diagnosis schema bump and no LLM re-run; eval-defect section first when >=25% of findings; excerpt selector anchors its window on the last error-marker cluster and falls back to the tail — 40 correct eval-defect findings were ranked under 52 docs findings on a 47,000px page, and 42 excerpts pointed at L1-40

### Out of Scope

- Writing the 17 reference solutions, flipping SDK checks to graded:false, canary GUID lines in PROMPT.md, an `experiments/oracle.ts`, and CI running oracle + echo on scorer changes — Lives in the sibling evals repo; written as docs/ideation/prove-the-bench/evals-repo-goal.md alongside this contract
- Run-list view with cost cell and infra badge; KPI identity-row collapse — Those surfaces exist in the hosted site's wrapper, not this repo's UI, which has a run <select> and a three-tile KPI row with one manifest crumb
- Matrix headers leading with the model pin — Already shipped: Heatmap group headers render the shared model (reasoning) label
- Per-attempt `cost_source` field and score-phase timestamps — Cost source is derivable from cost_usd !== null; nothing displays scorer time
- Running 3-trial sweeps or changing the published site's trial count — Operational decision in the evals repo's sweep config, not harness code
- Tamper-resistant scoring (restoring graded surfaces from a pre-agent snapshot) — Real agents are not adversarial; the brief rates it note-only
- Ruby/gem packaging, Daytona, YAML bench.yml with inherit_from, miniswen single-tool agent, replacing the manifest identity model — The brief's 'not worth taking' list
- Deploying the hosted site — Publication is deliberately outside quickstudy export and lives in another repo
- Bumping DATA_SCHEMA_VERSION for run.json — Hosted immutable snapshots would show a mismatch banner; new attempt fields are additive and nullable instead

### Future Considerations

- `quickstudy rescore <run-id> --evals-root <path>`: re-run each EVAL.ts against the stored workspace on the host path using the same capability-tracking context as validate --oracle, so evals whose scorer needs exec, query or getClient are reported as deferred; writes a new run with `rescored_from` and the current scorer hashes; source run untouched; no experiments root needed since no runtime is started (Stretch, deferred)
- Container rebuild from fixture + diff.patch so rescore can regrade exec-dependent evals
- `quickstudy harvest <attempt-id>` to turn a passing agent diff into a `solution/` directory
- Difficulty labels derived from measured pass rate across runs once more than one run exists per eval
- Per-attempt cost/step budgets exposed on the CLI and recorded as limit kinds beyond timeout
- Gate the mcp-auth fail-fast test in tests/mcp-proxy.test.ts on Docker like its sibling suites (it fails today when the daemon is down)

## Decisions Considered and Rejected

- **Scope this goal to the quickstudy harness and write a companion goal for the evals repo** — rejected: Both repos in one goal. Autopilot runs in one checkout and commits to one branch; the harness half is testable with fixtures alone
- **Fold the brief's §2 UI items into one report-honesty phase in the Full tier** — rejected: Defer them entirely, or park them as Stretch. They are UI math on data already in run.json and share files with the leaderboard work
- **Grade a timed-out attempt on the tree it leaves behind (status completed, limit timeout)** — rejected: Keep timeouts unscored; or score them but exclude from pass rate. A limit hit is a statement about the agent, not the harness; the container is already restarted after kill to capture the diff
- **Compute scorer health in report.ts and render it in the UI** — rejected: Client-side computation in the UI; or leave it to the diagnose layer. Deterministic, free, present on every run, and one implementation of pair math instead of two
- **Promote the outcome taxonomy to MVP** — rejected: Full tier, after the leaderboard. The first tier's numbers should already distinguish infra from agent failures and grade what agents left behind
- **Ship the oracle as a built-in adapter that consumers reference from their own experiment module** — rejected: A `--agent oracle` run-time override flag; or both. The experiment's runtime owns every treatment, and an override would need a special case in manifest identity
- **Reference solutions are a `solution/` overlay directory (per framework `solution/<fw>/`) mirroring `local/`** — rejected: A SOLUTION.patch per framework. No git dependency at score time and the same expansion rules as local/; harvesting a diff into a directory is one git apply in the evals repo
- **Overlay solution/ once in the shared workspace-prep step, keyed off the adapter's `startingState` declaration; the oracle adapter is a no-op on both paths** — rejected: Each adapter performs the overlay itself. Critic fix: container adapters have no host paths by design and setupFiles is string-only, so an adapter-side overlay needs a contract extension for one adapter; both runner paths already take their starting state from one function
- **Record the solution tree hash unconditionally as `solution: string | null` on EvalIdentity outside `components`** — rejected: A `solution_hash` present only on oracle-run manifests. Critic fix: the manifest component key set is snapshot-asserted and eval identity is computed for every eval regardless of experiment; a conditional field adds a branch for one adapter while still keeping the hash out of eval identity
- **Persist only the agent-phase timestamp pair** — rejected: Agent and score phase pairs (four columns). Critic fix: nothing displays scorer time; harness overhead is derivable from the existing started_at/finished_at
- **Drop the run-list badge, KPI identity collapse, model-pin header and per-attempt cost_source items** — rejected: Keep them as Full-tier items. Critic fix: the run list and KPI identity rows exist only in the hosted site's wrapper, matrix headers already lead with model (reasoning), and cost source is derivable from cost_usd !== null
- **Bump REPORT_SCHEMA_VERSION and make export rebuild a stale-schema stored report; keep DATA_SCHEMA_VERSION at 3 with additive nullable attempt fields** — rejected: Bump DATA_SCHEMA_VERSION too. Reports rebuild from the DB for free; hosted run snapshots are immutable and would show a mismatch banner
- **SDK recall denominator is scored attempts on evals that declare at least one ungraded check; null otherwise** — rejected: All scored attempts. An eval with no recall check would otherwise count as recalled
- **`validate --oracle` reports an eval as deferred when its scorer throws the 'runtime does not provide' capability error** — rejected: Fail it; or skip exec-dependent checks. Probe-based evals would false-alarm on every validate, and which checks need a runtime is not knowable statically
- **Excerpt selector anchors on the last error-marker cluster** — rejected: Keep the first-marker window. A marker in the first five lines is a system-prompt false positive; the decisive error in a failing transcript is at the end
- **Compare gets a not-comparable notice below three trials, no colour** — rejected: Grey out deltas. Current Compare shows raw counts with no deltas to grey; the v2 red/green arrows the brief saw are no longer in main
- **Rescore writes a new run stamped rescored_from and ships host-path only, deferring exec-dependent evals** — rejected: Overwrite result_json in place; container rebuild in the same phase. The manifest pins scorer hashes, so mutating a graded run would break that pin; the container rebuild is the bulk of the work and matters only for exec scorers
- **Agent-phase timestamps land in MVP with the taxonomy columns** — rejected: Full tier with the leaderboard. Same ALTER block and the same runner call sites; splitting them costs a second migration pass
- **The regression gate enumerates the Docker-independent suites the plan touches** — rejected: Bare `bun test`. Critic fix widened the gate to identity, discovery, runner, lifecycle, scheduler and adapters; the full suite was rejected since one existing mcp-auth test assumes a reachable daemon and fails when Docker is down
- **New test suites are named files guarded by an existence check; e2e coverage is anchored on test ids grepped from the spec** — rejected: Substring filters and a bare `bun run ui:e2e`. Critic fix: a filter matching nothing or a suite that passes today would let acceptance go green with no new work
- **Under validate --oracle and rescore, `exec` is a runtime-only capability: the context records the call and throws the existing capability error, and an eval that invoked one without reaching 1.0 is deferred** — rejected: Run exec on the host in the overlay directory. Critic fix: consumer scorers call exec for framework commands; running them on an author's machine without the toolchain would report failing checks instead of deferred
- **Diagnosis grouping derives the failing-check set in the UI from report.pairs[].checks** — rejected: Add a `check` field to DiagnosisFinding with a schema bump. Critic fix: the finding has no check field today; a schema bump would force regenerating the real sweep's diagnosis.json at LLM cost, while the report already carries the per-pair failing checks
- **Write the companion evals-repo goal at contract time, not as an autopilot phase** — rejected: A phase that writes it. Critic fix: the goal needs the interview's context, not code; writing it alongside the contract lets the judgment criterion be met before execution starts
- **Target the Full tier; rescore deferred to Future** — rejected: Stretch tier. Chosen at contract approval: the six MVP/Full phases deliver every goal the brief ranks above rescore, and rescore's host-path design is recorded for a later contract

## Execution Plan

_Added during Phase 5 handoff. Pick up this contract cold and know exactly how to execute._

### Dependency Graph

```
Outcome taxonomy and agent timestamps
  └── Leaderboard  (blocked by Outcome taxonomy and agent timestamps, Graded checks and SDK recall, Scorer health and matrix bands)
Graded checks and SDK recall
  └── Scorer health and matrix bands  (blocked by Graded checks and SDK recall)
Oracle adapter, solution/ convention, validate --oracle
Report honesty
```

### Execution Steps

**Run the project** (recommended) — autopilot reads this contract, plans dependency waves, runs independent phases in parallel, and gates on failure:

```bash
/ideation:autopilot docs/ideation/prove-the-bench/contract.md
```

**Or run it unattended** — a `/goal` is a durability wrapper around the same autopilot run: Claude re-checks the condition before it is allowed to stop, so failures get repaired and re-run. Generated by `contract-gen --print-goal`; this is the only copy of that string:

```
/goal Drive the Prove the Bench contract (prove-the-bench) to completion with /ideation:autopilot.

1. Run `/ideation:autopilot docs/ideation/prove-the-bench/contract.md`. All commits belong on branch ideation/prove-the-bench — switch to it before any run.
2. It dispatches a BACKGROUND workflow. Wait for the completion notification — never start a second autopilot run while one is in flight.
3. Then run the ideation plugin's `scripts/verify.mjs` against `docs/ideation/prove-the-bench/contract-data.json` and leave its VERIFY line in the conversation. Resolve the plugin's install directory first — `${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs` is a placeholder, not a shell variable, and bash will not expand it. That line is the only evidence this goal is judged on.
4. If anything failed, fix the spec or the implementation and go back to step 1. Autopilot skips phases that already have commits.

Done when the most recent VERIFY line reads fail=0 and commits=6/6 — or when two consecutive VERIFY lines are identical and still failing, in which case name the failing checks and stop, because a contract whose checks have rotted must not trap the run.
```

**Or run phases manually** in dependency order:

**Strategy**: Hybrid: wave 1 runs Outcome taxonomy, Graded checks, Oracle and Report honesty in parallel; Scorer health follows Graded checks; Leaderboard follows the three MVP report phases. Shared files (report.ts, seed-site.ts, ui/dev-data) are serialised by the engine.

1. **Phase 1** — Outcome taxonomy and agent timestamps _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/prove-the-bench/spec-phase-1.md
   ```

2. **Phase 2** — Graded checks and SDK recall _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/prove-the-bench/spec-phase-2.md
   ```

3. **Phase 3** — Scorer health and matrix bands _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/prove-the-bench/spec-phase-3.md
   ```

4. **Phase 4** — Oracle adapter, solution/ convention, validate --oracle _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/prove-the-bench/spec-phase-4.md
   ```

5. **Phase 5** — Leaderboard _(blocking)_

   ```bash
   /ideation:execute-spec docs/ideation/prove-the-bench/spec-phase-5.md
   ```

6. **Phase 6** — Report honesty

   ```bash
   /ideation:execute-spec docs/ideation/prove-the-bench/spec-phase-6.md
   ```

---

_This contract was generated from brain dump input. Review and approve before proceeding to specification._
