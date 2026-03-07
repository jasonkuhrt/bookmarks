import { homedir } from "node:os";
import { join } from "node:path";

const defaultXdgConfigHome = (): string =>
  process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");

const defaultXdgStateHome = (): string =>
  process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");

export const defaultConfigDir = (): string =>
  process.env["BOOKMARKS_CONFIG_DIR"] ?? join(defaultXdgConfigHome(), "bookmarks");

export const defaultStateDir = (): string =>
  process.env["BOOKMARKS_STATE_DIR"] ?? join(defaultXdgStateHome(), "bookmarks");

export const defaultYamlPath = (): string =>
  process.env["BOOKMARKS_YAML_PATH"] ?? join(defaultConfigDir(), "bookmarks.yaml");

export const defaultSchemaPath = (): string =>
  process.env["BOOKMARKS_SCHEMA_PATH"] ?? join(defaultConfigDir(), "bookmarks.schema.json");

export const defaultWorkspacePath = (): string =>
  process.env["BOOKMARKS_WORKSPACE_PATH"] ?? join(defaultStateDir(), "workspace.yaml");

export const defaultImportLockPath = (): string =>
  process.env["BOOKMARKS_IMPORT_LOCK_PATH"] ?? join(defaultStateDir(), "import.lock.json");

export const defaultPublishPlanPath = (): string =>
  process.env["BOOKMARKS_PUBLISH_PLAN_PATH"] ?? join(defaultStateDir(), "publish.plan.json");

export const defaultBackupDir = (): string =>
  process.env["BOOKMARKS_BACKUP_DIR"] ?? join(defaultStateDir(), "backups");

export const defaultRuntimeDir = (): string =>
  process.env["BOOKMARKS_RUNTIME_DIR"] ?? join(defaultStateDir(), "runtime");

export const defaultSyncLockPath = (): string => join(defaultRuntimeDir(), "sync.lock.json");

export const defaultSafariPlistPath = (): string =>
  process.env["BOOKMARKS_SAFARI_PLIST_PATH"] ?? join(homedir(), "Library/Safari/Bookmarks.plist");

export const defaultSafariTabsDbPath = (): string =>
  process.env["BOOKMARKS_SAFARI_TABS_DB_PATH"] ??
  join(homedir(), "Library/Containers/com.apple.Safari/Data/Library/Safari/SafariTabs.db");

export const defaultChromeDataDir = (): string =>
  process.env["BOOKMARKS_CHROME_DATA_DIR"] ??
  join(homedir(), "Library/Application Support/Google/Chrome");

export const defaultChromeBookmarksPath = (): string =>
  process.env["BOOKMARKS_CHROME_BOOKMARKS_PATH"] ??
  join(defaultChromeDataDir(), "Default", "Bookmarks");
