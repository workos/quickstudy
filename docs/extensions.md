# Extension contracts and reproducibility

Quickstudy separates product content from execution. A consumer supplies
`PROMPT.md` with YAML frontmatter, a default TypeScript `EVAL.ts` scorer, an
optional local fixture, and experiment modules using `defineExperiment`.
Other datasets require conversion to this format. Metadata is closed to id,
suite, product, framework/frameworks, local, and topics; adding arbitrary
metadata fields requires a harness change. Runtime kinds are host/container.
There is no general backend plugin API.

The public package exports scorer, runtime, experiment and probe interfaces,
plus `defineSemanticScorer`. Import `quickstudy`, never its internal files.
The [Harbor Notes example](../examples/harbor-notes/README.md) is a complete
consumer, including provisioning, image selection, cleanup and scorer queries.

## Agent and runtime boundaries

The packaged agent adapters are Claude and Codex in containers and Echo on the
host. To integrate another agent today, use a container runtime with an explicit
`command` that performs the task in `/workspace`. Its scorer and artifacts work
normally; vendor-specific token/turn/surface parsing is unavailable. Adding a
fully instrumented adapter requires changing the harness. Runner injection maps
are test seams, not a public registration API. Diagnosis currently uses Anthropic.

Host Echo performs a local smoke edit and has no provisioning or network
isolation. Container runtimes provision before agent work, receive secrets via a
0600 env file, export the workspace while the sandbox is alive, score, then
clean up. `scorerCapabilities` exposes `query` and `getClient`; absent capabilities
throw. Clients may return JSON-like fields and asynchronous methods; prototype
methods, cyclic object graphs, and synchronous remote methods are unsupported
across the scorer worker boundary. Scorers have file/exec helpers and an optional
`agentOutput` containing a final report and transcript (null when unavailable,
with a truncation flag). Older scorers remain valid without using these additions.

Scorers run in a terminable worker. Runtime hooks and capability implementations
are trusted in-process code and must honor their supplied AbortSignal, pass it to
fetch, and clean up partially created resources. A late provision result receives
cleanup. Stage completion also aborts its signal to cancel outstanding capability work. Arbitrary uncooperative host code cannot be forcibly rolled back. Use a
container command for executable agent extensions.

Default stage budgets are provisioning 120 s, agent 600 s, scoring 180 s,
workspace export 60 s, cleanup 30 s. Run flags `--provision-ms`, `--agent-ms`,
`--score-ms`, `--export-ms`, `--cleanup-ms` override them and enter identity.
A scorer timeout/provider failure is an instrument error; agent timeouts are
incomplete. Cleanup errors are recorded alongside the original outcome. A Docker
exec timeout stops the entire attempt container, including child processes.
Scoring cannot continue on that sandbox. SIGINT stops new scheduling and lets
active attempts finish within their budgets before releasing run infrastructure.

Workspace transfer excludes node_modules, vendor, .venv, .git, .next, .cache,
__pycache__, and env files before streaming from the container. Source and new
agent files remain; outside/absolute symlinks are removed. Reconstruct dependencies
and build outputs from recorded manifests, source, transcript and diff. Git history
is excluded; the agent diff uses the recorded baseline commit before export.

## Identity v4

v4 fingerprints the defining module and recursively resolved literal local
imports; package metadata and available Bun/npm/pnpm/Yarn lockfiles record package
resolutions. It also hashes `local/` and prompt content. Declare dynamic resources
(probe specifications, readFile inputs, dynamically selected source trees) in a
consumer-root `quickstudy.identity.json`:

```json
{ "version": 1, "sources": ["scorers", "runtime"] }
```

Paths are relative to the nearest package.json. Trees are bounded by these explicit
roots; dependency/build/result directories and credential files are excluded.
Literal imported source modules remain code even when their names contain `auth`.
Hashes contain no source bytes or credential values. Inline secrets do not belong
in source/config; use env files. Scorer factory `identity` data (including semantic
rubrics/configuration) is collected before execution and hashed, never published
as plaintext. Runtime closure state that is not represented by source or resolved
policies still belongs in non-secret `runtime.config`.

Every pair records the exact resolved image ID, egress policy, web policy, PATH
treatment, MCP configuration digest and lifecycle budgets. Execution uses those
resolved values, including the image ID instead of its mutable tag. Experiment
comparison checks per-eval images and budgets. A runtime may explicitly declare
`treatmentPolicyFields` for egress/webPolicy/pathTreatment/mcp; all group members
must declare the same exemptions. Images and budgets cannot be exempted.

v3 manifests and historical reports remain readable with their original semantics.
They cannot establish v4 identity for resume or complete-sample publication. No
historical score is recomputed. Live docs, MCP/service responses and package ranges
installed during agent work are not frozen by source hashing. Resolved image IDs
and available lockfiles record what can be pinned, not complete reproducibility.

## Offered surfaces, observation and egress

Treatment config declares offered docs `hosts`, CLI `commands`, and MCP server
names. `runtime.observationTargets` separately declares docsHosts, cliCommands and
mcpServers to observe in every arm, including a baseline. It never offers a surface.
Unsupported streams remain unavailable/null; zero means an applicable stream was
observed with no matching event. Offered surfaces and observed cross-arm use remain
separate in reports and diagnosis.

`--egress-proxy` applies to every container. The allowlist is the pair's runtime
hosts plus that adapter's provider endpoints; absent runtime hosts means provider
endpoints only. Each attempt has its own internal network and egress proxy. A
shared MCP auth proxy has its own infrastructure traffic, which is not attributed
to agent attempts. Egress denial artifacts contain sanitized host identifiers and
attempt IDs. An empty log means zero observed denials; an absent log means unavailable
instrumentation. Proxy use controls offered network routes, not pretrained knowledge
or tunneling through allowed services. Hiding a CLI directory from PATH and blocking
native web tools do not prohibit explicit shell paths or package-local alternatives.

## Scheduling, resume and publication

`run --concurrency N --seed VALUE` uses a reproducible seeded dispatch order; default
concurrency is 1 and seed is `0`. Trial coordinates never depend on completion order.
Runtime `capacity: {key, limit}` shares a capacity bound across arms. CPU, memory,
Docker sidecars and provider limits determine a suitable concurrency.

`run --resume RUN_ID` inherits the recorded selection, roots, budgets, seed and
policy and verifies v4 identity. Completed failures are skipped exactly like passes.
Missing coordinates run; existing error/incomplete attempts stay unless
`--retry-unfinished` is explicit. Retries append evidence with an explicit predecessor
link. Reports retain prior retry outcomes separately; arbitrary duplicate rows are
never treated as valid coverage. A run lock refuses concurrent writers.

`report --strict` rejects unfinished runs, missing/duplicate/out-of-range indexes,
invalid scored outcomes, identity mismatches and incomplete/error attempts. Scored
failures are valid measurements. Diagnostic exports remain available for partial runs.

`export RUN_ID --expected-trials N` publishes only pairs with all distinct intended
trial indexes and valid scored outcomes under v4 identity. An expected count different
from the recorded plan is an omission. Compared arms use an identical complete eval
set. `omissions.json`, `omissions.txt`, the report's publication record and UI explain
omitted pairs and preserve source totals; source reports and attempts remain available.
No eligible pair is an error before publication files are written.

`export --mode offline` (default) embeds all selected run/report/diagnosis JSON in the
HTML for file sharing. Transcripts/diffs stay separate and need a static server.
`--mode hosted` embeds only the run index and loads immutable run snapshots on demand;
`quickstudy ui` uses hosted mode. Snapshot pointers are replaced atomically, unchanged
artifacts are reused, and modern stored reports are checked against their source record.
Old snapshots remain so already-open browser pages keep a consistent view. Remove old
export directories explicitly when you no longer need those snapshots.

## Optional semantic scoring

Use deterministic assertions for builds, HTTP status, authorization, signatures and
persisted state. A judge is appropriate for a semantic result without a reliable
objective assertion. `defineSemanticScorer(rubric, judge)` is opt-in and records its
rubric, model, configuration and budgets in identity. Construction, validation,
ordinary deterministic runs, export and diagnosis do not invoke it automatically.

The judge receives bounded, redacted selected files and/or the final agent report or
transcript. Evidence is marked untrusted. It must return a structured boolean verdict,
reason and references to supplied evidence. Empty, malformed or invented-reference
verdicts, provider failures and timeouts are instrument errors. The injected provider
must honor AbortSignal and the explicit input/output budgets. Available usage/cost is
stored under `semantic-judge` provenance, including known usage on invalid verdicts; unavailable values remain null. It is separate
from agent cost and from diagnosis (which explains outcomes after scoring).

Start with positive/negative rubric fixtures and an injected fake judge, as in
`semantic-example.ts` and `tests/semantic.test.ts`. Calibrate a real judge against
human-reviewed outcomes, test prompt injection in evidence, pin its configuration,
and disclose disagreement rates. Optional live calibration is a separate paid gate;
it cannot replace local deterministic regressions.

The packaged consumer gate is `QUICKSTUDY_REQUIRE_DOCKER=1 bash scripts/pack-check.sh`.
The same Docker gate on `bun scripts/docs-smoke.ts` also executes the portable example.
The compiled build includes the scorer worker as a second entrypoint, following
[Bun's worker packaging requirement](https://bun.sh/docs/bundler/executables).
