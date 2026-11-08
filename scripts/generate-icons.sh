#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
command -v rsvg-convert >/dev/null || {
  echo 'Install librsvg (brew install librsvg) to regenerate icons.' >&2
  exit 1
}

for size in 16 32 48 64 96 128 256 512; do
  rsvg-convert --width "$size" --height "$size" \
    extension/icons/icon.svg --output "extension/icons/icon${size}.png"
done
