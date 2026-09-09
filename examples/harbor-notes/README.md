# Harbor Notes: a complete second-product example

This example uses Quickstudy's public package API. Its prompt, fixture, scorer,
experiment, provisioning runtime, policy, and telemetry targets live here.
The basic path runs a scripted agent in Alpine and needs Bun plus Docker and
local `alpine:3` and `quickstudy/egress-proxy` images. No account or key is used.

From the Quickstudy checkout, run the isolated consumer smoke:

```bash
bun scripts/portable-smoke.ts
```

It copies this example to a temporary consumer directory, resolves imports by
package name, validates, runs two trials with concurrency 2, and checks the
strict report. Provisioning creates a temporary notebook, the scorer queries
its expected document while the sandbox is alive, and teardown deletes it.
The script deletes its temporary results when finished.

To keep your results, work from this directory: `bun install`, then
`bunx quickstudy validate`, `bunx quickstudy run --trials 2 --egress-proxy`,
and `bunx quickstudy report --latest --strict`. Use the printed run ID with
`bunx quickstudy export RUN_ID --expected-trials 2 --mode hosted --out site`.
Serve `site/` with any static server. Use `--mode offline` to embed run data for
file sharing; transcripts and diffs require a local server in either mode.

For a real agent, build `quickstudy/agent-runtime` and the two proxy images
using `quickstudy images build`. Add an experiment using `harborRuntime(false)`
and `agent: { adapter: "claude", provider: "anthropic", model: "YOUR_EXACT_MODEL_ID",
reasoning: "high" }`, or the supported Codex adapter with its exact model and
reasoning pins. Set the corresponding provider key. Select that experiment
explicitly; it makes paid calls. The runtime offers no product network hosts;
with `--egress-proxy` the adapter's provider endpoints are the only allowed
external destinations. `containerImage()` selects the agent image, and all
other runtime/scorer code is shared with the local demonstration.

`semantic-example.ts` demonstrates the optional rubric interface with a fake
judge. It is deliberately outside the eval discovery tree. See
[extension contracts](../../docs/extensions.md) for evidence limits, identity,
error handling and calibration before substituting a live judge.
