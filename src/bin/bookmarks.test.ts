import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { serialize } from "@plist/binary.serialize";
import { Effect } from "effect";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyChromeBookmarksFixture } from "../lib/test-fixtures.ts";
import {
  BookmarkLeaf,
  BookmarksConfig,
  BookmarkTree,
  ChromeBookmarks,
  ChromeProfileBookmarks,
} from "../lib/schema/__.ts";
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
  url = "https://top.example",
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
          bar: [new BookmarkLeaf({ name: "Docs", url: "https://docs.example" })],
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
      expect(sync.stdout).toContain('Add "Top Link"');

      const syncJson = await runCommand(
        dir,
        [bunBinary, cliPath, "sync", "--dry-run", "--json"],
        cliEnv,
      );
      expect(syncJson.exitCode).toBe(0);
      const parsedSync = parseJsonObject(syncJson.stdout);
      expect(readString(parsedSync, "command")).toBe("sync");
      expect(readBoolean(parsedSync, "dryRun")).toBe(true);
      const preview = expectPresent(readNullableObject(parsedSync, "preview"), "Expected preview");
      const firstPreviewTarget = readFirstObject(readArray(preview, "targets"), "preview.targets");
      expect(readArray(firstPreviewTarget, "pendingToYaml").length).toBeGreaterThan(0);

      const schema = await readFile(schemaPath, "utf-8");
      expect(schema).toContain('"$schema"');

      const yamlAfter = await readFile(yamlPath, "utf-8");
      expect(yamlAfter).toContain("https://docs.example");
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
      expect(readStringArray(backup, "skipped")).toEqual(["yaml"]);

      const yamlAfter = await readFile(yamlPath, "utf-8");
      expect(yamlAfter).toContain("Top Link");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sync --json performs live sync with backups even when browsers are open", async () => {
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
        all: new BookmarkTree({}),
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

      const syncJson = await runCommand(dir, [bunBinary, cliPath, "sync", "--json"], cliEnv);
      expect(syncJson.exitCode).toBe(0);

      const parsedSync = parseJsonObject(syncJson.stdout);
      expect(readOptionalNullableObject(parsedSync, "orchestration")).toBeNull();
      const backup = expectPresent(readNullableObject(parsedSync, "backup"), "Expected backup");
      expect(readString(backup, "backupDir")).toBe(backupDir);
      expect(readStringArray(backup, "files")).toHaveLength(2);
      expect(readStringArray(backup, "skipped")).toHaveLength(0);

      const yamlAfter = await readFile(yamlPath, "utf-8");
      expect(yamlAfter).toContain("Top Link");
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
        { directory: "Default", title: "Top Link", url: "https://top.example" },
        { directory: "Profile 1", title: "Work Link", url: "https://work.example" },
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
});
