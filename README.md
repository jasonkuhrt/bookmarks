# bookmarks

Cross-browser bookmark sync driven by `~/.bookmarks/bookmarks.yaml`.

The repo is the product. The normal workflow is to clone it locally, run the CLI from the clone, and optionally install the `bookmarks` launcher globally so it points back at your working tree.

## Clone Repo Workflow

```bash
git clone git@github.com:jasonkuhrt/bookmarks.git
cd bookmarks
just install
just schema
just hooks-install
```

Optional global launcher:

```bash
just install-global
```

Recommended first checks:

```bash
bookmarks doctor
bookmarks status
```

If you do not want a global launcher, run the CLI from the repo:

```bash
bun run bookmarks -- status
```

## Managed Files

The CLI manages a config directory at `~/.bookmarks/` by default.

Important paths:

- `~/.bookmarks/bookmarks.yaml`
- `~/.bookmarks/bookmarks.schema.json`
- `~/.bookmarks/backups/`
- `~/.bookmarks/runtime/`

Relevant commands now bootstrap what they can safely bootstrap:

- they create the managed config directory if it does not exist
- they mirror the repo JSON schema into the managed schema path
- write commands create `bookmarks.yaml` when they first save it

The YAML file can reference the adjacent schema with:

```yaml
# yaml-language-server: $schema=./bookmarks.schema.json
```

You can still refresh the repo copy and managed copy explicitly:

```bash
just schema
```

Minimal example:

```yaml
# yaml-language-server: $schema=./bookmarks.schema.json
targets:
  chrome:
    default:
      path: /Users/you/Library/Application Support/Google/Chrome/Default/Bookmarks
base:
  favorites_bar:
    - name: Docs
      url: https://docs.example
```

## CLI

Core commands:

```bash
bookmarks status
bookmarks sync
bookmarks sync --dry-run
bookmarks status --json
bookmarks doctor --json
bookmarks validate
```

Notes:

- `status` shows pending changes in both directions and now includes patch previews.
- `push`, `pull`, and `sync` support `--dry-run` and `--json`.
- non-dry-run `push`, `pull`, `sync`, and `gc` create timestamped backups in `~/.bookmarks/backups/` before they attempt writes.
- the explicit `bookmarks backup` command is still available when you want an extra snapshot on demand.
- `doctor` runs against the actual configured targets from `bookmarks.yaml`, not hardcoded default browser paths.
- runtime orchestration serializes active sync runs and queues temporary browser-open blockers instead of forcing manual retry loops.

## Global Install Notes

On this machine, `bun install -g .` creates a launcher that points back to the repo source. Normal edits under `src/` are picked up immediately by the global `bookmarks` command.

Rerun `just install-global` when launcher wiring changes, for example after changing:

- `package.json` `bin` entries
- the package name
- the CLI entrypoint path

Dependency changes still require:

```bash
just install
```

## Development

Primary workflows are exposed through the root `justfile`:

```bash
just install
just install-global
just schema
just pre-commit
just pre-push
just quality
```

Quality gates:

- `just pre-commit` runs `oxlint` and `tsgo`
- `just pre-push` runs lint, typecheck, tests, and coverage enforcement
- native git hooks live under `.beads/hooks`

Direct commands, if needed:

```bash
bun test
bun run lint
bun run typecheck
bun run test:coverage
bun run coverage:check
```

The test suite is fixture-driven and hermetic. It does not depend on live Safari or Chrome bookmark files.
