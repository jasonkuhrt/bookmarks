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
- `~/.local/state/bookmarks/sync-baselines.json`
- `~/.local/state/bookmarks/backups/`
- `~/.local/state/bookmarks/runtime/`

Relevant commands bootstrap what they can safely bootstrap:

- they create the managed config and state directories if they do not exist
- they mirror the repo JSON schema into the managed schema path
- write commands create `bookmarks.yaml` when they first save it
- syncs keep `sync-baselines.json`: the tree each target held after its last sync, which the next merge diffs against

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
- merges each target three ways: its baseline, the YAML, and the browser
- writes each target's result back into the YAML layer it came from, so an edit in one browser to a shared folder lands in `all` and reaches every other browser; a folder renamed in one browser keeps the layer its bookmarks came from
- sends destructive losers to the graveyard instead of dropping them
- creates backups before mutation, and none when nothing changes
- updates paired Chrome profiles through Chrome's bookmark API; writes Safari's file while Safari is closed
- saves the YAML before it writes any browser, then rereads and verifies each browser it writes and records that target's new baseline at once, so a sync that fails part way leaves every baseline true to its browser

The baseline lives in the state folder, never in git: a YAML edit committed before any browser saw it is applied to the browsers, not read as a deletion. Git keeps the YAML's history; sync auto-commits each change it makes.

Every tree is compared in one canonical form, Chrome's: web URLs in their WHATWG form, a `'` in a bookmarklet's query as `%27`, and line breaks in titles as spaces. A bookmark stored differently by Safari and Chrome compares equal.

Chrome has no reading list an extension can write, so `all.reading_list` lives in a **Read Later** folder in Chrome's Other Bookmarks. Moving that folder within Other Bookmarks is kept; editing its links edits the shared reading list. The name is reserved at the top of Other Bookmarks: a sync that would put another folder named Read Later there stops before writing any browser and names the folder to rename.

The same URL can appear in multiple folders or more than once in a folder. Sync preserves every placement, and `status` reports duplicate counts as information. You do not need to remove duplicates before syncing.

Paired Chrome stays open during sync. The CLI opens its profile if needed. Safari and unpaired file-backed targets are read while open, and their changes reach the YAML and the other browsers; the writes they need wait until they quit (`waiting` in `sync --json`). Each browser is checked again right before its file is written, so one opened while the sync ran waits the same way instead of saving the tree it loaded over the write. `sync --from-yaml` and `gc` write every target, so they defer while such a browser is open, and stop before a browser that opens while they run.

If sync hits ambiguous or unsupported semantics, it stops before mutation and returns a clear error instead of silently mangling data.

Chrome profiles containing Sync metadata cannot be modified by writing their data file. Pair the companion extension once to use `bookmarks sync` safely with Chrome Sync. The extension preserves existing bookmark IDs where possible, applies moves and updates through Chrome, rejects stale planning snapshots, and verifies the resulting tree before the CLI advances its baseline.

### Connect Chrome once

```bash
bookmarks chrome install
```

Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose the directory printed by the installer. Then pair the intended profile:

```bash
bookmarks chrome pair chrome/profile-1
bookmarks chrome status
bookmarks sync chrome/profile-1 --dry-run
```

On this machine, dotfiles exposes installation through `just bookmarks-chrome-setup`.

The companion extension requests only bookmarks, native messaging, local extension storage, and reconnect alarms. It has no website permissions. A private local socket connects the CLI to the native host; the host accepts only this extension's stable ID. Pairing compares the live tree against the selected profile and pins that extension instance. Multiple matching instances require the user to disambiguate.

Backups include Chrome's live tree as well as its disk snapshot. An interrupted write does not advance that target's baseline: the YAML already holds the merge, so the next sync finishes the write. Inspect `bookmarks status` before retrying by hand. Bookmark changes are individual Chrome operations, not an atomic transaction.

## CLI

Core commands:

```bash
bookmarks sync [target...]
bookmarks sync [target...] --dry-run
bookmarks sync --from-yaml [target...]
bookmarks sync --from-yaml [target...] --dry-run
bookmarks status [target...]
bookmarks status --json
bookmarks doctor --json
bookmarks validate [--json]
bookmarks backup [--json]
bookmarks gc [--max-age=90d] [--json]
bookmarks daemon start|stop|status
bookmarks chrome install
bookmarks chrome pair chrome/profile-1
bookmarks chrome status [--json]
```

Notes:

- `sync` is the default automated workflow.
- `sync --dry-run` shows the live diff without mutating browsers.
- `sync --from-yaml` restores selected browsers to the resolved YAML layout. Paired Chrome uses its live API, including when Chrome Sync is enabled.
- `sync --from-yaml --dry-run` previews that one-way restore without accepting browser-side changes.
- `status` shows pending changes in both directions and includes patch previews.
- `validate` validates `bookmarks.yaml`.
- non-dry-run `sync` and `gc` create timestamped backups in `~/.local/state/bookmarks/backups/` before they attempt writes.
- `backup` is available when you want an extra snapshot on demand.
- `doctor` runs against the actual configured targets from `bookmarks.yaml`, not hardcoded default browser paths.
- runtime locking still serializes concurrent sync runs.

## Daemon

`bookmarks daemon start` installs a launchd-managed watcher process.

What it does:

- syncs once when it starts, so changes made while it was down are not left waiting for an edit
- watches `bookmarks.yaml` and every discovered browser's bookmark file (Safari's `Bookmarks.plist`, each Chrome profile's `Bookmarks`)
- queues a sync 60 seconds after the last edit to any of them instead of syncing on every keystroke
- updates the machine-managed header at the top of `bookmarks.yaml` with watcher state
- runs `bookmarks sync`, which makes no backup when nothing changes
- when a sync leaves writes for an open browser, waits (`phase=waiting`) and syncs again once that browser quits; paired Chrome can stay open
- retries a failed sync with backoff, up to every 5 minutes

launchd runs a small signed launcher, `~/.local/state/bookmarks/bin/bookmarks-sync`, which runs the daemon as its child. macOS checks a read of Safari's or Chrome's bookmarks against that launcher, so it needs **Full Disk Access** once (System Settings → Privacy & Security → Full Disk Access → add the launcher). It is signed with your Apple Development certificate and a fixed identifier, so the grant survives rebuilds and bun upgrades. Until it is granted, `bookmarks daemon status` shows the denied read.

Manual immediate sync stays explicit:

```bash
bookmarks sync
```

## Global Install Notes

`just install-global` runs `bun link`, which links the global package to this checkout, so the global `bookmarks` command and the daemon run the repo's `src/` as it is. (`bun install -g .` instead hard-links a copy, which drifts from the repo whenever a file is replaced rather than edited in place, as git and formatters do.)

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
