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

expected_version="$(bun -e 'console.log(require("./package.json").version)')"

echo "• building the UI bundle (bun run ui:build)…"
bun run ui:build >/dev/null

pack_dir="$(mktemp -d)"
trap 'rm -rf "$pack_dir"' EXIT

echo "• npm pack → $pack_dir"
npm pack --pack-destination "$pack_dir" >/dev/null

cd "$pack_dir"
echo "• installing the tarball into a clean directory…"
bun add ./quickstudy-*.tgz >/dev/null

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
if ! test -s node_modules/quickstudy/ui/dist/index.html; then
  echo "pack-check: node_modules/quickstudy/ui/dist/index.html is missing or empty" >&2
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

echo "pack-check: ok (quickstudy $actual_version)"
