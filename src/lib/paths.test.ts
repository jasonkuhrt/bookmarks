import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Paths from "./paths.ts";

const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "BOOKMARKS_CONFIG_DIR",
  "BOOKMARKS_STATE_DIR",
  "BOOKMARKS_YAML_PATH",
  "BOOKMARKS_SCHEMA_PATH",
  "BOOKMARKS_SYNC_BASELINE_PATH",
  "BOOKMARKS_BACKUP_DIR",
  "BOOKMARKS_RUNTIME_DIR",
  "BOOKMARKS_SAFARI_PLIST_PATH",
  "BOOKMARKS_SAFARI_TABS_DB_PATH",
  "BOOKMARKS_CHROME_DATA_DIR",
  "BOOKMARKS_CHROME_BOOKMARKS_PATH",
] as const;

const ORIGINAL_ENV: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
  XDG_STATE_HOME: process.env["XDG_STATE_HOME"],
  BOOKMARKS_CONFIG_DIR: process.env["BOOKMARKS_CONFIG_DIR"],
  BOOKMARKS_STATE_DIR: process.env["BOOKMARKS_STATE_DIR"],
  BOOKMARKS_YAML_PATH: process.env["BOOKMARKS_YAML_PATH"],
  BOOKMARKS_SCHEMA_PATH: process.env["BOOKMARKS_SCHEMA_PATH"],
  BOOKMARKS_SYNC_BASELINE_PATH: process.env["BOOKMARKS_SYNC_BASELINE_PATH"],
  BOOKMARKS_BACKUP_DIR: process.env["BOOKMARKS_BACKUP_DIR"],
  BOOKMARKS_RUNTIME_DIR: process.env["BOOKMARKS_RUNTIME_DIR"],
  BOOKMARKS_SAFARI_PLIST_PATH: process.env["BOOKMARKS_SAFARI_PLIST_PATH"],
  BOOKMARKS_SAFARI_TABS_DB_PATH: process.env["BOOKMARKS_SAFARI_TABS_DB_PATH"],
  BOOKMARKS_CHROME_DATA_DIR: process.env["BOOKMARKS_CHROME_DATA_DIR"],
  BOOKMARKS_CHROME_BOOKMARKS_PATH: process.env["BOOKMARKS_CHROME_BOOKMARKS_PATH"],
};

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("paths", () => {
  test("defaults to XDG config and state directories", () => {
    for (const key of ENV_KEYS) delete process.env[key];

    expect(Paths.defaultConfigDir()).toBe(join(homedir(), ".config", "bookmarks"));
    expect(Paths.defaultStateDir()).toBe(join(homedir(), ".local", "state", "bookmarks"));
    expect(Paths.defaultYamlPath()).toBe(join(homedir(), ".config", "bookmarks", "bookmarks.yaml"));
    expect(Paths.defaultSchemaPath()).toBe(
      join(homedir(), ".config", "bookmarks", "bookmarks.schema.json"),
    );
    expect(Paths.defaultSyncBaselinePath()).toBe(
      join(homedir(), ".local", "state", "bookmarks", "sync-baseline.yaml"),
    );
    expect(Paths.defaultBackupDir()).toBe(
      join(homedir(), ".local", "state", "bookmarks", "backups"),
    );
    expect(Paths.defaultRuntimeDir()).toBe(
      join(homedir(), ".local", "state", "bookmarks", "runtime"),
    );
    expect(Paths.defaultSyncLockPath()).toBe(
      join(homedir(), ".local", "state", "bookmarks", "runtime", "sync.lock.json"),
    );
    expect(Paths.defaultSafariPlistPath()).toBe(join(homedir(), "Library/Safari/Bookmarks.plist"));
    expect(Paths.defaultSafariTabsDbPath()).toBe(
      join(homedir(), "Library/Containers/com.apple.Safari/Data/Library/Safari/SafariTabs.db"),
    );
    expect(Paths.defaultChromeDataDir()).toBe(
      join(homedir(), "Library/Application Support/Google/Chrome"),
    );
    expect(Paths.defaultChromeBookmarksPath()).toBe(
      join(homedir(), "Library/Application Support/Google/Chrome", "Default", "Bookmarks"),
    );
  });

  test("config and state dir env vars override derived paths", () => {
    process.env["BOOKMARKS_CONFIG_DIR"] = "/tmp/bookmarks-config";
    process.env["BOOKMARKS_STATE_DIR"] = "/tmp/bookmarks-state";

    expect(Paths.defaultConfigDir()).toBe("/tmp/bookmarks-config");
    expect(Paths.defaultStateDir()).toBe("/tmp/bookmarks-state");
    expect(Paths.defaultYamlPath()).toBe("/tmp/bookmarks-config/bookmarks.yaml");
    expect(Paths.defaultSchemaPath()).toBe("/tmp/bookmarks-config/bookmarks.schema.json");
    expect(Paths.defaultSyncBaselinePath()).toBe("/tmp/bookmarks-state/sync-baseline.yaml");
    expect(Paths.defaultBackupDir()).toBe("/tmp/bookmarks-state/backups");
    expect(Paths.defaultRuntimeDir()).toBe("/tmp/bookmarks-state/runtime");
    expect(Paths.defaultSyncLockPath()).toBe("/tmp/bookmarks-state/runtime/sync.lock.json");
  });

  test("XDG home env vars feed the default bookmarks directories", () => {
    process.env["XDG_CONFIG_HOME"] = "/tmp/xdg-config";
    process.env["XDG_STATE_HOME"] = "/tmp/xdg-state";

    expect(Paths.defaultConfigDir()).toBe("/tmp/xdg-config/bookmarks");
    expect(Paths.defaultStateDir()).toBe("/tmp/xdg-state/bookmarks");
  });

  test("file-specific env vars override derived paths", () => {
    process.env["BOOKMARKS_YAML_PATH"] = "/tmp/custom.yaml";
    process.env["BOOKMARKS_SCHEMA_PATH"] = "/tmp/custom.schema.json";
    process.env["BOOKMARKS_SYNC_BASELINE_PATH"] = "/tmp/sync-baseline.yaml";
    process.env["BOOKMARKS_BACKUP_DIR"] = "/tmp/custom-backups";
    process.env["BOOKMARKS_RUNTIME_DIR"] = "/tmp/custom-runtime";
    process.env["BOOKMARKS_SAFARI_PLIST_PATH"] = "/tmp/Safari/Bookmarks.plist";
    process.env["BOOKMARKS_SAFARI_TABS_DB_PATH"] = "/tmp/Safari/SafariTabs.db";
    process.env["BOOKMARKS_CHROME_DATA_DIR"] = "/tmp/Chrome";
    process.env["BOOKMARKS_CHROME_BOOKMARKS_PATH"] = "/tmp/Chrome/Profile 7/Bookmarks";

    expect(Paths.defaultYamlPath()).toBe("/tmp/custom.yaml");
    expect(Paths.defaultSchemaPath()).toBe("/tmp/custom.schema.json");
    expect(Paths.defaultSyncBaselinePath()).toBe("/tmp/sync-baseline.yaml");
    expect(Paths.defaultBackupDir()).toBe("/tmp/custom-backups");
    expect(Paths.defaultRuntimeDir()).toBe("/tmp/custom-runtime");
    expect(Paths.defaultSyncLockPath()).toBe("/tmp/custom-runtime/sync.lock.json");
    expect(Paths.defaultSafariPlistPath()).toBe("/tmp/Safari/Bookmarks.plist");
    expect(Paths.defaultSafariTabsDbPath()).toBe("/tmp/Safari/SafariTabs.db");
    expect(Paths.defaultChromeDataDir()).toBe("/tmp/Chrome");
    expect(Paths.defaultChromeBookmarksPath()).toBe("/tmp/Chrome/Profile 7/Bookmarks");
  });
});
