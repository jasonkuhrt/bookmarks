#!/usr/bin/env bash
set -euo pipefail

staged_paths="$(git diff --cached --name-only --diff-filter=ACMR)"

if [[ -z "$staged_paths" ]]; then
  exit 0
fi

declare -a blocked_paths=()

while IFS= read -r path; do
  [[ -n "$path" ]] || continue

  if [[ "$path" == .serena/* || "$path" == "CLAUDE.local.md" || "$path" == "README.new.md" ]]; then
    blocked_paths+=("$path")
  fi
done <<<"$staged_paths"

if [[ "${#blocked_paths[@]}" -eq 0 ]]; then
  exit 0
fi

printf 'Refusing to commit local-only agent artifacts:\n' >&2
printf '  %s\n' "${blocked_paths[@]}" >&2
printf 'Unstage or remove these files before committing.\n' >&2
exit 1
