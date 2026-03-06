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

## Testing

```bash
bun test
```

Some current adapter tests still use live Safari and Chrome bookmark files from the local machine. They pass locally on a configured macOS machine, but they are not hermetic CI tests yet.
