# quickstudy

If you own a developer platform, coding agents raise two questions you can't
currently answer: **can an agent actually complete a real task with your
product**, and **does changing the developer surface change that outcome**?
quickstudy is an open-source, company-agnostic eval harness that measures both.
It runs coding agents against real integration tasks under different
**experiment treatments**, grades each attempt in isolation, and reports pass
rates plus conservative, deterministic treatment-effect analysis.

If you want DX investment to go where it measurably moves the needle, this is
for you. ([Concepts](./docs/concepts.md) unpacks both questions.)

## What you get

Every run produces a report with per-pair stats, from fact to interpretation:

```
run 01J…: 60 attempts — 41 passed, 17 failed, 0 incomplete, 2 errored

acme-nextjs × claude-docs   1/10 passed (10% pass rate)
  build_passes 10/10  auth_flow_wired 4/10  login_flow_e2e 1/10 …
acme-nextjs × claude-mcp   10/10 passed (100% pass rate)
```

One row per **eval × experiment** pair: trials passed, per-check pass counts,
and whether the pair ran all its trials. Comparison groups (experiments that
differ only by their declared treatment) are diffed at validate time, so a
gap between `claude-docs` and `claude-mcp` is attributable to the treatment —
not to a drifted model pin or a changed prompt.

This is an effect of offering a treatment under the recorded harness, not
proof that a treatment caused an individual failure.

The same data also renders as an interactive, self-contained static
[site](#ui--sharing-results) you can publish or hand to a teammate.

## Install

The npm package is **Bun-only**: it ships TypeScript source directly (the
`quickstudy` bin is a `bun`-shebang script and the library exports `.ts`
modules), so it requires [Bun](https://bun.sh) ≥ 1.1 — there is no Node
build. Add it to the repository that holds your evals and experiments:

```bash
bun add quickstudy       # Bun >= 1.1 required; no Node build exists
bunx quickstudy --version
```

Your `EVAL.ts` scorers and experiment modules import harness types by package
name (`import type { EvalContext } from "quickstudy"`) — see
[Writing evals](#writing-evals) below and
[docs/writing-an-eval.md](./docs/writing-an-eval.md) for the authoring loop.
Container-based experiments additionally need the harness images built once
with `quickstudy images build` (requires Docker).

No Bun at all? Download the archive for your OS and architecture from
[GitHub Releases](https://github.com/workos/quickstudy/releases) instead. Each
archive contains one self-contained `quickstudy` executable (CLI + UI), with
no Bun runtime or source checkout required. Release assets are named
`quickstudy-{linux|darwin}-{x64|arm64}.tar.gz`.

To build that binary from source (requires Bun):

```bash
bun install
bun run build            # → dist/quickstudy  (the whole CLI + UI in one file)
mv dist/quickstudy /usr/local/bin/     # or anywhere on your PATH
```

Prefer running from source? Replace `quickstudy` with `bun src/cli.ts` in any
command below (see [Development](#development)).

## Quickstart

Only **Docker** and an agent **API key** are needed to run a real agent — the
first commands need neither. An eval is a directory (`PROMPT.md` + `EVAL.ts`
scorer + optional `local/` starting state); an experiment is one TypeScript
module. Author a toy pair and run it end-to-end with the no-op `echo` agent:

```bash
# 1. author a one-check eval and a host echo experiment
mkdir -p demo-evals/hello demo-experiments
printf -- '---\nid: hello\nsuite: benchmark\n---\n\nWrite NOTES.md describing the task.\n' > demo-evals/hello/PROMPT.md
printf -- 'export default async (ctx) => { const ok = await ctx.fileExists("NOTES.md"); return { passed: ok, checks: [{ name: "notes-written", passed: ok }] }; };\n' > demo-evals/hello/EVAL.ts
printf -- 'export default { id: "echo-demo", agent: { adapter: "echo" }, runtime: { kind: "host" } };\n' > demo-experiments/echo-demo.ts

# 2. validate both roots, then run — no Docker, no keys
quickstudy validate --evals-root demo-evals --experiments-root demo-experiments
quickstudy run --eval hello --experiment echo-demo --evals-root demo-evals --experiments-root demo-experiments --trials 1

# 3. read the report (step 2 prints a run id)
quickstudy report <run-id>
```

`echo` is a pipeline smoke, not a solver — it copies the starting state and
writes NOTES.md, so this toy check passes; against real evals every check
fails, which is exactly what a negative control should do. Completing the
run → score → persist loop is what it proves.

Real measurements come from a benchmark repository built on quickstudy: an
`evals/` root of real integration tasks (tiny HTTP apps under `local/`) and
an `experiments/` root of real agent recipes. From such a checkout, running
one costs a container image build and an API key:

```bash
export ANTHROPIC_API_KEY=sk-...
quickstudy images build                 # one-time: runtime + proxies
docker build -t acme/nextjs images/frameworks/nextjs
quickstudy run --eval acme-nextjs --experiment claude-docs --trials 1
```

(Bun auto-loads a gitignored `.env` from the working directory, so keys can
live there instead of `export` lines.) Model and reasoning pins live in the
experiment module — changing them changes the experiment's identity, by
design. See the benchmark repository's `examples/weekly-sweep.yml` for what
a full scheduled sweep costs and looks like in CI.

## How it works

Every attempt is one point in a 2-D plan:

| Axis           | Varies                                                       | Defined by                     |
| -------------- | ------------------------------------------------------------ | ------------------------------ |
| **eval**       | WHAT is attempted: prompt, starting state, scorer            | an `evals/<id>/` directory     |
| **experiment** | HOW it runs: agent, model pins, runtime, treatment           | an `experiments/<id>.ts` module |

An experiment's **runtime** owns everything the environment offers the agent:
per-attempt provisioning, the container image, egress policy, MCP servers,
native-web policy, and a PATH treatment. Experiments sharing a
`comparisonGroup` are compared as treatments of one configuration; a group
whose members disagree on anything beyond the declared treatment has
automatic comparison withheld.

Before the first paid attempt, quickstudy writes an immutable run manifest
covering the harness source, each eval's effective prompt / starting state /
scorer, and each experiment's agent pins, runtime, and module source.
Identity drift between runs is diffed, never silently averaged.

## Commands

```
quickstudy validate                   # discover + validate evals/ and experiments/
quickstudy run --eval <id> --experiment <id>   # execute the selected pairs
quickstudy report <run-id>            # per-pair stats (--latest for the newest run)
quickstudy diagnose <run-id>          # LLM-diagnose failing pairs into diagnosis.json
quickstudy ui                         # serve the matrix/compare/report/trend UI
quickstudy export <run-id> --out dir  # the same UI as a self-contained static site
quickstudy images build               # build the agent-runtime + proxy images
quickstudy clean                      # remove all quickstudy-labeled containers/networks
```

Run `quickstudy --help` for every flag (`--trials`, `--db`, `--egress-proxy`,
`--evals-root`, `--experiments-root`, …).

`diagnose` is the one command that calls a model after the fact: it sends each
failing pair's harness-selected evidence (per-check tallies, transcript
excerpts, egress denials) to a structured LLM call and writes `diagnosis.json`
beside `report.json` — findings are evidence-linked hypotheses, never
verdicts, keeping the report itself attribution-free. Requires
`ANTHROPIC_API_KEY`; the UI renders the result as a Diagnosis view.

## Writing evals

An eval is a directory: `PROMPT.md` (frontmatter + the task prompt), `EVAL.ts`
(a default-exported scorer), and an optional `local/` tree the attempt starts
from. The harness core knows nothing company-specific; your evals and
scorers may name any vendor freely.

```ts
import type { EvalContext, EvalResult } from "quickstudy";

export default async function score(ctx: EvalContext): Promise<EvalResult> {
  const wired = await ctx.fileExists("app/callback/route.ts");
  return { passed: wired, checks: [{ name: "callback_wired", passed: wired }] };
}
```

Scorers get file helpers over the exported workspace, `exec` into the live
sandbox, and any `query`/`getClient` capabilities the experiment's runtime
provides. Shared check helpers live in your benchmark repository next to the
evals that use them. [docs/writing-an-eval.md](./docs/writing-an-eval.md)
walks the whole authoring loop.

To point quickstudy at **your own product**: author an evals root and an
experiments root in a repository of your own — the toy pair above is the
smallest complete example, and `--evals-root`/`--experiments-root` point the
CLI anywhere. The harness core carries no vendor assumptions — a test suite
enforces that `src/`, `ui/`, and `scripts/` stay vendor-clean — so nothing in
this repository needs to change.

## UI & sharing results

One renderer, two delivery modes — both pure static files, no server API. The
compiled binary carries the UI shell, so there's nothing to build first; when
running from source, build the bundle once with `bun run ui:build`:

```bash
quickstudy ui                             # serve every run at http://127.0.0.1:4173
quickstudy ui --watch                     # re-export when the results DB changes

quickstudy export <run-id> --out ./site        # self-contained site
quickstudy export --runs a,b --out ./site       # two runs → Compare view
```

The exported directory works from `file://` (the data index is inlined into
`index.html`; transcripts and diffs lazy-load when served), so you can zip it,
attach it, or publish it. GitHub Pages recipe:

```bash
quickstudy export <run-id> --out ./site
npx gh-pages -d site        # or push ./site to any static host
```

## Development

Run the CLI from source as `bun src/cli.ts <cmd>` (what `quickstudy` is,
uncompiled).

```bash
bun install
bun test                 # all suites (Docker-gated ones auto-enable when present)
bun run typecheck        # tsc --noEmit (harness) + tsc -p ui
bun run lint             # oxlint
bun run build            # compile the self-contained binary → dist/quickstudy
bun src/cli.ts validate
```

UI development runs against committed seed data — no Docker, agents, or keys:

```bash
bun run ui:dev           # Vite dev server + ui/dev-data at /data (hot reload)
bun run ui:dev-data      # regenerate ui/dev-data from the seeders
bun run ui:build         # production bundle (ui/dist) + gzip budget check
bunx playwright install  # one-time: the browsers ui:e2e drives
bun run ui:e2e           # Playwright smoke: served routes + offline file:// load
```

## Documentation

- **[docs/concepts.md](./docs/concepts.md)** — what it measures and why.
- **[docs/getting-started.md](./docs/getting-started.md)** — install to first report.
- **[docs/writing-an-eval.md](./docs/writing-an-eval.md)** — authoring evals and experiments.
- **[docs/publishing-a-benchmark.md](./docs/publishing-a-benchmark.md)** — gates for publishing results.
- **[docs/releasing.md](./docs/releasing.md)** — cutting prebuilt binaries.

## License

MIT
