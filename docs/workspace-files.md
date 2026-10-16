# Attempt-local workspace files

`Runtime.workspaceFiles` offers non-secret skill/document files without replacing
Claude, Codex, or another built-in container adapter. **Do not use
`runtime.command` as a staging hook:** a nonempty command bypasses adapter
resolution, authentication, configuration, and vendor stream parsing.

The public API exports `WorkspaceFile`, `WorkspaceFiles`,
`WorkspaceFilesIdentity`, `WorkspaceFilesEvidence`, `defineWorkspaceFiles`, and
`WORKSPACE_FILES_LIMITS`. `defineWorkspaceFiles` is an optional validating,
copying, deeply freezing helper. `defineExperiment` validates and freezes its
runtime declaration too. Imports below use the documentation's `quickstudy`
package alias; use your installed dependency name.

## Files versus no files

```ts
import { defineExperiment, defineWorkspaceFiles } from "quickstudy";
import { readFileSync } from "node:fs";

// Read an audited, locally vendored, pinned file at experiment load time.
// No network fetch, installation command, host-directory mount, or callback.
const offered = defineWorkspaceFiles({
  version: 1,
  files: [{
    path: ".agents/skills/harbor/SKILL.md",
    encoding: "base64",
    content: readFileSync(new URL("./payload/SKILL.md", import.meta.url)).toString("base64"),
    source: { id: "harbor-guide", version: "commit-abc123" },
  }],
  absent: [],
});
const control = defineWorkspaceFiles({
  version: 1,
  files: [],
  absent: [".agents/skills/harbor"],
});

// Export each arm from its own experiment module. Keep all other settings equal.
const common = {
  agent: { adapter: "codex", model: "gpt-5.4-2026-03-05", reasoning: "high" },
  comparisonGroup: "harbor-files",
};
export default defineExperiment({
  ...common,
  id: "codex-files", // control module: codex-no-files
  treatment: "files",
  runtime: {
    kind: "container",
    image: "quickstudy/agent-runtime:local", // use your actual resolved image
    workspaceFiles: offered, // control module: control
    treatmentPolicyFields: ["workspaceFiles"],
  },
});
```

A real payload includes its required reference files and license/attribution,
each as another file with its own destination and declared source. The harness
does not infer references, recursively read directories, fetch upstream content,
or prove that a source label is authentic. Do not use this fictional guide or
source pin as a substitute for an approved upstream payload.

Omitting the declaration means *no overlay instrumentation*, not proven absence.
A no-file control should assert the entire reserved tree absent. Existing
contamination fails the control; it is never deleted to manufacture cleanliness.
The assertion does not search other workspace locations or the image/home.

## v1 data and limits

All fields are plain data:

- `version: 1` selects the staging semantics below. Unknown versions fail
  preflight; they are never interpreted as v1.
- `files: readonly WorkspaceFile[]` lists regular, non-executable files.
  Each file has `path`, `content`, explicit `encoding: "utf8" | "base64"`, and
  `source: { id, version }`.
- `absent: readonly string[]` lists file-or-tree paths that must not exist.
- Source id/version are opaque labels: 1–160 ASCII characters, starting with
  an alphanumeric character, followed by alphanumerics or `_.:@+-`. Use an
  immutable revision or content version. URLs, absolute source paths and
  credentials do not belong here.

Limits: **128 files**, **128 absence assertions**, **256 KiB per file**, and
**1 MiB total decoded payload**. Empty files are supported. UTF-8 converts with
`Buffer.from(content, "utf8")`; unpaired surrogates are rejected. Base64 must be
canonical, padded RFC 4648 (the empty string is valid). It preserves arbitrary
bytes, including NUL, invalid UTF-8, CRLF and trailing newlines. Equivalent UTF-8
and base64 declarations produce the same byte identity. No shell interpolation
or newline normalization occurs. Files are created with mode `0644`; there is
no executable flag, symlink, hardlink, device, directory-payload or mount type.
Nothing in a payload is executed by staging.

Paths are relative to `/workspace`, at most **240 ASCII characters** and **16
segments**, separated by `/`. Each nonempty segment uses only `A-Za-z0-9_.-`.
Absolute paths, `.`/`..`, trailing dots, empty segments, backslashes, colons,
Windows drive/UNC/device names, whitespace and control characters are rejected.
Case-insensitive duplicate or ancestor/descendant destinations are rejected,
including overlaps with absence assertions. Sibling files may share parents.

Reserved segments include `.git*`, `.hg*`, `.svn*`, `.quickstudy*`, credential-like
names (the harness's credential-file exclusion rules), and export-excluded
names: `node_modules`, `vendor`, `.venv`, `.next`, `.cache`, `__pycache__`.
These conservative rules apply at every depth. This is not a credential delivery
channel: use runtime provisioning/environment injection for secrets instead.
Payloads are explicitly non-secret and can appear in the exported workspace and
diff; hashes are not a safe way to publish low-entropy secrets either.

## Ordering and filesystem safety

Supported: **container adapters**, including the container oracle (whose
fixture/reference starting state is prepared as usual). Images must provide
Git and Linux Node at `/usr/local/bin/node` (the standard agent-runtime does).
The absolute Node executable avoids PATH-treatment shadowing. Missing tooling
is an environment error. Host adapters and nonempty scripted `runtime.command`
combinations are rejected at preflight, including absence-only declarations.
Without an overlay, existing host/scripted/oracle behavior is unchanged.

Each attempt:

1. Copies the starting state into a fresh source and container; commits the
   fixture/reference baseline. Overlays require a successful Git baseline.
2. Computes normal adapter setup file declarations; checks for overlapping
   adapter destinations before any overlay writes.
3. Validates all overlay destinations and absence assertions in the actual
   sandbox, then creates the files exclusively. Existing destination files,
   directories, dangling links, and symlink ancestors are errors. Existing
   ordinary parent directories are allowed; extra sibling files are not deleted.
4. Reads bytes back and compares sizes/hashes to the identity-bound inventory.
5. Writes the adapter's ordinary setup files (for example, Codex MCP TOML).
6. Rechecks file type, mode, link count, sizes/hashes and every absence assertion,
   then writes successful staging evidence. Adapter setup cannot silently
   invalidate an overlay. Setup paths that alias through symlinks are rejected.
7. Invokes the **unchanged adapter command**, including its normal login,
   configuration flags, transcript/metrics parsing, export, scoring and teardown.

Writes travel as JSON/base64 on stdin, not through argv or a shell. The Linux
helper walks ancestors using no-follow directory descriptors anchored under
`/workspace`; reads/writes also use no-follow opens. Staging has no reason to
write the consumer fixture, another attempt, the shared image or host home.
Trusted image executables and harness adapters remain part of the trust boundary;
this is not attestation against a malicious image or hostile daemon.

The whole stage/setup/final-verification sequence has a fixed **30-second** v1
budget. Cancellation stops its transport; the runner awaits the stopped operation
and tears down the sandbox rather than racing a late write against agent start.
No agent execution follows a timeout. This budget is part of versioned semantics,
not the agent budget or a new CLI flag.

Invalid metadata/unsupported combinations fail at definition or run preflight.
Filesystem, adapter setup, write/read-back, absence, timeout and cancellation
failures produce `status: error`, `error_kind: environment`, no scorer result,
and null agent timestamps. They are not genuine agent/scorer failures. Payloads
are omitted from staging diagnostics; cleanup failures are recorded alongside,
not instead of, the primary error.

## Intended identity versus placement evidence

The sorted inventory is in the v4 manifest at:

```text
pairs[JSON.stringify([evalId, experimentId])].workspaceFiles
  version
  files[]: { path, size, sha256, source: { id, version } }
  absent[]
```

It contributes to both runtime/experiment and attempt identity. The actual
payload bytes are hashed automatically—even bytes read dynamically outside
literal imports or `quickstudy.identity.json` resource trees. There is no manual
second hash field to drift. At run entry the harness snapshots/canonicalizes the
payload before awaiting external work, and staging uses that immutable snapshot.
Injected/stale manifests must match it. Bytes, destination, provenance, absence
expectations, and staging version are identity-bearing. Unsupported versions
are refused rather than generating a runnable identity.

After successful final verification, the attempt directory contains:

```text
results/<run>/<attempt>/workspace-files.json
  version: 1
  verified: <actual read-back inventory and checked absence paths>
  verifiedAt: <Unix milliseconds, before agent start>
```

This artifact is separate from the intended manifest. No successful evidence is
written on staging failure. Evidence can still exist if cancellation happens
immediately afterward or the agent later fails. It proves placement/checks **at
that time**, not agent discovery, reading, obedience, or successful task execution.
The agent may subsequently edit these files. Inspect transcript/tool evidence
separately before claiming use.

No-overlay v4 manifests retain their old shape; v3 and old v4 results are not
rewritten. Normal harness/source drift still refuses resume. Overlay identity
drift also refuses stale manifests/resume; completed attempts are never silently
reused under new bytes.

## Comparison contract

Both arms explicitly list `"workspaceFiles"` in
`runtime.treatmentPolicyFields` to exempt only this resolved overlay inventory
from group comparison. Both must agree on the **entire** exemption list. Full
identities remain distinct. Without this declaration, differing files or absence
assertions withhold comparison. Use exactly `["workspaceFiles"]` for a files-only
study; do not inherit unrelated exemptions from another treatment.

This does not exempt image, model, reasoning, CLI, fixture/scorer identity,
command, lifecycle budgets, runtime configuration outside the treatment subtree,
or network/MCP/PATH/web policy. The existing separate policy exemptions retain
their explicit meaning; adding files grants no additional tool/network access.
Comparison is agreement on declared configuration, not causality or proof of use.

See [the consumer handoff](workspace-files-handoff.md) for isolated local
integration before a real release.
