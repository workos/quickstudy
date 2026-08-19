# Getting started

This walks you from an install to reading your first report. The headline act
runs one existing eval against one experiment with a real agent; the keyless
act proves the whole pipeline on your machine with **no Docker and no API
keys**. If a term is unfamiliar, [Concepts](./concepts.md) defines it.

1. **Run a real measurement** — an agent works a real integration task in an
   isolated container, and a scorer checks the result.
2. **Prove the instrument keylessly** — author a toy eval + experiment inline
   and run the whole run → score → report loop with the no-op `echo` agent.
3. **See it in the UI** — the same data as a browsable, shareable site.

## Prerequisites

| You need                  | For                                                                  |
| ------------------------- | -------------------------------------------------------------------- |
| **[Bun](https://bun.sh)** | only to build the binary or run from source                          |
| **Docker**                | only to run _real_ agents in isolated containers                     |
| **API keys**              | only for real LLM agents (`ANTHROPIC_API_KEY`, …)                    |

The keyless act needs none of Docker, keys, or network — the `echo` agent
runs the full run → score → persist pipeline on the host.

## Install

Download the archive matching your machine from
[GitHub Releases](https://github.com/workos/quickstudy/releases)
(`quickstudy-{linux|darwin}-{x64|arm64}.tar.gz`). Each contains one
self-contained CLI + UI executable: extract it, mark it executable if
necessary, and place it on `PATH`. It needs no Bun runtime and is smoke-tested
outside the repository during release.

To build from source instead:

```bash
git clone <this-repo> && cd quickstudy
bun install
bun run build            # → dist/quickstudy
mv dist/quickstudy /usr/local/bin/     # or anywhere on your PATH
```

> Prefer running uncompiled? `bun src/cli.ts <cmd>` is exactly what
> `quickstudy` is — swap it in anywhere below.

## 1. Run a real measurement

**Goal: your first genuine data point.** Real measurements come from a
benchmark repository built on quickstudy: an `evals/` root of real
integration tasks (tiny HTTP apps under each eval's `local/`) and an
`experiments/` root of real agent recipes with their model pins already
committed. [Writing an eval](./writing-an-eval.md) is how such a repository
gets authored; here, assume a checkout of one and pick one eval and one
experiment.

One-time setup — build the harness images, then the framework image the eval
runs in. Both are plain `docker build`s:

```bash
quickstudy images build                 # one-time: agent-runtime, egress-proxy, mcp-proxy
docker build -t acme/nextjs images/frameworks/nextjs
```

`images build` exists so the tags come out exactly as run preflight expects
them, and because the agent-runtime image pins the agent CLI versions the
harness's transcript parsers are tested against (`--pull` is the deliberate
way to bump those pins). Framework images live in the benchmark repository
and build FROM the agent-runtime image — build the one your chosen eval
declares, under the tag its experiments expect.

Now run one eval against one experiment, one trial:

```bash
export ANTHROPIC_API_KEY=sk-...
quickstudy run --eval acme-nextjs --experiment claude-docs --trials 1
```

That is the whole selection model: `--eval` names WHAT is attempted,
`--experiment` names HOW it runs. The agent works inside a throwaway
container, the workspace is exported, the eval's scorer checks it, and
everything persists to `results.db` (+ artifacts under `results/`) under a
printed **run id**. Model and reasoning pins live in the experiment module —
changing them changes the experiment's identity, by design, so there are no
model flags to pass.

Read the result (the run id from above, or `--latest`):

```bash
quickstudy report --latest
```

You get one row per eval × experiment pair — pass rate and per-check counts —
plus totals, cost/token telemetry, and raw per-arm counts for any comparison
groups the run covered. (Keys can live in a gitignored `.env` in the working
directory instead of `export` lines — Bun auto-loads it.)

## 2. Prove the instrument keylessly

**Goal: prove the machinery on your machine, measure nothing.** An eval is a
directory; an experiment is one module. Author a toy pair inline — no
scaffolding command needed or provided — and run it with the built-in no-op
`echo` agent, entirely on the host:

```bash
mkdir -p demo-evals/hello demo-experiments
printf -- '---\nid: hello\nsuite: benchmark\n---\n\nWrite NOTES.md describing the task.\n' > demo-evals/hello/PROMPT.md
printf -- 'export default async (ctx) => { const ok = await ctx.fileExists("NOTES.md"); return { passed: ok, checks: [{ name: "notes-written", passed: ok }] }; };\n' > demo-evals/hello/EVAL.ts
printf -- 'export default { id: "echo-demo", agent: { adapter: "echo" }, runtime: { kind: "host" } };\n' > demo-experiments/echo-demo.ts
```

**Validate** both roots. Validation parses every PROMPT.md, imports every
scorer, checks every experiment's shape, and diffs comparison groups — a
clean tree prints what it found and exits `0`; any problem exits non-zero
with file/line context:

```bash
quickstudy validate --evals-root demo-evals --experiments-root demo-experiments
quickstudy run --eval hello --experiment echo-demo --evals-root demo-evals --experiments-root demo-experiments --trials 1
```

The run prints its summary line and run id. `echo` is a pipeline smoke, not a
solver — it copies the starting state and writes NOTES.md, so this toy check
passes; against real evals every check fails, which is exactly what a
negative control should do. (Failed attempts are results: the run exits `0`
unless an attempt _errors_.)

```bash
quickstudy report <run-id>
```

The report on this known result is how you learn its shape for free: totals,
the single `hello × echo-demo` pair with its named check, and a methodology
note. `--json` prints the machine-readable form; `--strict` exits non-zero on
incomplete or error-bearing runs, for CI.

## 3. See it in the UI

**Goal: the same data, rendered for humans and for sharing.**

One renderer, two delivery modes — both pure static files, no server API. The
compiled binary carries the UI shell; when running from source, build the
bundle once with `bun run ui:build` first.

```bash
quickstudy ui             # serve every run at http://127.0.0.1:4173
```

To hand results to someone else, export a self-contained static site. Summary
views work from `file://`; serve or publish the directory to review
lazy-loaded transcript and diff evidence:

```bash
quickstudy export <run-id> --out ./site
```

## Scaling up and iterating

- **More pairs**: `--eval` and `--experiment` repeat; `--suite` and
  `--framework` filter the eval list by its frontmatter metadata.
- **Trials**: the default 3 detects gross failures and nondeterminism; it
  does not make a small gap definitive. Plan trial counts around the smallest
  difference worth acting on — the report renders raw counts either way.
  Watch the cost: every pair × trial with a paid agent is a paid session.
- **Egress observation**: `--egress-proxy` routes attempt traffic through a
  per-run allowlist proxy and records what the agent reached for.
- **Single attempts** (source checkout):
  `bun scripts/dev-attempt.ts --eval <id> --experiment <id>` iterates on one
  attempt against throwaway dev stores.
- **Comparisons**: give two experiments the same `comparisonGroup` and
  different `treatment`s; `validate` diffs the group up front and the report
  renders raw per-arm counts — see [Concepts](./concepts.md).

When you're done, reclaim resources:

```bash
quickstudy clean      # remove all quickstudy-labeled containers/networks
```

## Next steps

To point all of this at **your own product**, write an eval:
[Writing an eval](./writing-an-eval.md) walks the whole authoring loop — the
prompt, the scorer contract, the starting state, the colocated tests, and the
experiment module — with a runnable toy example, then sketches what a
full-scale benchmark repository grows around it.

Publishing numbers? [Publishing a benchmark](./publishing-a-benchmark.md) is
the gate checklist.
