#!/usr/bin/env bash
set -euo pipefail

matches="$(sed -nE 's/^run ([0-9A-HJKMNP-TV-Z]{26}): [0-9]+ attempts( |$).*/\1/p')"
count="$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
if [ "$count" != '1' ]; then
  printf 'expected exactly one quickstudy run summary line, found %s\n' "$count" >&2
  exit 1
fi
printf '%s\n' "$matches"
