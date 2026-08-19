# Concepts

This page explains what quickstudy measures and the vocabulary the rest of the
docs use. If you just want to run it, skip to
[Getting started](./getting-started.md) and come back when a term is unclear.

## The problem it solves

Coding agents (Claude Code, Codex, …) are becoming a primary way developers
integrate third-party platforms. But if you own one of those platforms, you
have no systematic way to answer two questions:

1. **Can an agent actually complete a real task** with your product — e.g.
   "set up authentication in a Next.js app"?
2. **Does changing the developer surface change that outcome** — for example,
   does offering an MCP server change completion relative to browsing the
   docs?

quickstudy answers both by running agents against the same task under
different **experiment treatments** and reporting the results side by side.
It reports what was observed under a recorded harness; it does not assign
fault, and at typical trial counts it deliberately reports raw counts rather
than statistical claims.

## The four concepts

Everything in quickstudy is built from four things:

- An **eval** defines WHAT is attempted: a task prompt, an optional starting
  state, and a scorer that decides how an attempt did.
- An **experiment** defines HOW attempts run: which agent (with exact model
  pins), in what runtime environment, under what treatment.
- An **attempt** is one agent doing one eval once, under one experiment, in
  isolation. Attempts repeat (**trials**) because agents are
  non-deterministic.
- A **run** is one `quickstudy run` invocation: every selected
  eval × experiment pair, every trial, persisted under a single **run id**.

The core loop is the same for every attempt:

```
eval × experiment  →  isolated attempt  →  agent works  →  scorer checks it  →  report
```

## Evals: WHAT is attempted

An eval is one directory under the evals root (default `evals/`):

- **`PROMPT.md`** — YAML frontmatter (`id`, `suite`, and optional `product`,
  `framework`, `topics`) followed by the task prompt the agent receives
  verbatim.
- **`EVAL.ts`** — a default-exported **scorer**: plain TypeScript that
  receives the finished workspace and returns named pass/fail **checks**.
- **`local/`** (optional) — the starting state copied into the attempt's
  workspace before the agent begins.

There is no registry and no special dialect: the scorer is ordinary code, and
every eval is self-contained. The `suite` field separates headline
**benchmark** evals from **regression** and **other** evals, which never move
headline scores. [Writing an eval](./writing-an-eval.md) is the authoring
reference.

## Experiments: HOW attempts run

An experiment is one TypeScript module under the experiments root (default
`experiments/`) whose default export is `defineExperiment({...})`. It owns:

- the **agent** — adapter (`echo`, `claude`, `codex`, …), provider, and exact
  model/reasoning pins. Pins live in the module by design: changing them
  changes the experiment's identity.
- the **runtime** — everything the environment offers the agent:
  `host` (a scratch directory on your machine, used by the no-op `echo`
  agent) or `container` (a per-attempt Docker container). Container runtimes
  own the image, per-attempt provisioning, the egress allowlist, MCP servers,
  native-web policy, and PATH treatment.
- the optional **treatment** and **comparisonGroup** (below).

Because agent pins, runtime configuration, and the module source are all part
of the experiment's recorded identity, "the same experiment" across two runs
means the same recipe — drift is diffed, never silently averaged.

## Treatments and comparison groups

A **treatment** names what an experiment varies — an opaque string such as
`docs`, `mcp`, or `cli`. Experiments that share a **comparisonGroup** claim to
be treatments of ONE configuration: same agent, same pins, same runtime,
varying only their declared treatment.

quickstudy checks that claim with **withhold-and-diff** semantics:

- Group members must agree on every identity component except the treatment
  itself (and the treatment's own runtime config subtree).
- If they agree, the report renders the group **compared**: raw per-arm
  counts, e.g. `acme-nextjs 3/3` vs `1/3` — observed gaps stated as
  counts, with no intervals, no estimates, and no attribution.
- If they disagree on anything else, the comparison is **withheld** and the
  differing components are listed instead. The run is never blocked, and each
  member's raw results remain visible.

Group agreement is checked at `validate` time too, so an author sees a
withheld group before paying for a run.

A compared gap means: under this recorded harness, offering this treatment
came with these counts. It is not proof that the treatment made any
individual attempt succeed or fail, and small trial counts stay small — the
report's own methodology note says exactly this.

## Units: attempt, trial, pair, run

- **attempt** — one agent doing one eval once, under one experiment, in one
  isolated environment. Produces a transcript, a diff, and a
  passed/failed/error outcome.
- **trial** — attempts repeat (`--trials`, default **3**) because agents are
  non-deterministic.
- **pair** — one eval × experiment combination; the report's row unit. A
  pair's pass rate is `passed / (passed + failed)` across its trials —
  incomplete and errored attempts are counted separately and never enter the
  denominator. (The UI calls a pair drill-down a *cell*.)
- **run** — one `quickstudy run`: all selected pairs and trials under one
  run id, persisted to the results store.

## Immutable run identity

Before the first attempt, quickstudy writes an immutable **run manifest**
that content-addresses everything that could change an outcome:

- **harness** — the quickstudy source revision and tree hash.
- **per eval** — the PROMPT.md source, the effective prompt the agent
  receives, the `local/` starting tree (secret-looking files excluded before
  hashing), the scorer source, and the frontmatter metadata.
- **per experiment** — the defining module source, the agent identity fields
  verbatim (adapter, provider, model, reasoning, CLI version), the hashed
  runtime configuration, the resolved container image id/digests, and the
  declared treatment.

Paid adapters require exact model ids; moving aliases (`latest`, `sonnet`,
`auto`) are rejected because they make a later comparison ambiguous. The
manifest is stored with the run, and comparison groups are diffed against it.

## What a run tells you

`quickstudy report <run-id>` (or `--latest`) renders one report, facts first:

1. **Totals** — attempts passed / failed / incomplete / errored, plus cost
   and token telemetry summed over the attempts that reported it (telemetry
   that is unavailable is shown as unavailable, never as zero).
2. **Pairs** — one row per eval × experiment: pass rate, scored counts, and
   per-check pass counts (`build_passes 10/10`, `login_flow_e2e 1/10`, …),
   with a `trials disagreed` flag when trials split.
3. **Comparison groups** — raw per-arm counts for groups whose members agree
   beyond their declared treatment; a component diff for withheld groups.
4. **Surface usage** — offered-versus-used telemetry per experiment: observed
   product-doc URLs, MCP tool calls, and product CLI commands, where the
   agent's transcript stream supports extraction. Availability is not use,
   and unavailable telemetry is never counted as zero use.
5. **Egress denials** — on proxied runs (`--egress-proxy`), the hosts an
   agent reached for that were not on the allowlist. An agent groping for an
   undocumented endpoint is itself a DX finding.

The report embeds a generated methodology note, and its language is
deliberately conservative: raw counts, no intervals, no attribution.
`--strict` makes an incomplete or error-bearing run exit non-zero for CI.

When you want hypotheses about **why** pairs failed, `quickstudy diagnose
<run-id>` sends each failing pair's harness-selected evidence to a structured
model call and writes `diagnosis.json` beside `report.json`. Findings are
evidence-linked hypotheses — the conservative no-attribution stance of the
report is preserved by keeping diagnosis a separate, clearly-labeled layer.

## Isolation and secrets

Each container attempt runs in its own throwaway Docker container: the eval's
`local/` tree is copied in, the finished workspace is exported for scoring,
and the container is destroyed afterward. With `--egress-proxy` the attempt
has no default route and must reach the internet through a per-run allowlist
proxy, so you can both contain a misbehaving agent and observe what it tried
to reach.

Secrets (LLM keys, per-attempt product credentials from a runtime's provision
hook) reach a container as environment variables written to a `0600` env-file
at create time — never on the command line, never written into artifacts.
Transcripts are redacted.

The **echo** agent is a built-in no-op adapter that runs the whole
run → score → persist pipeline on the host, with no Docker and no API keys —
it is how you smoke-test an eval or the harness itself. It copies the
starting state and writes a NOTES.md; real checks fail it honestly, which is
exactly what a negative control should do.

## Glossary

| Term                | Meaning                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| **eval**            | A directory defining a task: `PROMPT.md` + `EVAL.ts` scorer + optional `local/`.             |
| **experiment**      | A module defining how attempts run: agent pins, runtime, treatment.                          |
| **agent**           | The coding agent an experiment runs (`echo`, `claude`, `codex`, …).                          |
| **runtime**         | The environment an experiment offers: `host` or `container`, plus its capabilities.          |
| **treatment**       | What an experiment varies, named by an opaque string (`docs`, `mcp`, `cli`, …).              |
| **comparisonGroup** | Experiments claiming to differ only by treatment; agreement is checked, never assumed.       |
| **scorer**          | `EVAL.ts`'s default export: returns named pass/fail checks for one attempt.                  |
| **check**           | One named verdict inside a scorer result (`build_passes`, `no_secrets_in_client`, …).        |
| **attempt**         | One agent × eval × experiment execution, run once, in isolation.                             |
| **trial**           | A repeat of the same pair (default 3).                                                       |
| **pair**            | One eval × experiment combination — the report's row unit (a *cell* in the UI).              |
| **run**             | One `quickstudy run`, all pairs and trials, under one run id.                                |
| **manifest**        | The immutable content-addressed identity record written before attempts start.               |
| **suite**           | Eval class: `benchmark` (headline), `regression`, or `other`.                                |

Next: [Getting started](./getting-started.md) ·
[Writing an eval](./writing-an-eval.md)
