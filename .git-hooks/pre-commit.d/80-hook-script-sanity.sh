#!/usr/bin/env bash
set -euo pipefail

mapfile -t hook_paths < <(git diff --cached --name-only --diff-filter=ACMR | grep -E '^\.git-hooks/.+\.sh$' || true)

if [[ "${#hook_paths[@]}" -eq 0 ]]; then
  exit 0
fi

declare -a failures=()

for path in "${hook_paths[@]}"; do
  mode="$(git ls-files --stage -- "$path" | awk 'NR==1 {print $1}')"
  if [[ "$mode" != "100755" ]]; then
    failures+=("$path must be committed with mode 100755 (found ${mode:-<missing>})")
  fi

  first_line="$(git show ":$path" | sed -n '1p')"
  if [[ "$first_line" != '#!/usr/bin/env bash' ]]; then
    failures+=("$path must start with #!/usr/bin/env bash")
  fi
done

if [[ "${#failures[@]}" -eq 0 ]]; then
  exit 0
fi

printf 'Refusing to commit invalid hook scripts:\n' >&2
printf '  %s\n' "${failures[@]}" >&2
exit 1
