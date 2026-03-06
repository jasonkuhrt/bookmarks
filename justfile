set shell := ["zsh", "-eu", "-o", "pipefail", "-c"]

default:
  @just --list

install:
  bun install

install-global:
  bun install -g .

schema:
  bun run generate:json-schema

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
