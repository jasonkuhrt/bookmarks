# bookmarks

Cross-browser bookmark sync driven by a single user config at `~/.config/bookmarks/bookmarks.yaml`.

The repo is the product. Clone it locally, run the CLI from the clone, and optionally install the global `bookmarks` launcher so it points back at your working tree.

## Clone Repo Workflow

```bash
git clone git@github.com:jasonkuhrt/bookmarks.git
cd bookmarks
just install
just schema
```

Optional global launcher:

```bash
just install-global
```

Recommended first checks:

```bash
bookmarks sync --dry-run
bookmarks doctor
```

If you do not want a global launcher, run the CLI from the repo:

```bash
bun run bookmarks -- status
```

## Managed Files

The CLI manages separate config and state roots by default:

- config: `~/.config/bookmarks/`
- state: `~/.local/state/bookmarks/`

Important paths:

- `~/.config/bookmarks/bookmarks.yaml`
- `~/.config/bookmarks/bookmarks.schema.json`
- `~/.local/state/bookmarks/sync-baseline.yaml`
- `~/.local/state/bookmarks/backups/`
- `~/.local/state/bookmarks/runtime/`

Relevant commands bootstrap what they can safely bootstrap:

- they create the managed config and state directories if they do not exist
- they mirror the repo JSON schema into the managed schema path
- write commands create `bookmarks.yaml` when they first save it
- non-git syncs maintain `sync-baseline.yaml` automatically so sync remains incremental without git

The YAML file can reference the adjacent schema with:

```yaml
# machine-managed: bookmarks daemon status=stopped; phase=stopped
# yaml-language-server: $schema=./bookmarks.schema.json
```

The top machine-managed comment reflects daemon UX state such as `stopped`, `starting`, `queued`, `syncing`, or `idle`.

You can refresh the repo copy and managed copy explicitly:

```bash
just schema
```

Minimal example:

```yaml
# yaml-language-server: $schema=./bookmarks.schema.json
version: 2
all:
  bar:
    - name: Docs
      url: https://docs.example

chrome:
  enabled: true
  profiles:
    default:
      enabled: true
```

Target selection rules:

- omit selectors to operate on all discovered bookmark targets
- Safari is one shared bookmark target, so `safari` is valid and `safari/<profile>` is not
- pass a bare browser selector like `chrome` to operate on every discovered Chrome profile
- pass an exact selector like `chrome/profile-1` to scope literally
- exact typos fail clearly instead of silently falling back

## Sync Workflow

`bookmarks sync` is the product:

```bash
bookmarks sync
```

What sync does:

- reads the managed `bookmarks.yaml`
- discovers Safari once and all discovered Chrome profiles
- merges YAML and browser changes
- sends destructive losers to the graveyard instead of dropping them
- creates backups before mutation
- writes live browser data
- rereads and verifies the result

If sync hits ambiguous or unsupported semantics, it stops before mutation and returns a clear error instead of silently mangling data.

## CLI

Core commands:

```bash
bookmarks sync [target...]
bookmarks sync [target...] --dry-run
bookmarks status [target...]
bookmarks status --json
bookmarks doctor --json
bookmarks validate [--json]
bookmarks backup [--json]
bookmarks gc [--max-age=90d] [--json]
bookmarks daemon start|stop|status
```

Notes:

- `sync` is the default automated workflow.
- `sync --dry-run` shows the live diff without mutating browsers.
- `status` shows pending changes in both directions and includes patch previews.
- `validate` validates `bookmarks.yaml`.
- non-dry-run `sync` and `gc` create timestamped backups in `~/.local/state/bookmarks/backups/` before they attempt writes.
- `backup` is available when you want an extra snapshot on demand.
- `doctor` runs against the actual configured targets from `bookmarks.yaml`, not hardcoded default browser paths.
- runtime locking still serializes concurrent sync runs.

## Daemon

`bookmarks daemon start` installs a launchd-managed watcher process.

What it does:

- watches `bookmarks.yaml`
- queues a sync 60 seconds after the last file edit instead of syncing on every keystroke
- updates the machine-managed header at the top of `bookmarks.yaml` with watcher state
- uses the normal `bookmarks status` check before syncing, so no-op edits do not create sync backups

Manual immediate sync stays explicit:

```bash
bookmarks sync
```

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
just hooks-install
just install-global
just build
just schema
just format
just pre-commit
just pre-push
just quality
```

Quality gates:

- `just pre-commit` runs format, lint, and type checks
- `just pre-push` runs the full `bun run check` gate
- tracked `.git-hooks/pre-commit.d/` hooks run staged formatting and linting, staged type checks, and safety guards once `just hooks-install` has been run

Direct commands, if needed:

```bash
bun run check
bun run check:lint
bun run check:types
bun run test:coverage
bun run check:cov
```

The test suite is fixture-driven and hermetic. It does not depend on live Safari or Chrome bookmark files.
