# Releasing prebuilt binaries

The release workflow builds and smoke-tests four standalone artifacts:

- Linux x64 baseline and arm64;
- macOS Intel and Apple silicon.

Each archive contains the executable, the project license, a minimal
installation README, and `SOURCE.txt` with the exact source ref and commit. The binary is tested from a temporary directory outside the checkout. The
smoke authors a toy eval and a host echo experiment inline, validates both
roots, runs the pair through the v3 runner, and renders a report. This
catches the common failures where a nominally standalone binary still reads
source-tree assets at runtime, or cannot dynamically import external
`EVAL.ts`/experiment modules.

The workflow has two explicit modes:

- Pushing a `v*` tag builds artifacts and creates that GitHub release.
- A manual dispatch with no `release_tag` builds the immutable dispatch-event
  commit as downloadable workflow artifacts. Supplying an existing `v*` tag
  checks out, verifies, builds, and releases that exact tag, regardless of the
  branch from which the workflow was dispatched.

There is no branch-push or scheduled publication path.

## Release checklist

1. Update `package.json` and user-facing release notes.
2. Run `bun test`, `bun run typecheck`, `bun run lint`, and `bun run ui:e2e`.
3. Build locally and exercise `dist/quickstudy` outside the repository.
4. Tag the reviewed commit with the matching `v*` version and push the tag.
5. Verify all four native smoke jobs and SHA-256 files before announcing the
   release.
6. Download and manually exercise at least one macOS and one Linux artifact.

Windows is not included until the Docker, filesystem, shell, and external
eval/experiment import paths have a native Windows acceptance suite. Do not cross-compile an asset and
imply support without running it on the target OS.

macOS artifacts are not notarized by this workflow. Add signing/notarization
only with repository-managed Apple credentials and a documented verification
step; do not place certificate material in the binary or ordinary build logs.

## Publishing to npm

quickstudy publishes to npm as `quickstudy` — a **Bun-only** package shipping
TypeScript source directly (`exports` points at `src/index.ts`; the
`quickstudy` bin is a bun-shebang script; `engines` asks for Bun ≥ 1.1).
`package.json`'s `files` allowlist keeps the tarball to `src`, `ui/dist`,
`images`, README, and LICENSE — the explicit `ui/dist` entry overrides its
gitignore, and `prepack` (`bun run ui:build`) guarantees it exists and is
fresh at pack time. External evals and experiments import types from the
`"quickstudy"` package name, which a registry install resolves the same way
a source checkout does.

Publishing is an **operator action** — no workflow or script runs
`npm publish`.

1. Bump `version` in `package.json` and in the committed
   `src/build-info.generated.ts` placeholder (what `--version` prints from
   source; compiled binaries embed the `package.json` version at build time).
   Run `bun install` so `bun.lock` reflects the edit.
2. Run `bash scripts/pack-check.sh`: it packs, installs the tarball into a
   clean temp directory, checks `bunx quickstudy --version` against
   `package.json`, asserts the UI shell shipped, and validates fixture
   evals/experiments roots through the installed package. CI runs the same
   check on every push.
3. Read the packed file list once by eye (`npm pack --dry-run`): no tests,
   no `docs/`, no local results stores.
4. Run the binary release checklist above and push the matching `v*` tag —
   the release workflow re-runs pack-check, so a tag cannot ship a broken
   tarball.
5. `npm publish` from the tagged, clean checkout, with the operator's own
   npm credentials (never CI's, never an agent's).
6. Post-publish verification, from an empty directory:
   `bun add quickstudy@<version> && bunx quickstudy --version`, then the
   README Quickstart pair through `validate` — it runs verbatim against a
   registry install.

### First publish (1.0.0) and the consumer flip

The 1.0.0 publish is the name's first: `npm view quickstudy` should 404
beforehand — no placeholder was ever reserved, so step 5 above is a plain
`npm publish`, no `--tag` gymnastics. Concretely, on top of the runbook:

1. **Publish against the public registry explicitly**:
   `npm publish --registry=https://registry.npmjs.org`. If the machine's npm
   traffic routes through a registry proxy (`npm config get registry` prints
   something other than registry.npmjs.org), a bare publish targets the
   proxy, not npmjs.
2. **Verify where it landed**:
   `npm view quickstudy version --registry=https://registry.npmjs.org` must
   print `1.0.0`. Then check the default route (plain
   `npm view quickstudy version`) — a proxy can lag on a brand-new package
   while it scans it, and consumer installs resolve through that proxy.
3. **Flip the consumer repo**: from a repo that depends on
   `"quickstudy": "file:../quickstudy"`, run its
   `bash scripts/flip-to-registry.sh`. The script rewrites the dependency to
   `^1.0.0`, drops the sibling-checkout CI arrangement, sweeps the
   pre-publish prose, refreshes `bun.lock` (consumer CI installs with
   `--frozen-lockfile`), prints the diff, and proves the flip with
   install + validate + typecheck + tests. Commit its whole diff in one
   commit — a partial commit leaves CI checking out a layout that no longer
   exists or hard-failing on lockfile drift.
4. **Push the consumer repo** to its remote (create one first if the repo is
   still local-only), then run one real attempt from it as the post-split
   smoke — container images built first, in the ordering its README
   documents.
5. **Release notes**: the tag workflow creates the GitHub release with
   `--generate-notes` (commit log only). Prepend the prepared release
   narrative — what the release is, what moved where, upgrade pointers — by
   editing the release body after creation.
