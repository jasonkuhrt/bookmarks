# bookmarks

Cross-browser bookmark sync driven by `~/.bookmarks/bookmarks.yaml`.

## Commands

```bash
bun run bookmarks -- help
bun run bookmarks -- status
bun run bookmarks -- sync
```

## Config

The CLI expects a managed config directory at `~/.bookmarks/` containing:

- `bookmarks.yaml`
- `bookmarks.schema.json`

The YAML file can reference the schema with:

```yaml
# yaml-language-server: $schema=./bookmarks.schema.json
```

Generate the repo schema copy with:

```bash
bun run generate:json-schema
```

If you also want to mirror the generated schema into your live config dir:

```bash
BOOKMARKS_SCHEMA_PATH="$HOME/.bookmarks/bookmarks.schema.json" bun run generate:json-schema
```

## Development

Local setup:

```bash
bun install
bun install -g .
```

`bun install -g .` currently creates a symlinked global install on this machine:

```text
~/.bun/bin/bookmarks
  -> ~/.bun/install/global/node_modules/@jasonkuhrt/bookmarks/src/bin/bookmarks.ts
  -> /Users/jasonkuhrt/projects/jasonkuhrt/bookmarks
```

That means normal edits under `src/` are picked up immediately by the global `bookmarks` command. You do not need to rerun `bun install -g .` after ordinary source changes.

Rerun `bun install -g .` when the global launcher itself needs to be regenerated, for example after changing:

- `package.json` `bin` entries
- the package name
- the CLI entrypoint path

If dependencies change, run `bun install` in the repo. For repo-local execution without any global install, use:

```bash
bun run bookmarks -- status
```

## Testing

```bash
bun test
```

Some current adapter tests still use live Safari and Chrome bookmark files from the local machine. They pass locally on a configured macOS machine, but they are not hermetic CI tests yet.
