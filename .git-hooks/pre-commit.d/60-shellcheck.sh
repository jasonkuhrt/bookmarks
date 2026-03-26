#!/usr/bin/env bash
set -euo pipefail

mapfile -t shell_paths < <(git diff --cached --name-only --diff-filter=ACMR | grep -E '(^|/).+\.sh$' || true)

if [[ "${#shell_paths[@]}" -eq 0 ]]; then
  exit 0
fi

exec shellcheck "${shell_paths[@]}"
