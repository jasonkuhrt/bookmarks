#!/usr/bin/env bash
set -euo pipefail

exec bun run check:test:cov
