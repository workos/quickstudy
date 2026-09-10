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

Release-please owns the version bump, the changelog, tag creation, and the
release. It runs on every push to `main` and maintains one release PR;
merging that PR creates the `vX.Y.Z` tag and a **draft** GitHub release
whose body is the generated changelog. The release workflow
(`release.yml`) is then invoked synchronously (`workflow_call`, not a
GitHub event, so it is not subject to the `GITHUB_TOKEN` no-cascade rule):
it checks out the exact tag, builds and smoke-tests the four binaries, runs
the tarball self-check, attaches the archives to that draft release, and
finally undrafts it. The release is only public after the build, smoke,
and pack-check all pass.

A manual dispatch is still available for rebuilds and artifact-only builds:

- A manual dispatch with no `release_tag` builds the immutable dispatch-event
  commit as downloadable workflow artifacts (no release is created or
  touched).
- Supplying an existing `v*` tag in `release_tag` checks out, verifies,
  builds, re-attaches the archives (`--clobber`), and re-publishes that
  exact tag's release, regardless of the branch from which the workflow was
  dispatched.

There is no scheduled publication path and no registry publication path.

## Release checklist

1. Land changes on `main` using Conventional Commit messages
   (`feat:`, `fix:`, `chore:`, …). release-please reads these to decide the
   next bump (`feat:` → minor, `fix:` → patch while pre-1.0 via
   `bump-minor-pre-major`).
2. Review the release-please release PR: it bumps `package.json`,
   `.release-please-manifest.json`, `CHANGELOG.md`, and the committed
   `src/build-info.generated.ts` placeholder. The placeholder line carries an
   `x-release-please-version` marker that release-please's generic updater
   bumps deterministically (verified against the real updater), so the
   tarball self-check cannot drift on a release PR.
3. On the release PR, click **Approve workflows to run** in the merge box
   after bot-created updates. Wait for `lint + typecheck`, `test + pack`,
   and `lint-pr-title` to pass, then merge. Merging creates the tag and
   draft release and triggers the binary build.
4. Verify all four native smoke jobs, the tarball self-check, and the
   SHA-256 files before announcing the release.
5. Download and manually exercise at least one macOS and one Linux artifact.

For a local pre-flight (independent of release-please), run `bun test`,
`bun run typecheck`, `bun run lint`, `bun run ui:e2e`, build locally, and
exercise `dist/quickstudy` outside the repository.

Windows is not included until the Docker, filesystem, shell, and external
eval/experiment import paths have a native Windows acceptance suite. Do not cross-compile an asset and
imply support without running it on the target OS.

macOS artifacts are not notarized by this workflow. Add signing/notarization
only with repository-managed Apple credentials and a documented verification
step; do not place certificate material in the binary or ordinary build logs.

## Release automation (release-please)

`release-please-config.json` and `.release-please-manifest.json` (repo root)
configure `googleapis/release-please-action` (pinned in
`.github/workflows/release-please.yml`). The manifest version tracks
`package.json` and must stay in sync with it. The config sets:

- `include-component-in-tag: false` → plain `vX.Y.Z` tags.
- `release-type: node`, `bump-minor-pre-major: true` → `feat:`/`fix:` bump
  minor/patch while pre-1.0.
- `draft: true`, `force-tag-creation: true` → the tag is pushed and the
  release created as a **draft**, so it stays invisible until
  `release.yml` attaches binaries and undrafts it. A failed build leaves a
  draft, not a public release.
- `extra-files: ["src/build-info.generated.ts"]` → the committed
  `--version` placeholder is bumped alongside `package.json`. Its `version:`
  line carries the `x-release-please-version` marker, which release-please's
  generic updater anchors on to replace the semver deterministically (the
  bump was verified against release-please's real `Generic` updater in an
  isolated repo). Without that marker the generic updater leaves the
  placeholder untouched and `scripts/pack-check.sh` drifts on the release
  PR.

### Required repository settings (maintainer, not code)

These are repo settings or protection rules — do not change them from an
agent; flag them to a maintainer:

- **No App, PAT, or custom secrets are required.** Both release-please and
  binary publishing use the built-in `GITHUB_TOKEN`. GitHub queues
  `pull_request` checks for bot-created or updated PRs pending approval by
  someone with write access. All three PR workflows use this event; select
  **Approve workflows to run** in the PR merge box when prompted. See
  [GitHub's workflow-trigger rules](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow).
  Tag/release events remain suppressed, so binary publishing is called
  directly through `workflow_call` instead.
- **Settings → Actions → General → "Allow GitHub Actions to create and
  approve pull requests"** must be checked, or release-please cannot open
  its release PR.
- **Branch protection on `main`** must require the `lint + typecheck`,
  `test + pack`, and `lint-pr-title` job checks before merge; approval starts
  the checks, it does not bypass them.
- **Tag protection** (if enabled) must permit the GitHub Actions bot to
  create `v*` tags — `force-tag-creation: true` creates the tag before publish.
- Existing commit-signing requirements still apply to release PRs; do not
  bypass them.

### Limitations

- **`v0.0.1` is the baseline, not a cut release.** With no prior tags, the
  manifest declares `0.0.1` as the last-released version so release-please
  starts from the right baseline; the first actual release is the next bump
  (`v0.0.2` / `v0.1.0`). A maintainer may instead cut `v0.0.1` explicitly
  with a one-time `release-as` before adopting this automation.
- **`extra-files` placeholder bump is deterministic.** The `version:` line
  in `src/build-info.generated.ts` carries the `x-release-please-version`
  marker, so release-please's generic updater replaces the semver on every
  release PR (verified against the real `Generic` updater). The committed
  source `--version` therefore stays in lockstep with `package.json`, and
  `scripts/pack-check.sh` fails on drift if anyone edits the placeholder by
  hand. The marker is restored as-is after a binary build
  (`scripts/build-binary.ts`).
- **The release starts as a draft.** If `release.yml` never runs (e.g.
  the `workflow_call` is misconfigured), the release stays an invisible
  draft with a tag but no binaries. The concurrency group
  `release-<tag>` with `cancel-in-progress: false` prevents a manual
  rebuild from racing a release-please call and double-publishing.
- **Manual dispatch rebuilds an existing release.** `release_tag` must
  name a tag whose release-please release already exists; `release.yml`
  uploads-then-undrafts rather than `gh release create` (which would
  collide with release-please's release and clobber its changelog).
- **macOS artifacts are not notarized; Windows is unsupported** (see notes
  above).

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

1. Publish from the tagged commit produced by the merged release-please
   release PR. That PR already bumped `package.json`,
   `.release-please-manifest.json`, `CHANGELOG.md`, and the committed
   `src/build-info.generated.ts` placeholder (what `--version` prints from
   source; compiled binaries embed the `package.json` version at build
   time) — do not bump the version by hand. Check out the `vX.Y.Z` tag and
   run `bun install` so `bun.lock` matches the tagged tree.
2. Run `bash scripts/pack-check.sh`: it packs, installs the tarball into a
   clean temp directory, checks `bunx quickstudy --version` against
   `package.json`, asserts the UI shell shipped, and validates fixture
   evals/experiments roots through the installed package. CI runs the same
   check on every push.
3. Read the packed file list once by eye (`npm pack --dry-run`): no tests,
   no `docs/`, no local results stores.
4. The `vX.Y.Z` tag and its GitHub release are cut by release-please
   (merge the release PR → `release.yml`), which re-runs pack-check — so a
   tag cannot ship a broken tarball. Publish from that same tagged commit.
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
5. **Release notes**: release-please generates the GitHub release body
   from Conventional Commits when the release PR is merged. Prepend the
   prepared release narrative — what the release is, what moved where,
   upgrade pointers — by editing the release body after creation.
