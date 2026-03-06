set shell := ["zsh", "-eu", "-o", "pipefail", "-c"]

default:
  @just --list

lint:
  bun run lint

typecheck:
  bun run typecheck

test:
  bun run test

test-integration:
  bun run test:integration

coverage:
  bun run test:coverage
  bun run coverage:check

pre-commit: lint typecheck

pre-push: pre-commit test coverage

quality: pre-push

hooks-install:
  git config core.hooksPath .beads/hooks
