import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { serialize } from "@plist/binary.serialize";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyManagedConfigHeader,
  DEFAULT_DAEMON_HEADER_STATE,
  readDaemonHeaderState,
} from "../lib/managed-config-header.ts";
import { copyChromeBookmarksFixture } from "../lib/test-fixtures.ts";
import {
  BookmarkFolder,
  BookmarkLeaf,
  BookmarksConfig,
  BookmarkTree,
  ChromeBookmarks,
  ChromeProfileBookmarks,
  ReadingListItem,
  TargetState,
  SharedBookmarks,
} from "../lib/schema/__.ts";
import * as Baseline from "../lib/baseline.ts";
import * as YamlModule from "../lib/yaml.ts";

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);
const bunBinary = Bun.which("bun") ?? process.execPath;

const runCommand = async (
  cwd: string,
  command: readonly string[],
  env?: Record<string, string>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn([...command], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
};

const runGit = async (cwd: string, ...args: string[]) => {
  const result = await runCommand(cwd, ["git", ...args]);
  expect(result.exitCode).toBe(0);
  return result;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseJsonObject = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("Expected CLI JSON output to be an object");
  }
  return parsed;
};

const expectDefined = <T>(value: T | undefined, message: string): T => {
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
};

const expectPresent = <T>(value: T | null | undefined, message: string): T => {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
};

const withCliEnv = (dir: string, env: Record<string, string>): Record<string, string> => ({
  ...env,
  BOOKMARKS_SYNC_BASELINE_PATH: join(dir, "state", "sync-baseline.yaml"),
});

const readObject = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected "${key}" to be an object`);
  }
  return value;
};

const readNullableObject = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null => {
  const value = record[key];
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error(`Expected "${key}" to be an object or null`);
  }
  return value;
};

const readOptionalNullableObject = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null | undefined => {
  const value = record[key];
  if (value === undefined || value === null) return value;
  if (!isRecord(value)) {
    throw new Error(`Expected "${key}" to be an object, null, or undefined`);
  }
  return value;
};

const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Expected "${key}" to be a string`);
  }
  return value;
};

const readBoolean = (record: Record<string, unknown>, key: string): boolean => {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`Expected "${key}" to be a boolean`);
  }
  return value;
};

const readArray = (record: Record<string, unknown>, key: string): readonly unknown[] => {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`Expected "${key}" to be an array`);
  }
  return value;
};

const readStringArray = (record: Record<string, unknown>, key: string): readonly string[] => {
  const value = readArray(record, key);
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new Error(`Expected "${key}" to contain only strings`);
    }
    return item;
  });
};

const readFirstObject = (items: readonly unknown[], label: string): Record<string, unknown> => {
  const first = expectDefined(items[0], `Expected ${label}[0]`);
  if (!isRecord(first)) {
    throw new Error(`Expected ${label}[0] to be an object`);
  }
  return first;
};

const writeChromeBookmarks = async (
  path: string,
  title = "Top Link",
  url = "https://top.example/",
): Promise<void> => {
  await Bun.write(
    path,
    JSON.stringify(
      {
        checksum: "",
        version: 1,
        roots: {
          bookmark_bar: {
            type: "folder",
            name: "Bookmarks Bar",
            id: "1",
            guid: "root-bookmark-bar",
            date_added: "0",
            date_modified: "0",
            children: [
              {
                type: "url",
                name: title,
                url,
                id: "2",
                guid: "top-link",
                date_added: "0",
                date_last_used: "0",
              },
            ],
          },
          other: {
            type: "folder",
            name: "Other Bookmarks",
            id: "3",
            guid: "root-other",
            date_added: "0",
            date_modified: "0",
            children: [],
          },
          synced: {
            type: "folder",
            name: "Mobile Bookmarks",
            id: "4",
            guid: "root-synced",
            date_added: "0",
            date_modified: "0",
            children: [],
          },
        },
      },
      null,
      2,
    ),
  );
};

const writeChromeDataDir = async (
  chromeDataDir: string,
  profiles: readonly { readonly directory: string; readonly title: string; readonly url: string }[],
): Promise<void> => {
  await mkdir(chromeDataDir, { recursive: true });
  await Bun.write(
    join(chromeDataDir, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: Object.fromEntries(profiles.map((profile) => [profile.directory, {}])),
      },
    }),
  );

  await Promise.all(
    profiles.map(async (profile) => {
      const bookmarksPath = join(chromeDataDir, profile.directory, "Bookmarks");
      await mkdir(join(chromeDataDir, profile.directory), { recursive: true });
      await writeChromeBookmarks(bookmarksPath, profile.title, profile.url);
    }),
  );
};

describe("bookmarks CLI", () => {
  test("status and sync --dry-run work against temp git repos and fixture browser files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-"));
    const yamlPath = join(dir, "bookmarks.yaml");
    const schemaPath = join(dir, "bookmarks.schema.json");
    const chromeDataDir = join(dir, "Chrome");
    const chromePath = join(chromeDataDir, "Default", "Bookmarks");
    const safariPath = join(dir, "Safari", "Bookmarks.plist");
    const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db");

    try {
      await mkdir(join(chromeDataDir, "Default"), { recursive: true });
      await copyChromeBookmarksFixture(chromePath);
      await Bun.write(
        join(chromeDataDir, "Local State"),
        JSON.stringify({
          profile: {
            info_cache: {
              Default: {},
            },
          },
        }),
      );

      const config = BookmarksConfig.make({
        all: new BookmarkTree({
          bar: [new BookmarkLeaf({ name: "Docs", url: "https://docs.example/" })],
        }),
        chrome: ChromeBookmarks.make({
          profiles: {
            default: ChromeProfileBookmarks.make({}),
          },
        }),
      });

      await run(YamlModule.save(yamlPath, config));

      await runGit(dir, "init", "-b", "main");
      await runGit(dir, "config", "user.name", "Bookmarks Test");
      await runGit(dir, "config", "user.email", "bookmarks-test@example.com");
      await runGit(dir, "add", "bookmarks.yaml");
      await runGit(dir, "commit", "-m", "baseline");

      const cliEnv = withCliEnv(dir, {
        BOOKMARKS_YAML_PATH: yamlPath,
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
        BOOKMARKS_SAFARI_TABS_DB_PATH: safariTabsDbPath,
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
        BOOKMARKS_FORCE_BROWSER_RUNNING: "",
      });
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts");

      const status = await runCommand(dir, [bunBinary, cliPath, "status"], cliEnv);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("chrome/default");
      expect(status.stdout).toContain("pending -> browser:");
      expect(status.stdout).toContain("pending -> yaml:");
      expect(status.stdout).toContain('Add "Top Link"');

      const statusJson = await runCommand(dir, [bunBinary, cliPath, "status", "--json"], cliEnv);
      expect(statusJson.exitCode).toBe(0);
      const parsedStatus = parseJsonObject(statusJson.stdout);
      expect(readString(parsedStatus, "yamlPath")).toBe(yamlPath);
      const firstStatusTarget = readFirstObject(readArray(parsedStatus, "targets"), "targets");
      expect(readString(readObject(firstStatusTarget, "target"), "browser")).toBe("chrome");
      expect(readArray(firstStatusTarget, "pendingToYaml").length).toBeGreaterThan(0);

      const sync = await runCommand(dir, [bunBinary, cliPath, "sync", "--dry-run"], cliEnv);
      expect(sync.exitCode).toBe(0);
      expect(sync.stdout).toContain("Sync complete");
      expect(sync.stdout).toContain("chrome/default");
      expect(sync.stdout).toContain('Add "Docs"');

      const syncJson = await runCommand(
        dir,
        [bunBinary, cliPath, "sync", "--dry-run", "--json"],
        cliEnv,
      );
      expect(syncJson.exitCode).toBe(0);
      const parsedSync = parseJsonObject(syncJson.stdout);
      expect(readString(parsedSync, "command")).toBe("sync");
      expect(readBoolean(parsedSync, "dryRun")).toBe(true);
      expect(readBoolean(parsedSync, "yamlChanged")).toBe(true);
      expect(readArray(parsedSync, "targets").length).toBeGreaterThan(0);

      const schema = await readFile(schemaPath, "utf-8");
      expect(schema).toContain('"$schema"');

      const yamlAfter = await readFile(yamlPath, "utf-8");
      expect(yamlAfter).toContain("https://docs.example/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sync --from-yaml previews and restores one exact target from YAML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-from-yaml-"));
    const yamlPath = join(dir, "bookmarks.yaml");
    const chromeDataDir = join(dir, "Chrome");
    const profilePath = join(chromeDataDir, "Profile 1", "Bookmarks");
    const defaultPath = join(chromeDataDir, "Default", "Bookmarks");
    const backupDir = join(dir, "backups");

    try {
      await writeChromeDataDir(chromeDataDir, [
        { directory: "Default", title: "Default", url: "https://default.example/" },
        { directory: "Profile 1", title: "Loose", url: "https://loose.example/" },
      ]);
      await run(
        YamlModule.save(
          yamlPath,
          BookmarksConfig.make({
            all: new BookmarkTree({
              bar: [
                new BookmarkFolder({
                  name: "Organized",
                  children: [
                    new BookmarkLeaf({ name: "Canonical", url: "https://canonical.example/" }),
                  ],
                }),
              ],
            }),
            chrome: ChromeBookmarks.make({
              profiles: {
                "profile-1": ChromeProfileBookmarks.make({}),
              },
            }),
          }),
        ),
      );

      const cliEnv = withCliEnv(dir, {
        BOOKMARKS_BACKUP_DIR: backupDir,
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
        BOOKMARKS_FORCE_BROWSER_RUNNING: "",
        BOOKMARKS_RUNTIME_DIR: join(dir, "runtime"),
        BOOKMARKS_SAFARI_PLIST_PATH: join(dir, "Safari", "Bookmarks.plist"),
        BOOKMARKS_SAFARI_TABS_DB_PATH: join(dir, "Safari", "SafariTabs.db"),
        BOOKMARKS_YAML_PATH: yamlPath,
      });
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts");
      const profileBefore = await readFile(profilePath, "utf-8");
      const defaultBefore = await readFile(defaultPath, "utf-8");

      const preview = await runCommand(
        dir,
        [bunBinary, cliPath, "sync", "--from-yaml", "chrome/profile-1", "--dry-run", "--json"],
        cliEnv,
      );
      expect(preview.exitCode).toBe(0);
      const parsedPreview = parseJsonObject(preview.stdout);
      expect(readString(parsedPreview, "mode")).toBe("from-yaml");
      const previewTarget = readFirstObject(readArray(parsedPreview, "targets"), "targets");
      expect(readString(readObject(previewTarget, "target"), "profile")).toBe("profile-1");
      expect(readArray(previewTarget, "applied").length).toBeGreaterThan(0);
      expect(await readFile(profilePath, "utf-8")).toBe(profileBefore);

      const restored = await runCommand(
        dir,
        [bunBinary, cliPath, "sync", "--from-yaml", "chrome/profile-1", "--json"],
        cliEnv,
      );
      expect(restored.exitCode).toBe(0);
      const parsedRestore = parseJsonObject(restored.stdout);
      expect(readString(parsedRestore, "mode")).toBe("from-yaml");
      expect(readNullableObject(parsedRestore, "backup")).not.toBeNull();
      const profileAfter = await readFile(profilePath, "utf-8");
      expect(profileAfter).toContain("Organized");
      expect(profileAfter).toContain("Canonical");
      expect(profileAfter).not.toContain("Loose");
      expect(await readFile(defaultPath, "utf-8")).toBe(defaultBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sync works outside git repos because git history is optional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-non-git-sync-"));
    const yamlPath = join(dir, "bookmarks.yaml");
    const chromeDataDir = join(dir, "Chrome");
    const chromePath = join(chromeDataDir, "Default", "Bookmarks");
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const safariPath = join(dir, "Safari", "Bookmarks.plist");
    const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db");

    try {
      await mkdir(join(chromeDataDir, "Default"), { recursive: true });
      await copyChromeBookmarksFixture(chromePath);
      await Bun.write(
        join(chromeDataDir, "Local State"),
        JSON.stringify({
          profile: {
            info_cache: {
              Default: {},
            },
          },
        }),
      );

      const cliEnv = withCliEnv(dir, {
        BOOKMARKS_YAML_PATH: yamlPath,
        BOOKMARKS_BACKUP_DIR: backupDir,
        BOOKMARKS_RUNTIME_DIR: runtimeDir,
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
        BOOKMARKS_SAFARI_TABS_DB_PATH: safariTabsDbPath,
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
        BOOKMARKS_FORCE_BROWSER_RUNNING: "",
      });
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts");

      const syncJson = await runCommand(dir, [bunBinary, cliPath, "sync", "--json"], cliEnv);
      expect(syncJson.exitCode).toBe(0);

      const parsedSync = parseJsonObject(syncJson.stdout);
      expect(readString(parsedSync, "command")).toBe("sync");
      const backup = expectPresent(readNullableObject(parsedSync, "backup"), "Expected backup");
      expect(readStringArray(backup, "files")).toHaveLength(1);
      expect(readStringArray(backup, "skipped")).toEqual(["yaml", "sync baselines"]);

      const yamlAfter = await readFile(yamlPath, "utf-8");
      expect(yamlAfter).toContain("Top Link");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sync --json merges an open browser into the YAML and leaves its file until it closes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-sync-"));
    const yamlPath = join(dir, "bookmarks.yaml");
    const chromeDataDir = join(dir, "Chrome");
    const chromePath = join(chromeDataDir, "Default", "Bookmarks");
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const safariPath = join(dir, "Safari", "Bookmarks.plist");
    const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db");

    try {
      await mkdir(join(chromeDataDir, "Default"), { recursive: true });
      await copyChromeBookmarksFixture(chromePath);
      await Bun.write(
        join(chromeDataDir, "Local State"),
        JSON.stringify({
          profile: {
            info_cache: {
              Default: {},
            },
          },
        }),
      );

      const config = BookmarksConfig.make({
        all: new BookmarkTree({
          menu: [new BookmarkLeaf({ name: "From YAML", url: "https://from-yaml.example/" })],
        }),
        chrome: ChromeBookmarks.make({
          profiles: {
            default: ChromeProfileBookmarks.make({}),
          },
        }),
      });

      await run(YamlModule.save(yamlPath, config));

      await runGit(dir, "init", "-b", "main");
      await runGit(dir, "config", "user.name", "Bookmarks Test");
      await runGit(dir, "config", "user.email", "bookmarks-test@example.com");
      await runGit(dir, "add", "bookmarks.yaml");
      await runGit(dir, "commit", "-m", "baseline");

      const cliEnv = withCliEnv(dir, {
        BOOKMARKS_YAML_PATH: yamlPath,
        BOOKMARKS_BACKUP_DIR: backupDir,
        BOOKMARKS_RUNTIME_DIR: runtimeDir,
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
        BOOKMARKS_SAFARI_TABS_DB_PATH: safariTabsDbPath,
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
        BOOKMARKS_FORCE_BROWSER_RUNNING: "Google Chrome",
      });
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts");

      const yamlBefore = await readFile(yamlPath, "utf-8");
      const chromeBefore = await readFile(chromePath, "utf-8");
      const openJson = await runCommand(dir, [bunBinary, cliPath, "sync", "--json"], cliEnv);
      expect(openJson.exitCode).toBe(0);
      const open = parseJsonObject(openJson.stdout);
      expect(readOptionalNullableObject(open, "orchestration")).toBeNull();
      expect(JSON.stringify(open["waiting"])).toContain('"browser":"Google Chrome"');
      const openBackup = expectPresent(readNullableObject(open, "backup"), "Expected backup");
      expect(readString(openBackup, "backupDir")).toBe(backupDir);
      expect(readStringArray(openBackup, "files")).toHaveLength(2);
      // The open browser's bookmarks reach the YAML; its own file is left for later.
      const yamlAfter = await readFile(yamlPath, "utf-8");
      expect(yamlAfter).not.toBe(yamlBefore);
      expect(yamlAfter).toContain("Top Link");
      expect(await readFile(chromePath, "utf-8")).toBe(chromeBefore);

      const closedJson = await runCommand(dir, [bunBinary, cliPath, "sync", "--json"], {
        ...cliEnv,
        BOOKMARKS_FORCE_BROWSER_RUNNING: "",
      });
      expect(closedJson.exitCode).toBe(0);
      const closed = parseJsonObject(closedJson.stdout);
      expect(readOptionalNullableObject(closed, "orchestration")).toBeNull();
      expect(closed["waiting"]).toEqual([]);
      expect(readNullableObject(closed, "backup")).not.toBeNull();
      expect(await readFile(yamlPath, "utf-8")).toBe(yamlAfter);
      expect(await readFile(chromePath, "utf-8")).toContain("https://from-yaml.example/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sync fails clearly when browser state is not safely representable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-sync-fallback-"));
    const yamlPath = join(dir, "bookmarks.yaml");
    const chromeDataDir = join(dir, "Chrome");
    const chromePath = join(chromeDataDir, "Default", "Bookmarks");
    const safariPath = join(dir, "Safari", "Bookmarks.plist");
    const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db");

    try {
      await mkdir(join(chromeDataDir, "Default"), { recursive: true });
      await Bun.write(
        chromePath,
        JSON.stringify(
          {
            checksum: "",
            version: 1,
            roots: {
              bookmark_bar: {
                type: "folder",
                name: "Bookmarks Bar",
                id: "1",
                guid: "root-bookmark-bar",
                date_added: "0",
                date_modified: "0",
                children: [
                  {
                    type: "separator",
                    name: "",
                    id: "2",
                    guid: "separator",
                    date_added: "0",
                    date_modified: "0",
                  },
                ],
              },
              other: {
                type: "folder",
                name: "Other Bookmarks",
                id: "3",
                guid: "root-other",
                date_added: "0",
                date_modified: "0",
                children: [],
              },
              synced: {
                type: "folder",
                name: "Mobile Bookmarks",
                id: "4",
                guid: "root-synced",
                date_added: "0",
                date_modified: "0",
                children: [],
              },
            },
          },
          null,
          2,
        ),
      );
      await Bun.write(
        join(chromeDataDir, "Local State"),
        JSON.stringify({
          profile: {
            info_cache: {
              Default: {},
            },
          },
        }),
      );

      await run(
        YamlModule.save(
          yamlPath,
          BookmarksConfig.make({
            all: new BookmarkTree({}),
            chrome: ChromeBookmarks.make({
              profiles: {
                default: ChromeProfileBookmarks.make({}),
              },
            }),
          }),
        ),
      );

      await runGit(dir, "init", "-b", "main");
      await runGit(dir, "config", "user.name", "Bookmarks Test");
      await runGit(dir, "config", "user.email", "bookmarks-test@example.com");
      await runGit(dir, "add", "bookmarks.yaml");
      await runGit(dir, "commit", "-m", "baseline");

      const cliEnv = withCliEnv(dir, {
        BOOKMARKS_YAML_PATH: yamlPath,
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
        BOOKMARKS_SAFARI_TABS_DB_PATH: safariTabsDbPath,
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
        BOOKMARKS_FORCE_BROWSER_RUNNING: "",
      });
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts");

      const syncJson = await runCommand(dir, [bunBinary, cliPath, "sync", "--json"], cliEnv);
      expect(syncJson.exitCode).toBe(1);

      const parsedSync = parseJsonObject(syncJson.stderr);
      expect(readString(parsedSync, "error")).toContain("Bookmark separators are not supported");
      expect(readString(parsedSync, "type")).toBe("UnsupportedBookmarks");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removed workflow commands fail clearly as unknown commands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-removed-workflow-"));
    try {
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts");

      const results = await Promise.all(
        ["import", "plan", "publish", "next", "push", "pull"].map(async (command) => ({
          command,
          result: await runCommand(dir, [bunBinary, cliPath, command, "--json"]),
        })),
      );

      for (const { command, result } of results) {
        expect(result.exitCode).toBe(1);
        const parsed = parseJsonObject(result.stdout || result.stderr);
        expect(readString(parsed, "error")).toContain(`Unknown command: ${command}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validate only validates bookmarks.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-validate-"));
    const yamlPath = join(dir, "bookmarks.yaml");

    try {
      const config = BookmarksConfig.make({
        all: new BookmarkTree({}),
      });
      await run(YamlModule.save(yamlPath, config));

      const cliEnv = withCliEnv(dir, {
        BOOKMARKS_YAML_PATH: yamlPath,
      });
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts");

      const validated = await runCommand(dir, [bunBinary, cliPath, "validate", "--json"], cliEnv);
      expect(validated.exitCode).toBe(0);
      const parsedValidation = parseJsonObject(validated.stdout);
      expect(readBoolean(parsedValidation, "valid")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("status discovers all profiles and exact profile typos fail clearly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-targets-"));
    const yamlPath = join(dir, "bookmarks.yaml");
    const chromeDataDir = join(dir, "Chrome");
    const safariPath = join(dir, "Safari", "Bookmarks.plist");
    const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db");

    try {
      await writeChromeDataDir(chromeDataDir, [
        { directory: "Default", title: "Top Link", url: "https://top.example/" },
        { directory: "Profile 1", title: "Work Link", url: "https://work.example/" },
      ]);

      const config = BookmarksConfig.make({
        all: new BookmarkTree({}),
        chrome: ChromeBookmarks.make({
          profiles: {
            default: ChromeProfileBookmarks.make({}),
          },
        }),
      });

      await run(YamlModule.save(yamlPath, config));

      const cliEnv = withCliEnv(dir, {
        BOOKMARKS_YAML_PATH: yamlPath,
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
        BOOKMARKS_SAFARI_TABS_DB_PATH: safariTabsDbPath,
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
        BOOKMARKS_FORCE_BROWSER_RUNNING: "",
      });
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts");

      const status = await runCommand(dir, [bunBinary, cliPath, "status", "--json"], cliEnv);
      expect(status.exitCode).toBe(0);
      const parsedStatus = parseJsonObject(status.stdout);
      const targets = readArray(parsedStatus, "targets").map((item) => {
        if (!isRecord(item)) {
          throw new Error("Expected status target entry to be an object");
        }
        const target = readObject(item, "target");
        const browser = readString(target, "browser");
        const profile = target["profile"];
        return typeof profile === "string" ? `${browser}/${profile}` : browser;
      });
      expect(targets).toEqual(["chrome/default", "chrome/profile-1"]);

      const typo = await runCommand(
        dir,
        [bunBinary, cliPath, "status", "chrome/defualt", "--json"],
        cliEnv,
      );
      expect(typo.exitCode).toBe(1);
      const parsedTypo = parseJsonObject(typo.stderr);
      expect(readString(parsedTypo, "error")).toContain('Unknown target selector "chrome/defualt"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("status succeeds when Safari profiles share one favorites scope because Safari bookmarks are shared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-safari-targets-"));
    const safariPath = join(dir, "Safari", "Bookmarks.plist");
    const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db");

    try {
      await mkdir(join(dir, "Safari"), { recursive: true });
      await Bun.write(safariPath, serialize({ Children: [] }));

      const db = new Database(safariTabsDbPath);
      try {
        db.run(
          "create table bookmarks (id integer primary key, parent integer, type integer, subtype integer, title text, external_uuid text, extra_attributes blob)",
        );
        db.run(
          "insert into bookmarks (id, parent, type, subtype, title, external_uuid, extra_attributes) values (?, ?, ?, ?, ?, ?, ?)",
          [
            35,
            0,
            1,
            2,
            null,
            "DefaultProfile",
            Buffer.from(
              serialize({
                "com.apple.Bookmark": { DateAdded: new Date("2026-03-06T00:00:00.000Z") },
              }),
            ),
          ],
        );
        db.run(
          "insert into bookmarks (id, parent, type, subtype, title, external_uuid, extra_attributes) values (?, ?, ?, ?, ?, ?, ?)",
          [
            201,
            0,
            1,
            2,
            "Heartbeat",
            "FB6E52DB-8796-4D8F-88E2-7EB82D9D0FD5",
            Buffer.from(
              serialize({
                CustomFavoritesFolderServerID: "Favorites Bar",
                "com.apple.Bookmark": { DateAdded: new Date("2026-03-06T00:00:00.000Z") },
              }),
            ),
          ],
        );
      } finally {
        db.close();
      }

      const cliEnv = withCliEnv(dir, {
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
        BOOKMARKS_SAFARI_TABS_DB_PATH: safariTabsDbPath,
        BOOKMARKS_CHROME_DATA_DIR: join(dir, "Chrome"),
        BOOKMARKS_FORCE_BROWSER_RUNNING: "",
      });
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts");

      const status = await runCommand(dir, [bunBinary, cliPath, "status", "--json"], cliEnv);
      expect(status.exitCode).toBe(0);
      const parsedStatus = parseJsonObject(status.stdout);
      const targets = readArray(parsedStatus, "targets");
      expect(targets).toHaveLength(1);
      const firstTarget = readObject(readFirstObject(targets, "targets"), "target");
      expect(readString(firstTarget, "browser")).toBe("safari");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("daemon status reconciles the managed header from observed runtime state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-daemon-status-"));
    const homeDir = join(dir, "home");
    const binDir = join(dir, "bin");
    const yamlPath = join(dir, "bookmarks.yaml");
    const runtimeDir = join(dir, "runtime");
    const launchctlStatePath = join(dir, "launchctl.state");
    const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts");

    try {
      await mkdir(homeDir, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await mkdir(runtimeDir, { recursive: true });

      await writeFile(
        join(binDir, "launchctl"),
        `#!/bin/sh
case "$1" in
  list)
    if [ -f '${launchctlStatePath}' ]; then
      printf '%s\n' 'loaded'
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`,
        { encoding: "utf-8", mode: 0o755 },
      );
      await writeFile(launchctlStatePath, "loaded\n", "utf-8");
      await writeFile(
        join(runtimeDir, "daemon.state.json"),
        JSON.stringify(
          {
            pid: 12345,
            phase: "queued",
            startedAt: "2026-03-08T10:00:00.000Z",
            lastEventAt: "2026-03-08T10:01:00.000Z",
            nextSyncAt: "2026-03-08T10:03:00.000Z",
            lastOutcome: "success",
            yamlPath,
          },
          null,
          2,
        ),
        "utf-8",
      );
      await writeFile(
        yamlPath,
        applyManagedConfigHeader("version: 2\nall: {}\n", DEFAULT_DAEMON_HEADER_STATE),
        "utf-8",
      );

      const daemonStatus = await runCommand(
        dir,
        [bunBinary, cliPath, "daemon", "status", "--json"],
        {
          BOOKMARKS_RUNTIME_DIR: runtimeDir,
          BOOKMARKS_YAML_PATH: yamlPath,
          HOME: homeDir,
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
        },
      );

      expect(daemonStatus.exitCode).toBe(0);
      const parsedStatus = parseJsonObject(daemonStatus.stdout);
      expect(readBoolean(parsedStatus, "running")).toBe(true);
      expect(readString(parsedStatus, "phase")).toBe("queued");
      expect(readString(parsedStatus, "yamlPath")).toBe(yamlPath);
      expect(await readDaemonHeaderState(yamlPath)).toEqual({
        status: "running",
        phase: "queued",
        nextSyncAt: "2026-03-08T10:03:00.000Z",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("dry-run human and JSON output show the actual Reading List plan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-reading-list-"));
  const yamlPath = join(dir, "bookmarks.yaml");
  const safariPath = join(dir, "Safari", "Bookmarks.plist");
  const baselinePath = join(dir, "state", "sync-baseline.yaml");
  const article = (name: string, read: boolean, id: string) =>
    ReadingListItem.make({ name, read, url: `https://${id}.example/` });
  const observed = [
    article("B", false, "b"),
    article("C", false, "c"),
    article("D", true, "d"),
    article("E", false, "e"),
  ];
  const desired = [
    article("A", false, "a"),
    article("Renamed B", false, "b"),
    article("C", true, "c"),
    article("D", false, "d"),
  ];
  try {
    await mkdir(join(dir, "Safari"), { recursive: true });
    await Bun.write(
      safariPath,
      serialize({
        Children: [
          {
            WebBookmarkType: "WebBookmarkTypeList",
            Title: "com.apple.ReadingList",
            Children: observed.map((item) => ({
              WebBookmarkType: "WebBookmarkTypeLeaf",
              URLString: item.url,
              URIDictionary: { title: item.name },
              ReadingList: item.read ? { DateLastViewed: new Date("2026-01-01T00:00:00Z") } : {},
            })),
          },
        ],
      }),
    );
    const safariBefore = await Bun.file(safariPath).arrayBuffer();
    await run(
      YamlModule.save(
        yamlPath,
        BookmarksConfig.make({ all: SharedBookmarks.make({ reading_list: desired }) }),
      ),
    );
    await run(
      Baseline.save(
        { safari: TargetState.make({ tree: BookmarkTree.make({}), readingList: observed }) },
        baselinePath,
      ),
    );
    const env = withCliEnv(dir, {
      BOOKMARKS_CONFIG_DIR: join(dir, "config"),
      BOOKMARKS_RUNTIME_DIR: join(dir, "runtime"),
      BOOKMARKS_YAML_PATH: yamlPath,
      BOOKMARKS_SCHEMA_PATH: join(dir, "schema.json"),
      BOOKMARKS_CHROME_DATA_DIR: join(dir, "absent"),
      BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
    });
    const cli = join(import.meta.dir, "bookmarks.ts");
    const human = await runCommand(dir, [bunBinary, cli, "sync", "--dry-run"], env);
    expect(human.exitCode).toBe(0);
    for (const word of ["added", "removed", "renamed", "marked read", "marked unread"])
      expect(human.stdout).toContain(word);
    const json = await runCommand(dir, [bunBinary, cli, "sync", "--dry-run", "--json"], env);
    expect(json.exitCode).toBe(0);
    const result = parseJsonObject(json.stdout);
    const target = readFirstObject(readArray(result, "targets"), "targets");
    expect(
      readArray(target, "readingListChanges")
        .map((change) => readString(readObject({ change }, "change"), "tag"))
        .sort(),
    ).toEqual(["Added", "MarkedRead", "MarkedUnread", "Removed", "Renamed"]);
    expect(await Bun.file(safariPath).arrayBuffer()).toEqual(safariBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
