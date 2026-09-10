#!/usr/bin/env bash
#
# pack-check: the tarball-install self-check.
#
# Publish readiness IS "does the packed tarball work somewhere else": pack →
# install into a clean temp dir → run the bin → validate fixture roots. This
# proves bin resolution, exports resolution (the fixture evals/experiments
# import the harness by package name), and that the gitignored ui/dist made
# it into the tarball — the failure classes a file listing can't catch.
#
#   bash scripts/pack-check.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# The published package name (a scoped name like @scope/name) and version
# come from package.json — never hardcode the scope or a wildcard tarball
# name. npm pack names the archive `<escaped-name>-<version>.tgz` where the
# escaped name is the package name with the leading `@` dropped and any `/`
# replaced by `-` (so @scope/name@1.2.3 -> scope-name-1.2.3.tgz). A scoped
# name also installs under node_modules/<name> (node_modules/@scope/name),
# not node_modules/<bare-name>.
pkg_name="$(bun -e 'console.log(require("./package.json").name)')"
expected_version="$(bun -e 'console.log(require("./package.json").version)')"
escaped_name="${pkg_name#@}"
escaped_name="${escaped_name//\//-}"
tarball="${escaped_name}-${expected_version}.tgz"
install_dir="node_modules/${pkg_name}"

echo "• building the UI bundle (bun run ui:build)…"
bun run ui:build >/dev/null

pack_dir="$(mktemp -d)"
trap 'rm -rf "$pack_dir"' EXIT

echo "• npm pack → $pack_dir/$tarball"
npm pack --pack-destination "$pack_dir" >/dev/null
test -f "$pack_dir/$tarball"

cd "$pack_dir"
echo "• installing the tarball into a clean directory…"
bun add "$pack_dir/$tarball" >/dev/null

# Bin resolution — and the printed version must equal package.json's, so a
# drifted src/build-info.generated.ts placeholder (what --version reads from
# source) fails here instead of shipping.
actual_version="$(bunx quickstudy --version)"
if [ "$actual_version" != "$expected_version" ]; then
  echo "pack-check: --version printed \"$actual_version\" but package.json says \"$expected_version\"" >&2
  echo "            (bump the committed placeholder in src/build-info.generated.ts)" >&2
  exit 1
fi

# validate never reads the UI shell, so assert the installed tree directly.
# -s also catches the empty-ui/dist-packs-"successfully" failure mode.
if ! test -s "$install_dir/ui/dist/index.html"; then
  echo "pack-check: $install_dir/ui/dist/index.html is missing or empty" >&2
  echo "            (is ui/dist in package.json \"files\", and did prepack build it?)" >&2
  exit 1
fi

# Exports + dynamic-import resolution against the installed package. Expect
# exit 0 with evals: 6 (the two variant fixtures expand to two frameworks
# each) / experiments: 1 — experiment discovery reads only top-level modules,
# so the fixtures' groups/ subdirectory is invisible.
cp -R "$root/tests/__fixtures__/evals" demo-evals
cp -R "$root/tests/__fixtures__/experiments" demo-experiments
bunx quickstudy validate --evals-root demo-evals --experiments-root demo-experiments

if [ "${QUICKSTUDY_REQUIRE_DOCKER:-0}" = "1" ]; then
  cp -R "$install_dir/examples/harbor-notes" portable-consumer
  cd portable-consumer
  bunx quickstudy validate
  bunx quickstudy run --trials 2 --concurrency 2 --egress-proxy
  bunx quickstudy report --latest --strict
  bunx quickstudy export --runs all --expected-trials 2 --mode hosted --out site
  cd "$pack_dir"
fi

echo "pack-check: ok (quickstudy $actual_version)"
