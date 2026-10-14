# Workspace-file overlay: consumer handoff

## Revisions and boundary

- Inspected/source base: `30928456a7154ab64be9b7a4c4a914e2df7bf8d8` (0.5.0).
- Final harness **implementation** commit:
  `bc6a803469c915f58bd494189006a65cc224e5c4`.
- Offline MCP-test isolation correction: `c7483a1` (no production change).
- The documentation commit containing this handoff follows those commits. Use
  the final branch tip Riker supplies, and record `git rev-parse HEAD` for the
  exact local validation revision. No release/version bump is implied.

This implements the prerequisite described in the existing consumer blocker
report, not that consumer's treatment. No upstream skill was fetched, no
consumer recipes were changed, and no publication/live run was performed.
The existing approved source pin, full reference-tree/license requirements,
separate experiment root/group, and discovery-compatibility questions from that
report still apply. Availability, discovery/read evidence, and task success
remain separate claims.

## Exact API for the existing consumer

The installed package in that job is named `@workos/quickstudy`; import from
that public entry point, **not** runner, manifest or adapter internals:

```ts
import {
  defineExperiment,
  defineWorkspaceFiles,
  WORKSPACE_FILES_LIMITS,
  type Runtime,
  type WorkspaceFile,
  type WorkspaceFiles,
  type WorkspaceFilesIdentity,
  type WorkspaceFilesEvidence,
} from "@workos/quickstudy";
```

The field is `runtime.workspaceFiles: WorkspaceFiles`. Its complete shape is:

```ts
{
  version: 1,
  files: [{
    path: ".agents/skills/harbor/SKILL.md", // workspace-relative, generic example
    encoding: "base64",                   // or explicit "utf8"
    content: locallyReadBytes.toString("base64"),
    source: { id: "harbor-guide", version: "commit-abc123" },
  }],
  absent: [],
}
```

Replace that fictional payload/source with the audited, locally vendored,
approved pin; list every required reference and attribution file. Read exact
bytes (not line-normalized text), then call `defineWorkspaceFiles` to snapshot
and validate. No manually declared SHA field is needed. There is no arbitrary
callback, pre-command, installation script, host path, download, or permission
option. The [API reference](workspace-files.md) defines all limits and errors.

For the control, keep the normal adapter and environment identical:

```ts
const noFiles = defineWorkspaceFiles({
  version: 1,
  files: [],
  absent: [".agents/skills/harbor"], // replace with the actual reserved tree
});
```

Both arms use exactly `treatmentPolicyFields: ["workspaceFiles"]`, a new
comparison group and distinct experiment ids/treatments. Do not inherit the
existing surface study's web/MCP/PATH exemptions. Do not set `runtime.command`.
Use container adapters, not host or scripted containers. This does not change
network authorization, PATH, native-web policy, image, model, CLI pins or budgets.

## What to inspect

- **Intended**: the stored run manifest's
  `pairs[JSON.stringify([evalId, experimentId])].workspaceFiles`. It records
  sorted destination paths, decoded byte sizes/SHA-256, declared source/version,
  absence expectations and staging version. Full experiment/attempt identities
  include this data. No payload or absolute host source path enters the manifest.
- **Actually checked**: `results/<run>/<attempt>/workspace-files.json`, typed as
  `WorkspaceFilesEvidence`: `{version: 1, verified, verifiedAt}`. `verified`
  must equal that pair's intended inventory. Inspect both files and control
  absence evidence. A missing artifact is not a successful absence check.
- **Failure**: attempt `status: error`, `error_kind: environment`, null agent
  timestamps, and `error.txt`; cleanup failures remain additional notes.
- **Model use**: separate transcript/tool evidence. A staged skill can be
  ignored or not discovered. Neither hashes nor pass/fail prove discovery.

## Offline cross-repo validation before a release

Use a **new disposable consumer worktree**, not the active checkout. The
following is a suggested operator workflow, not commands run by this harness
job. Set `CONSUMER_REPO` and `CONSUMER_REVISION` to the intended consumer source
revision; do not borrow another job's unpublished working changes.

```sh
# Start in the final harness worktree supplied by Riker.
export HARNESS_ROOT="$PWD"
git rev-parse HEAD
export CHECK_ROOT="$(mktemp -d)"
git -C "$CONSUMER_REPO" worktree add --detach "$CHECK_ROOT/consumer" "$CONSUMER_REVISION"
cd "$CHECK_ROOT/consumer"

# Disposable override only; never commit this absolute path or its lockfile.
bun -e '
  const fs = require("node:fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const name = "@workos/quickstudy";
  const section = p.dependencies?.[name] ? "dependencies" : "devDependencies";
  p[section] ??= {};
  p[section][name] = "file:" + process.env.HARNESS_ROOT;
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'
bun install --ignore-scripts

export QUICKSTUDY_LIVE_WORKOS=0 QUICKSTUDY_LIVE_TESTS=0 QUICKSTUDY_REQUIRE_DOCKER=0
export DOCKER_HOST=unix:///nonexistent/quickstudy-offline.sock
export QUICKSTUDY_WORKOS_PROVISION=offline
bun -e 'import {defineWorkspaceFiles} from "@workos/quickstudy"; console.log(defineWorkspaceFiles({version:1,files:[],absent:["reserved-guide"]}));'
bun run typecheck
bun test

# AFTER authoring the opt-in consumer recipes/payload in this isolated worktree:
bun node_modules/@workos/quickstudy/src/cli.ts validate \
  --evals-root evals --experiments-root experiments-skills
```

`experiments-skills` does not exist merely because the harness feature exists.
Author and audit that root first. Keep it out of default sweeps. `validate`
checks real generated identities/comparison groups without running an agent;
require the files-only group to be allowed. Add offline consumer tests for
its complete canonical inventory, source pin, license, references and chosen
reserved-tree control. Do not import harness internals to stage files or replace
the adapter. The harness's offline runner suite already exercises the generic
placement/lifecycle contract with generated manifests.

Review consumer changes selectively. Never commit the temporary `package.json`
`file:` override or regenerated lockfile. Remove those disposable changes before
preparing a consumer diff, or copy only explicitly reviewed payload/recipe/tests
to a separate review branch. After preserving wanted work, the operator can
remove the disposable worktree. Nothing here requires modifying the active
consumer checkout or its dependency lockfile.

A `file:` dependency check proves local source integration, not a published
package. Keep the consumer PR draft until a **real** harness release exists,
then update to that actual version and rerun frozen-lockfile installation and
consumer checks. Do not invent a registry version, commit an absolute dependency
path, or add release machinery as part of this prerequisite.

## Checks and remaining gates

Executed in the assigned harness worktree, with live flags off and Docker pointed
at a nonexistent socket:

- `bun install --frozen-lockfile`: installed only in this worktree; no lockfile
  changes or new dependencies.
- Targeted existing suites plus the initial overlay suite:
  **113 pass, 9 skip, 0 fail**.
- Expanded `bun test workspace-files`: **50 pass, 0 fail**; includes the actual
  30-second staging deadline, read-back corruption, unsafe paths/types, immutable
  payloads, control contamination, generated identities/resume/comparison, and
  the production runner with offline container fakes.
- Initial full check: **469 pass, 22 skip, 1 fail**. The pre-existing MCP
  missing-credentials test reached Docker image discovery before its assertion.
  With Riker's approval, it now injects a locally generated manifest using the
  existing test seam; production credential/preflight order is unchanged.
- `bun test mcp-proxy` after that test-only correction: **14 pass, 0 fail**.
- Final required command: typecheck and lint passed; **470 pass, 22 skip,
  0 fail**, 2,349 assertions across 44 files:

```sh
env QUICKSTUDY_LIVE_WORKOS=0 QUICKSTUDY_LIVE_TESTS=0 \
  QUICKSTUDY_REQUIRE_DOCKER=0 \
  DOCKER_HOST=unix:///nonexistent/quickstudy-offline.sock \
  sh -c 'bun run typecheck && bun run lint && bun test'
```

All 22 skips were Docker-gated integrations. Docker access was deliberately
disabled; installed-image availability was not inspected. The new offline fakes run the real staging program on
local temporary files plus the production attempt runner and ordinary Codex
composition/parser; they do **not** prove Linux Docker transport, real CLI
execution, upstream skill discovery, model use or hosted acceptance. The Linux
no-follow descriptor path still needs the authorized real-container gate (the
local filesystem fake uses the host-platform path).

Remaining: review and publish the harness through Riker, a real package release,
isolated consumer validation with its audited pinned payload, and separately
authorized existing-image/container then paid-agent smoke checks. No image build,
paid agent/judge, live provider probe, real-secret read, release, deployment,
push or PR creation was performed by this job.
