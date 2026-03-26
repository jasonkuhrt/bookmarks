#!/usr/bin/env bash
set -euo pipefail

set +e
conflict_output="$(git grep --cached -n -I -e '^<<<<<<< ' -e '^=======$' -e '^>>>>>>> ' -- .)"
conflict_rc=$?
set -e

if [[ "$conflict_rc" -gt 1 ]]; then
  printf 'Failed to scan the staged index for conflict markers.\n' >&2
  exit "$conflict_rc"
fi

if [[ "$conflict_rc" -eq 1 ]]; then
  exit 0
fi

printf 'Refusing to commit conflict markers:\n%s\n' "$conflict_output" >&2
exit 1
