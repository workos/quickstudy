# Writing an eval

An eval is **one directory** that defines a task and how to score it. This
page walks the whole authoring loop: the prompt, the starting state, the
scorer, running it, testing it, and pairing it with an experiment. Everything
here is runnable as written — the toy example needs no Docker and no API
keys.

## Anatomy

```
my-evals/
  hello-config/
    PROMPT.md      # frontmatter metadata + the task prompt, verbatim
    EVAL.ts        # default-exported scorer: workspace in, named checks out
    local/         # optional starting state, copied into the attempt
```

That's the entire contract. There is no registry to update and no manifest to
edit: dropping a valid directory under the evals root (default `evals/`;
override with `--evals-root`) makes the eval discoverable by `validate` and
`run`. The directory name **is** the eval id — except for
[framework variants](#framework-variants-frameworks), where one directory
yields one eval per listed framework, ids `<dirname>-<framework>`.

## The prompt: `PROMPT.md`

Create the directory, the starting state, and the prompt:

```bash
mkdir -p my-evals/hello-config/local
printf -- '{\n  "appName": "demo"\n}\n' > my-evals/hello-config/local/app.config.json
printf -- '---\nid: hello-config\nsuite: benchmark\ntopics:\n  - configuration\n---\n\nAdd a top-level "greeting" key to app.config.json. Keep the file valid JSON.\n' > my-evals/hello-config/PROMPT.md
```

`PROMPT.md` is YAML frontmatter followed by the task body, which the agent
receives **verbatim** — write it the way you'd brief a contractor. The
frontmatter schema is deliberately tiny and closed:

| Key          | Required | Meaning                                                                                                                                                     |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`         | yes      | Must equal the directory name (prevents silent aliasing).                                                                                                   |
| `suite`      | yes      | `benchmark` (headline), `regression`, or `other` — non-benchmark suites never move headline scores.                                                         |
| `product`    | no       | Free-form product label, used for reporting.                                                                                                                |
| `framework`  | no       | The app stack the task targets (`nextjs`, `rails`, `django`, …); container runtimes and `--framework` filters read it.                                      |
| `frameworks` | no       | List of framework tokens; expands the directory into one eval per framework (id `<dirname>-<framework>`). See [Framework variants](#framework-variants-frameworks). |
| `local`      | no       | With `frameworks:` only — path (relative to the eval directory) to a shared fixture root holding per-framework starting states.                             |
| `topics`     | no       | List of free-form tags.                                                                                                                                     |

Unknown keys are rejected, a missing task body is rejected, and every
violation is reported with the file and line — `validate` catches all of this
before anything runs.

## The starting state: `local/`

If `local/` exists, its tree is copied into the attempt's workspace before
the agent starts; the prompt should describe that state ("this is a starter
Next.js application…"). Without `local/`, the agent starts from an empty
workspace. Never put real secrets in `local/` — starting states are hashed
into the run manifest and exported with attempt artifacts.

## Framework variants: `frameworks:`

A product task is often the same brief across several app stacks. Instead of
duplicating the directory per stack, list the stacks in the frontmatter:

```yaml
---
id: acme-auth
suite: benchmark
frameworks:
  - nextjs
  - rails
---
```

Discovery expands the directory into one eval per framework — here
`acme-auth-nextjs` and `acme-auth-rails` — sharing the prompt body verbatim
(write it framework-neutral; there is no placeholder substitution) and the
scorer. Each variant gets `framework` set on its metadata (so `--framework`
filters and reports work unchanged) and on the scorer's `ctx.framework`, and
takes its starting state from `local/<framework>/`:

```
acme-auth/
  PROMPT.md          # frameworks: [nextjs, rails]
  EVAL.ts            # one scorer; branch on ctx.framework where needed
  local/
    nextjs/          # starting state for acme-auth-nextjs
    rails/           # starting state for acme-auth-rails
```

A listed framework without a matching starting-state directory is a
validation error — unless the eval has no starting state at all (no `local/`
and no `local:`), in which case every variant starts from an empty
workspace.

When several evals share byte-identical starting states, point them at one
fixture tree with the `local:` key instead of duplicating it:

```yaml
---
id: acme-auth
suite: benchmark
frameworks:
  - nextjs
  - rails
local: ../shared-fixtures
---
```

`local:` is resolved relative to the eval directory (relative paths only; it
may not escape the evals root's parent), and each variant's starting state is
`<local>/<framework>` — here `../shared-fixtures/nextjs` and
`../shared-fixtures/rails`. The resolved tree is copied into the attempt's
workspace exactly like `local/`; the fixture root itself is never written to,
and its hash in the run manifest stays byte-stable while the tree is
unchanged. `local:` only makes sense with `frameworks:` — on a
single-directory eval it is rejected.

## The scorer: `EVAL.ts`

`EVAL.ts` default-exports a **scorer**: an async function handed the finished
workspace, returning named pass/fail checks. For the toy eval:

```bash
printf -- 'export default async (ctx) => { const text = await ctx.readFile("app.config.json"); const ok = text.includes("greeting"); return { passed: ok, checks: [{ name: "config_key_present", passed: ok }] }; };\n' > my-evals/hello-config/EVAL.ts
```

The same scorer with types, as you'd write it in a real file:

```ts
import type { EvalScorer } from "quickstudy";

const scorer: EvalScorer = async (ctx) => {
  const text = await ctx.readFile("app.config.json");
  const ok = text.includes("greeting");
  return {
    passed: ok,
    checks: [{ name: "config_key_present", passed: ok }],
  };
};

export default scorer;
```

The `ctx` (an `EvalContext`) gives a scorer everything it may touch:

| Member                                 | What it does                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evalId`, `experimentId`, `trialIndex` | Which attempt is being scored.                                                                                                                                  |
| `framework`                            | The eval's `framework` metadata (set per variant for `frameworks:` evals); absent for framework-neutral evals.                                                  |
| `workspaceDir`                         | Absolute path of the exported workspace.                                                                                                                        |
| `fileExists(path)`                     | Does this workspace-relative path exist?                                                                                                                        |
| `readFile(path)`                       | Read a workspace-relative file as UTF-8 (throws when missing).                                                                                                  |
| `exec(cmd, {timeoutMs})`               | Run a command — inside the live sandbox for container experiments (the runner keeps it alive until the scorer resolves), in the workspace for host experiments. |
| `query(request)` / `getClient(name)`   | Capabilities an experiment's runtime may provide (e.g. an authenticated product API client); a runtime that doesn't provide one makes the helper throw.         |

And the result shape (`EvalResult`):

- `passed` — the attempt's verdict. Convention: the conjunction of the
  checks.
- `checks` — named `CheckResult`s: `{ name, passed, notes?, evidence? }`.
  Check names are the report's per-check vocabulary (`build_passes 10/10`),
  so keep them stable snake_case. `notes` explains a failure; `evidence`
  points at workspace-relative files backing the verdict. `graded: false`
  records a check without grading it (next section).

### Record a check without grading it

Some facts are worth recording but are not the task's pass/fail bar — for
example, whether the agent wired up the product SDK rather than hand-rolling
HTTP calls. Mark such a check `graded: false`:

```ts
const checks: CheckResult[] = [
  { name: "flow_wired", passed: flowOk },
  { name: "sdk_wired", passed: await ctx.fileExists("lib/sdk-client.ts"), graded: false },
];
const graded = checks.filter((c) => c.graded !== false);
return { passed: graded.every((c) => c.passed), checks };
```

`passed` stays the scorer's call, so the scorer must leave ungraded checks out
of it — the two lines above are the whole convention. An absent `graded` means
`true`; any non-boolean value makes the result invalid (the attempt becomes an
`error`).

An ungraded check is stored, exported and tallied like any other (the report
and the UI tag it as recorded, and the matrix's "x/y checks" counts graded
checks only). The report derives **SDK recall** from ungraded checks: per
experiment, the scored attempts that recorded at least one ungraded check, and
of those, the ones whose ungraded checks all passed. If a check name is graded
in one attempt and ungraded in another, the report tallies it as ungraded.

Two rules of thumb keep scorers honest:

- **A scorer that inspects nothing proves nothing.** Fail when the thing you
  meant to check isn't there — never pass vacuously.
- **A broken environment is a failed check, not a crash.** Catch expected
  failure modes (missing file, non-zero build) and return `passed: false`
  with notes; a scorer that throws marks the attempt `error`, which means
  "the instrument broke", not "the agent failed".

## Run it

Pair the eval with an experiment. For a keyless end-to-end loop, a one-line
no-op experiment does: the built-in `echo` agent runs on the host, copies the
starting state, and writes a NOTES.md — a negative control that real checks
should fail.

```bash
mkdir -p my-experiments
printf -- 'export default { id: "echo-demo", agent: { adapter: "echo" }, runtime: { kind: "host" } };\n' > my-experiments/echo-demo.ts
quickstudy validate --evals-root my-evals --experiments-root my-experiments
quickstudy run --eval hello-config --experiment echo-demo --evals-root my-evals --experiments-root my-experiments --trials 1
```

`validate` parses the frontmatter, imports the scorer (a missing or
non-function default export fails here, not mid-run), and checks the
experiment's shape. The run prints its summary line and run id; `echo` never
adds the `greeting` key, so `config_key_present` fails — correct. Read it
back:

```bash
quickstudy report <run-id>
```

That is the entire authoring loop: edit the prompt or scorer, `run`,
`report`. Iterating on a real agent's single attempt from a source checkout:
`bun scripts/dev-attempt.ts --eval <id> --experiment <id>`.

## Composing shared check helpers

A benchmark repository grows shared check helpers next to its evals — a
`scorers/checks.ts` module the `EVAL.ts` files import via relative paths
(types come from the `"quickstudy"` package name; helper code is imported
relatively). A proven helper vocabulary to grow:

| Helper                   | Passes when…                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fileContains`           | any file matching a glob matches a pattern (optionally with comments stripped, so a mere mention in a comment never satisfies the check). An empty selection **fails**. |
| `fileDoesNotContain`     | no selected file matches a forbidden pattern. An empty selection passes vacuously.                                                                                      |
| `execSucceeds`           | a shell command exits 0 in the sandbox (timeout kills are failed checks).                                                                                               |
| `workspaceBuilds`        | the framework's build/check command passes (`npm run build`, `bin/rails zeitwerk:check`, `python3 manage.py check`).                                                    |
| `httpProbe`              | the app starts, answers a readiness path, and one request returns the expected status/JSON body.                                                                        |
| `noSecretsInClientFiles` | no server-side secret patterns appear in client-delivered files.                                                                                                        |

A real scorer is a composition of these plus product-specific helpers — this
is a real product eval's `EVAL.ts` (an `acme-nextjs` auth-integration task)
in its entirety:

```ts
import type { EvalScorer } from "quickstudy";
import {
  noSecretsInClientFiles,
  workspaceBuilds,
} from "../../scorers/checks.ts";
import {
  authFlowWired,
  loginFlowWorks,
} from "../../scorers/acme/auth.ts";

/** This eval's starting state is the Next.js fixture in `local/`. */
const FRAMEWORK = "nextjs";

const scorer: EvalScorer = async (ctx) => {
  const checks = [
    await workspaceBuilds(ctx, { framework: FRAMEWORK }),
    await authFlowWired(ctx, { framework: FRAMEWORK }),
    await loginFlowWorks(ctx, { framework: FRAMEWORK }),
    await noSecretsInClientFiles(ctx, { framework: FRAMEWORK }),
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
};

export default scorer;
```

Product helpers (`scorers/acme/…` here) live next to the evals that use
them, one file per product family, and are shared across the family's
framework variants. When several evals need the same non-trivial check, put
it in a family helper — never copy-paste probe logic between `EVAL.ts` files.

The toy scorer above used `text.includes` because it has no helpers to lean
on yet; with a shared `scorers/checks.ts`, the same check is one helper call:

```ts
import type { EvalScorer } from "quickstudy";
import { fileContains } from "../../scorers/checks.ts";

const scorer: EvalScorer = async (ctx) => {
  const check = await fileContains(ctx, {
    path: "app.config.json",
    pattern: /"greeting"/,
    name: "config_key_present",
  });
  return { passed: check.passed, checks: [check] };
};

export default scorer;
```

## Test the scorer before paying for attempts

A scorer is trusted code: if it passes things it shouldn't, every paid run
built on it is worthless. Two layers of tests keep it honest, and both run
offline:

**1. A colocated `EVAL.test.ts`** next to each `EVAL.ts` (bun:test), with two
expectations:

- **Invocation**: the scorer returns exactly the intended named checks, in
  order — pin them with a `toEqual` on `result.checks.map((c) => c.name)`.
- **Negative**: the unmodified `local/` starting state **fails** the checks
  that require agent work (and passes the ones that must hold even on the
  bare state, like a no-secrets check). Build a fake `EvalContext` over
  `local/` whose `exec` never spawns anything and reports exit 1, so
  build/probe checks must fail honestly on the bare state:

```ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalContext } from "quickstudy";

function fakeCtx(): EvalContext {
  const workspaceDir = join(import.meta.dir, "local");
  return {
    evalId: "acme-nextjs",
    experimentId: "eval-test",
    trialIndex: 0,
    workspaceDir,
    fileExists: (path) => Promise.resolve(existsSync(join(workspaceDir, path))),
    readFile: (path) => readFile(join(workspaceDir, path), "utf8"),
    exec: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }),
    query: () => {
      throw new Error("this experiment runtime does not provide query()");
    },
    getClient: () => {
      throw new Error("this experiment runtime does not provide getClient()");
    },
  };
}
```

**2. Family-level adversarial mutation suites** for shared helpers
(`scorers/<family>.test.ts`, e.g. `scorers/acme/auth.test.ts`): take a
plausibly-correct workspace, apply one targeted mutation (delete the callback
route, weaken the signature check, leak a key into client code), and assert
the mutation fails **the intended check and only that check**. Positive
coverage alone detects false negatives; mutations are what catch false
positives.

Run them the same way as everything else, from the benchmark repository:

```bash
bun test evals/ scorers/
```

## Adding an experiment

An eval says WHAT; an **experiment** says HOW — which agent, with what model
pins, in what runtime, under what treatment. One TypeScript module under the
experiments root (default `experiments/`), default-exporting
`defineExperiment({...})`. This example uses the complete runtime shipped in
[Harbor Notes](../examples/harbor-notes/README.md):

```ts
import { defineExperiment } from "quickstudy";
import { harborRuntime } from "../runtime.ts";

export default defineExperiment({
  id: "claude-notes",
  agent: {
    adapter: "claude",
    provider: "anthropic",
    model: "claude-sonnet-5",
    reasoning: "high",
  },
  runtime: harborRuntime(false),
});
```

- **`agent`** — the adapter plus exact model/reasoning pins. Pins live here
  by design: they are part of the experiment's recorded identity, and moving
  aliases are rejected at run time.
- **`runtime`** — `{ kind: "host" }` for host smoke runs, or a container
  runtime owning the image, per-attempt provisioning, egress allowlist, MCP
  servers, web policy, and PATH treatment. A runtime factory like the
  `runtime.ts` above owns those settings in one place. The example selects
  its real-agent container with `harborRuntime(false)`.
- **`treatment` + `comparisonGroup`** — experiments sharing a group claim to
  differ only by their declared treatment. `validate` diffs that claim up
  front and the report compares the group with raw per-arm counts — or
  withholds the comparison and names the differing components. See
  [Concepts](./concepts.md#treatments-and-comparison-groups).

Then a real measurement is one command (Docker, a framework image, and an
agent key required — see
[Getting started](./getting-started.md#1-run-a-real-measurement)):

```bash
quickstudy run --eval acme-nextjs --experiment claude-docs --trials 1
```

## Checklist before a paid run

- [ ] `quickstudy validate` passes on both roots.
- [ ] The colocated `EVAL.test.ts` pins the check names and fails the bare
      starting state.
- [ ] Shared helpers have adversarial mutation coverage at the family level.
- [ ] An `echo` run completes end to end and the report reads the way you
      expect.
- [ ] Publishing numbers publicly? Work through
      [Publishing a benchmark](./publishing-a-benchmark.md) first.

See [the public extension contract](extensions.md) for identity declarations, cancellation, observation targets, final-agent output and optional semantic scoring.
