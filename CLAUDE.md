# quickstudy — agent notes

Company-agnostic eval harness: runs coding agents against evals (task +
scorer directories) under experiments (agent × runtime × treatment recipes)
in Docker isolation, scores attempts, and reports per-pair stats. A separate
`diagnose` command (`src/diagnose/`) LLM-analyzes a run's failing pairs into
evidence-linked hypotheses (`diagnosis.json`), kept apart from the report's
no-attribution stance. This repo
carries zero consumer content: the flagship consumer set (evals, scorers,
runtime, experiments, framework images) lives in the sibling **evals** repo
repo, which depends on this package. The harness core (`src/`) must stay
company-agnostic — `grep -ri workos src/ --exclude-dir=__fixtures__` must
stay match-free, including comments and help text (contract criterion).
`tests/genericity.test.ts` widens that boundary to `ui/src/` and `scripts/`
(no consumer name in shipped harness code); tests may mention vendors freely.

## Toolchain

- **Bun, not Node.** The CLI runs from source: `bun src/cli.ts <cmd>`.
  ESM throughout with **explicit `.ts` import extensions**.
- `bun test` — full suite. Scope with positional filters (`bun test docker`),
  NOT `--filter` (that's Bun's workspace filter and silently runs nothing).
- `bun run typecheck` — two tsc passes (harness `--noEmit`, then `tsc -p ui`).
- `bun run lint` — oxlint over src/tests/ui/scripts.
- Docker-gated suites (`docker`, `egress-e2e`, `treatment-runtime`)
  auto-enable when a daemon and the test images are present; live-API suites
  are env-gated (`QUICKSTUDY_LIVE_TESTS=1` + `ANTHROPIC_API_KEY`,
  `QUICKSTUDY_LIVE_WORKOS=1`).

## UI development (no Docker, agents, or API keys needed)

- `bun run ui:dev` — Vite dev server against committed `ui/dev-data/`.
- `bun run ui:dev-data` — regenerate dev data from the seeders.
- `bun run ui:build` — production bundle + gzip budget check (must precede
  `quickstudy ui`/`export`).
- `bun run ui:e2e` — Playwright smoke (served routes + offline `file://`).

## Container runs

- One-time: `bun src/cli.ts images build` (agent-runtime + egress-proxy +
  mcp-proxy). Framework layers live in the benchmark repo (the evals repo's
  `images/frameworks/<fw>`) and build `FROM quickstudy/agent-runtime` —
  harness images first.
- Real evals/experiments live in the benchmark repo, so `quickstudy validate`
  and `run` operate from a checkout of it (roots default to the cwd).
- Iterate on a single attempt with
  `bun scripts/dev-attempt.ts --eval <id> --experiment <id>` pointed at real
  roots via `--evals-root/--experiments-root` (defaults are cwd-relative).
- `bun src/cli.ts clean` removes all quickstudy-labeled containers/networks.

## Conventions

- An eval is one `<id>/` directory under a consumer repo's evals root:
  `PROMPT.md` (frontmatter `id` == dirname, hard error), a default-exported
  `EVAL.ts` scorer, and an optional `local/` starting state (`src/evals/`
  owns discovery and validation). A `frameworks:` frontmatter list expands
  the directory into one eval per framework — id `<dirname>-<fw>`, starting
  state `local/<fw>/` or a shared `local:` path.
- An experiment is one `<id>.ts` module under the experiments root
  default-exporting `defineExperiment({...})`; its `runtime` owns every
  treatment (provisioning, image, egress hosts, MCP servers, web policy,
  PATH). Model/reasoning pins live in the experiment — they are identity.
- Consumer evals/scorers import TYPES by package name `"quickstudy"` and
  their own helper functions via relative paths — never harness internals.
- Telemetry that's unavailable is `null`, never `0`.
- Secrets reach containers as env at create (via 0600 env-file), never argv,
  never artifacts; transcripts are redacted.
