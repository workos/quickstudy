# Publishing a quickstudy benchmark

A public benchmark is a claim about a frozen experiment, not just a static
site. Use this checklist to produce the site and raw evidence for publication;
deployment remains an explicit operator action.

## Decide exactly what the result claims

Write the claim before running anything. Name:

- the repository revision and eval ids;
- every experiment: agent, exact model and reasoning pins, agent CLI version,
  runtime, and declared treatment;
- trial count and provisioning mode;
- which outcomes each check proves, and which external systems remain out of
  scope.

Every published eval needs a **probe boundary** stated verbatim in the
benchmark repository's own docs and repeated in the claim: what the scorer's
checks prove, and what stays out of scope. Boundaries that look similar are
different claims — for example:

- "hosted login reaches the protected dashboard, visibly renders the
  provisioned identity, and preserves the session across reload" is an
  end-to-end claim;
- "the protected route initiates the redirect and reaches the configured
  provider" is a **handoff benchmark** — not a claim that callback, identity,
  or session persistence completed;
- "the app accepts an exactly signed synthetic delivery and rejects missing
  and invalid signatures" scopes real network delivery out.

If an eval offers both a default probe mode and a stricter operator-only
acceptance mode, they are separate claims: never pool their results in one
published number.

## The four publication gates

Do not publish until every gate is green. All four exist to prove the
**scorers'** validity before any paid attempt — positive coverage alone
detects false negatives, not false positives:

1. **Colocated scorer tests pass.** Every published eval's `EVAL.test.ts`
   pins its named checks and fails the unmodified starting state
   (`bun test evals/`).
2. **Family-level adversarial mutations pass.** For every shared check
   helper, a targeted mutation of a plausibly-correct workspace fails the
   intended check and **only** that check (`bun test scorers/`).
3. **A runtime smoke completes** under the same provisioning and probe mode
   as the published runs — the docker-gated runtime suite
   (`bun test tests/treatment-runtime.test.ts` with the images built), or a
   one-cell live run of the published shape.
4. **Explicit operator acceptance.** A human has reviewed the scorers'
   verdicts against real attempt evidence and worked through the live
   checklist below. For any MCP-treatment experiment this includes a one-cell
   live acceptance proving agent → token proxy → your MCP server with a real
   recorded `tools/call` — merely making the server available does not prove
   the agent used it.

In addition, before exporting anything public:

- The working tree used for the run is committed and tagged, and the run
  manifest identifies the same evals, prompts, starting states, scorers,
  images, harness, agents, and pins.
- The run is complete: no missing trials and no infrastructure errors
  (`report --strict` enforces this).
- The treatment assignment and its controls are documented. In the reference
  runtime pattern, the product CLI is on `PATH` only under the `cli`
  treatment, and native web tools are blocked outside the `docs` treatment.
  This controls availability; it does not make an environment hermetic —
  shell and network alternatives remain unless the egress proxy is enabled.
  Review the report's surface-usage telemetry (doc URLs, MCP tool calls, CLI
  commands) and disclose cross-treatment use.
- Transcripts, diffs, egress logs, and metadata pass a human secrets/privacy
  review even though the exporter redacts known credentials.

## Live acceptance checklist

One live run of the published shape (e.g. `acme-nextjs × claude-mcp`),
checked by hand — the agent's own pass/fail is recorded as evidence, but
these pipeline facts are the gate:

- [ ] Exit 0; attempt status `completed` (or a scorer-visible failure — not
      `error`/`incomplete`)
- [ ] Provisioning ran and tore down (no orphaned product environment)
- [ ] MCP auth succeeded through the proxy (transcript shows tool traffic)
- [ ] Workspace exported; the scorer ran against the live environment; named
      checks persisted
- [ ] Transcript + diff artifacts resolve from the attempt row; secrets
      redacted
- [ ] Full identity present in the manifest (model, CLI version, image
      digest, treatment)

## Credentials and operator-only steps

These cannot be completed by an offline test suite:

| Gate                       | Operator requirement                                                            |
| -------------------------- | -------------------------------------------------------------------------------- |
| Live product provisioning  | Product environment access or one-shot provisioning availability                |
| Full-acceptance probe mode | An operator-controlled environment the stricter probe can drive headlessly      |
| Agent attempts             | Provider API keys for every published experiment's agent                        |
| MCP treatment              | The benchmark repository's interactive MCP login tooling plus the agent provider key |
| Publication                | Approval and credentials for the chosen static host/repository                  |

Keep credentials outside the publication bundle. Never publish MCP auth env
files, `.env`, provisioning pool secrets, provider keys, claim tokens,
cookies, or raw MCP arguments.

## Run protocol

Use one immutable configuration: the experiment modules pin agent, model,
reasoning, and treatment, and the run manifest records them along with image
digests and the harness revision — publish the manifest hash and the run time
window. Do not update agent CLIs, image tags, model pins, scorers, starting
states, or documentation between the runs you intend to compare.

Start with one trial per pair as a cost/credential pilot. For a published
pass rate, plan at least 10 independent trials per pair; three trials are
useful for smoke detection but not a high-confidence estimate. Report
numerator, denominator, errors, and exclusions rather than only percentages —
the report already renders raw counts and refuses to claim more.

Example sequence (choose evals and experiments before running):

```bash
# One live MCP acceptance cell before the paid sweep (the checklist above).
quickstudy run --eval acme-nextjs --experiment claude-mcp --trials 1

# Published measurement: both treatments of the comparison group, under the
# egress proxy so reached-for hosts are recorded.
quickstudy run \
  --eval acme-nextjs --eval acme-rails \
  --experiment claude-docs --experiment claude-mcp \
  --trials 10 --egress-proxy
```

If an eval defines a stricter operator-only probe mode (selected by an
environment variable or provisioning slot the benchmark repository
documents), run it separately against a controlled environment, with the
identities and endpoints the probe needs verified independently and rejected
up front when incomplete — a probe must fail its setup check before an agent
runs, not infer targets from the application under test.

A failed or unavailable full-acceptance run does not invalidate a correctly
labeled default-mode benchmark, but it must not be silently reported as full
acceptance.

## Build the publication bundle

Generate and verify the report before exporting:

```bash
quickstudy report <run-id> --strict
quickstudy export <run-id> --out ./site
```

`--strict` exits non-zero on an incomplete run or any attempt error — a
publishable run has neither. The first command also stores `report.json`
alongside the run's artifacts.

Retain an immutable private archive containing the database, full results
directory, runner logs, image digests, binary checksum, manifest, and cost
records. The public bundle should contain:

- the self-contained `site/` export;
- machine-readable `run.json` and `report.json` from that export;
- a short methodology document with the claim and limitations above;
- checksums for the binary and published files;
- a list of omitted or redacted artifacts and the reason for each omission.

Before uploading, open the site from `file://` and through a static server,
exercise the Matrix/Compare/Report routes at desktop and mobile widths,
follow several evidence links, and verify that incomplete/error/
telemetry-unavailable states remain visible. Publication itself is
deliberately outside `quickstudy export`: upload only after the owner reviews
and approves the bundle.

## Minimum language for the results page

State that comparison groups measure what was observed when a treatment was
made available under this recorded harness — raw counts per arm, nothing
more. Do not present a gap as proof that a treatment produced any individual
outcome, and do not add intervals or attribution the report itself refuses to
compute. Name actual surface usage and cross-treatment contamination, sample
sizes, error and exclusion counts, provisioning mode, probe boundaries, and
any operator-only acceptance results. If you rank agents, use only the
identical intersection of fully completed pairs for every agent shown, and
disclose the union, intersection, coverage rate, and every omitted
coordinate.

## Resuming and publishing a complete sample

For v4 runs, `quickstudy run --resume RUN_ID` verifies the recorded source and
execution identity, runs missing coordinates, and preserves completed failures.
Add `--retry-unfinished` only when you intend to retry errors/timeouts; their
original evidence remains in the retry history.

`quickstudy report RUN_ID --strict` checks distinct planned trial indexes and
valid scored outcomes. A timeout-only or missing-trial run fails this gate;
a fully scored failed task is still a valid measurement.

Use `quickstudy export RUN_ID --expected-trials N --mode hosted --out site`
for explicit complete-sample publication. It excludes incomplete pairs, uses
identical complete eval coverage across comparison arms, and writes omission
lists plus source diagnostics. An empty eligible set fails. Retain an ordinary
export of the source run alongside selective publication. Historical v3 runs
remain readable but cannot attest the stronger identity required by this mode.

Hosted exports fetch run snapshots on demand and require a static server.
`--mode offline` embeds run/report/diagnosis data for file sharing; transcript
and diff viewing still needs a server. See [extension and execution contracts](extensions.md)
for budgets, policy evidence, telemetry limits, and source fingerprinting.
