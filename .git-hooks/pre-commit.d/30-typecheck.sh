#!/usr/bin/env bash
set -euo pipefail

staged_paths="$(git diff --cached --name-only --diff-filter=ACMR)"

if [[ -z "$staged_paths" ]]; then
  exit 0
fi

if ! grep -Eq '(^|/).+\.(ts|tsx|mts|cts)$|(^|/)(package\.json|tsconfig(\..+)?\.json)$' <<<"$staged_paths"; then
  exit 0
fi

exec bun run check:types
