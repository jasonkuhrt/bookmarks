import { homedir } from "node:os"
import { join } from "node:path"

export const defaultBookmarksDir = (): string =>
  process.env["BOOKMARKS_DIR"] ?? join(homedir(), ".bookmarks")

export const defaultYamlPath = (): string =>
  process.env["BOOKMARKS_YAML_PATH"] ?? join(defaultBookmarksDir(), "bookmarks.yaml")

export const defaultSchemaPath = (): string =>
  process.env["BOOKMARKS_SCHEMA_PATH"] ?? join(defaultBookmarksDir(), "bookmarks.schema.json")

export const defaultBackupDir = (): string =>
  process.env["BOOKMARKS_BACKUP_DIR"] ?? join(defaultBookmarksDir(), "backups")

export const defaultRuntimeDir = (): string =>
  process.env["BOOKMARKS_RUNTIME_DIR"] ?? join(defaultBookmarksDir(), "runtime")

export const defaultSyncLockPath = (): string =>
  join(defaultRuntimeDir(), "sync.lock.json")

export const defaultSyncQueuePath = (): string =>
  join(defaultRuntimeDir(), "sync.queue.json")

export const defaultSafariPlistPath = (): string =>
  join(homedir(), "Library/Safari/Bookmarks.plist")
