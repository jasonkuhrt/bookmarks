import { TargetState } from "./schema/__.ts";
import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Schema } from "effect";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Baseline from "./baseline.ts";
import * as Chrome from "./chrome.ts";
import { NativeRequestSchema } from "./chrome-native-protocol.ts";
import { ChromeBridgeRuntime } from "./chrome-native-runtime.ts";
import {
  BookmarkFolder,
  BookmarkLeaf,
  type BookmarkNode,
  BookmarksConfig,
  BookmarkTree,
  ChromeBookmarks,
  ChromeProfileBookmarks,
  SafariBookmarks,
} from "./schema/__.ts";
import * as Patch from "./patch.ts";
import * as Sync from "./sync.ts";
import * as YamlModule from "./yaml.ts";

// -- Test helpers --

const leaf = (name: string, url: string) => new BookmarkLeaf({ name, url });
const folder = (name: string, children: Array<BookmarkLeaf | BookmarkFolder>) =>
  new BookmarkFolder({ name, children });

const emptyTree = () => new BookmarkTree({});

type SafariInput = {
  readonly enabled?: boolean;
  readonly bar?: readonly BookmarkNode[];
  readonly menu?: readonly BookmarkNode[];
  readonly reading_list?: readonly BookmarkNode[];
};
type ChromeProfileInput = {
  readonly enabled?: boolean;
  readonly bar?: readonly BookmarkNode[];
  readonly menu?: readonly BookmarkNode[];
  readonly mobile?: readonly BookmarkNode[];
};
type ChromeInput = {
  readonly enabled?: boolean;
  readonly bar?: readonly BookmarkNode[];
  readonly menu?: readonly BookmarkNode[];
  readonly mobile?: readonly BookmarkNode[];
  readonly profiles?: Readonly<Record<string, ChromeProfileInput>>;
};

const makeConfig = (
  options: {
    readonly all?: BookmarkTree;
    readonly safari?: SafariInput;
    readonly chrome?: ChromeInput;
  } = {},
): BookmarksConfig =>
  BookmarksConfig.make({
    all: options.all ?? new BookmarkTree({}),
    ...(options.safari ? { safari: SafariBookmarks.make(options.safari) } : {}),
    ...(options.chrome
      ? {
          chrome: ChromeBookmarks.make({
            ...options.chrome,
            ...(options.chrome.profiles
              ? {
                  profiles: Object.fromEntries(
                    Object.entries(options.chrome.profiles).map(([profile, profileConfig]) => [
                      profile,
                      ChromeProfileBookmarks.make(profileConfig),
                    ]),
                  ),
                }
              : {}),
          }),
        }
      : {}),
  });

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const makeDate = (iso: string): DateTime.Utc => DateTime.unsafeMake(iso);

const expectDefined = <T>(value: T | undefined, message: string): T => {
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
};

const expectSection = (
  value: readonly BookmarkNode[] | undefined,
  message: string,
): readonly BookmarkNode[] => expectDefined(value, message);

const expectLeaf = (value: BookmarkNode | undefined, message: string): BookmarkLeaf => {
  const node = expectDefined(value, message);
  expect(BookmarkLeaf.is(node)).toBe(true);
  if (!BookmarkLeaf.is(node)) {
    throw new Error(message);
  }
  return node;
};

const expectFolder = (value: BookmarkNode | undefined, message: string): BookmarkFolder => {
  const node = expectDefined(value, message);
  expect(BookmarkFolder.is(node)).toBe(true);
  if (!BookmarkFolder.is(node)) {
    throw new Error(message);
  }
  return node;
};

const expectRejects = async (promise: Promise<unknown>, message: string): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected rejection containing "${message}"`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error(`Expected Error, received ${String(error)}`, { cause: error });
    }
    expect(error.message).toContain(message);
  }
};

const runGit = async (cwd: string, ...args: string[]): Promise<void> => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode === 0) return;
  throw new Error(await new Response(proc.stderr).text());
};

const writeChromeFixture = async (path: string, names: readonly string[]) => {
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
            guid: "bookmark-bar",
            date_added: "0",
            date_modified: "0",
            children: names.map((name, index) => ({
              type: "url" as const,
              name,
              url: `https://${name.toLowerCase()}.example/`,
              id: String(index + 2),
              guid: `guid-${index + 2}`,
              date_added: "0",
              date_last_used: "0",
            })),
          },
          other: {
            type: "folder",
            name: "Other Bookmarks",
            id: "10",
            guid: "other",
            date_added: "0",
            date_modified: "0",
            children: [],
          },
          synced: {
            type: "folder",
            name: "Mobile Bookmarks",
            id: "11",
            guid: "mobile",
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

const writeAmbiguousChromeFolderFixture = async (path: string) => {
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
            guid: "bookmark-bar",
            date_added: "0",
            date_modified: "0",
            children: [
              {
                type: "folder",
                name: "Imported",
                id: "2",
                guid: "imported-a",
                date_added: "0",
                date_modified: "0",
                children: [
                  {
                    type: "url",
                    name: "Heartbeat",
                    url: "https://heartbeat.example/",
                    id: "3",
                    guid: "heartbeat",
                    date_added: "0",
                    date_last_used: "0",
                  },
                ],
              },
              {
                type: "folder",
                name: "Imported",
                id: "4",
                guid: "imported-b",
                date_added: "0",
                date_modified: "0",
                children: [
                  {
                    type: "url",
                    name: "Effect",
                    url: "https://effect.example/",
                    id: "5",
                    guid: "effect",
                    date_added: "0",
                    date_last_used: "0",
                  },
                ],
              },
            ],
          },
          other: {
            type: "folder",
            name: "Other Bookmarks",
            id: "10",
            guid: "other",
            date_added: "0",
            date_modified: "0",
            children: [],
          },
          synced: {
            type: "folder",
            name: "Mobile Bookmarks",
            id: "11",
            guid: "mobile",
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

const addChromeSyncMetadata = async (path: string): Promise<void> => {
  const value: unknown = JSON.parse(await Bun.file(path).text());
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected Chrome bookmark file at ${path}`);
  }
  Object.assign(value, { sync_metadata: "opaque-sync-state" });
  await Bun.write(path, JSON.stringify(value, null, 2));
};

const setupDiscoveryEnv = async (
  dir: string,
  profileDirectories: readonly string[] = ["Default"],
): Promise<{
  readonly chromeDataDir: string;
  readonly restore: () => void;
}> => {
  const chromeDataDir = join(dir, "Chrome");
  const syncBaselinePath = join(dir, "state", "sync-baselines.json");
  const originalChromeDataDir = process.env["BOOKMARKS_CHROME_DATA_DIR"];
  const originalSafariPlistPath = process.env["BOOKMARKS_SAFARI_PLIST_PATH"];
  const originalSafariTabsDbPath = process.env["BOOKMARKS_SAFARI_TABS_DB_PATH"];
  const originalSyncBaselinePath = process.env["BOOKMARKS_SYNC_BASELINE_PATH"];
  const originalForcedBrowserRunning = process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"];

  await mkdir(chromeDataDir, { recursive: true });
  await Bun.write(
    join(chromeDataDir, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: Object.fromEntries(profileDirectories.map((directory) => [directory, {}])),
      },
    }),
  );

  process.env["BOOKMARKS_CHROME_DATA_DIR"] = chromeDataDir;
  process.env["BOOKMARKS_SAFARI_PLIST_PATH"] = join(dir, "Safari", "Missing-Bookmarks.plist");
  process.env["BOOKMARKS_SAFARI_TABS_DB_PATH"] = join(dir, "Safari", "Missing-SafariTabs.db");
  process.env["BOOKMARKS_SYNC_BASELINE_PATH"] = syncBaselinePath;
  process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "";

  return {
    chromeDataDir,
    restore: () => {
      if (originalChromeDataDir === undefined) delete process.env["BOOKMARKS_CHROME_DATA_DIR"];
      else process.env["BOOKMARKS_CHROME_DATA_DIR"] = originalChromeDataDir;

      if (originalSafariPlistPath === undefined) delete process.env["BOOKMARKS_SAFARI_PLIST_PATH"];
      else process.env["BOOKMARKS_SAFARI_PLIST_PATH"] = originalSafariPlistPath;

      if (originalSafariTabsDbPath === undefined)
        delete process.env["BOOKMARKS_SAFARI_TABS_DB_PATH"];
      else process.env["BOOKMARKS_SAFARI_TABS_DB_PATH"] = originalSafariTabsDbPath;

      if (originalSyncBaselinePath === undefined) {
        delete process.env["BOOKMARKS_SYNC_BASELINE_PATH"];
      } else {
        process.env["BOOKMARKS_SYNC_BASELINE_PATH"] = originalSyncBaselinePath;
      }

      if (originalForcedBrowserRunning === undefined) {
        delete process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"];
      } else {
        process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = originalForcedBrowserRunning;
      }
    },
  };
};

// -- resolveConflicts --

describe("resolveConflicts", () => {
  test("non-overlapping patches: all applied, none graveyarded", async () => {
    const yamlPatches = [
      Patch.Add({ url: "https://a.com/", name: "A", path: "bar", date: makeDate("2025-01-01") }),
    ];
    const browserPatches = [
      Patch.Add({ url: "https://b.com/", name: "B", path: "bar", date: makeDate("2025-01-01") }),
    ];

    const result = await run(Sync.resolveConflicts(yamlPatches, browserPatches));
    expect(result.apply.length).toBe(2);
    expect(result.graveyard.length).toBe(0);
  });

  test("conflicting edits to one occurrence: newest wins", async () => {
    const older = makeDate("2025-01-01");
    const newer = makeDate("2025-06-01");

    const yamlPatches = [
      Patch.Update({
        url: "https://conflict.com/",
        oldName: "Original",
        newName: "YAML Version",
        fromPath: "bar",
        toPath: "bar",
        date: older,
      }),
    ];
    const browserPatches = [
      Patch.Update({
        url: "https://conflict.com/",
        oldName: "Original",
        newName: "Browser Version",
        fromPath: "bar",
        toPath: "menu",
        date: newer,
      }),
    ];

    const result = await run(Sync.resolveConflicts(yamlPatches, browserPatches));
    expect(result.apply.length).toBe(1);
    expect(result.graveyard.length).toBe(1);

    // Browser is newer → browser wins
    const applied = expectDefined(result.apply[0], "expected applied conflict winner");
    expect(Patch.$is("Update")(applied)).toBe(true);
    if (Patch.$is("Update")(applied)) {
      expect(applied.newName).toBe("Browser Version");
    }
    const graveyarded = expectDefined(result.graveyard[0], "expected graveyarded conflict loser");
    if (Patch.$is("Update")(graveyarded)) {
      expect(graveyarded.newName).toBe("YAML Version");
    }
  });

  test("tie-break: YAML wins when dates are equal", async () => {
    const sameDate = makeDate("2025-03-15");

    const yamlPatches = [
      Patch.Update({
        url: "https://tie.com/",
        oldName: "Original",
        newName: "YAML",
        fromPath: "bar",
        toPath: "bar",
        date: sameDate,
      }),
    ];
    const browserPatches = [
      Patch.Update({
        url: "https://tie.com/",
        oldName: "Original",
        newName: "Browser",
        fromPath: "bar",
        toPath: "menu",
        date: sameDate,
      }),
    ];

    const result = await run(Sync.resolveConflicts(yamlPatches, browserPatches));
    expect(result.apply.length).toBe(1);
    expect(result.graveyard.length).toBe(1);
    const applied = expectDefined(result.apply[0], "expected applied tie-break winner");
    if (Patch.$is("Update")(applied)) {
      expect(applied.newName).toBe("YAML");
    }
  });

  test("independent edits to two placements of one URL are both retained", async () => {
    const url = "https://duplicate.example/";
    const date = makeDate("2025-03-15");
    const yamlPatch = Patch.Update({
      url,
      oldName: "Folder A Copy",
      newName: "Renamed A",
      fromPath: "bar/Folder A",
      toPath: "bar/Folder A",
      date,
    });
    const browserPatch = Patch.Update({
      url,
      oldName: "Folder B Copy",
      newName: "Folder B Copy",
      fromPath: "bar/Folder B",
      toPath: "menu/Folder B",
      date,
    });

    const result = await run(Sync.resolveConflicts([yamlPatch], [browserPatch]));

    expect(result.apply).toEqual([yamlPatch, browserPatch]);
    expect(result.graveyard).toEqual([]);
  });

  test("remove and update of the same source occurrence produce one winner and one loser", async () => {
    const url = "https://same-source.example/";
    const remove = Patch.Remove({
      url,
      name: "Original",
      path: "bar/Folder",
      date: makeDate("2025-01-01"),
    });
    const update = Patch.Update({
      url,
      oldName: "Original",
      newName: "Renamed",
      fromPath: "bar/Folder",
      toPath: "menu/Folder",
      date: makeDate("2025-02-01"),
    });

    const result = await run(Sync.resolveConflicts([remove], [update]));

    expect(result.apply).toEqual([update]);
    expect(result.graveyard).toEqual([remove]);
  });

  test("identical additions from both sides coalesce without a graveyard entry", async () => {
    const yamlAdd = Patch.Add({
      url: "https://same-add.example/",
      name: "Same",
      path: "bar/Folder",
      date: makeDate("2025-01-01"),
    });
    const browserAdd = Patch.Add({
      url: "https://same-add.example/",
      name: "Same",
      path: "bar/Folder",
      date: makeDate("2025-02-01"),
    });

    const result = await run(Sync.resolveConflicts([yamlAdd], [browserAdd]));

    expect(result.apply).toEqual([yamlAdd]);
    expect(result.graveyard).toEqual([]);
  });

  test("identical addition groups preserve the larger placement count", async () => {
    const makeAdd = (date: string) =>
      Patch.Add({
        url: "https://same-add.example/",
        name: "Same",
        path: "bar/Folder",
        date: makeDate(date),
      });

    const result = await run(
      Sync.resolveConflicts(
        [makeAdd("2025-01-01"), makeAdd("2025-01-02")],
        [makeAdd("2025-02-01")],
      ),
    );

    expect(result.apply).toHaveLength(2);
    expect(result.graveyard).toEqual([]);
  });

  test("identical removal groups preserve the larger placement count", async () => {
    const makeRemove = (date: string) =>
      Patch.Remove({
        url: "https://same-remove.example/",
        name: "Same",
        path: "bar/Folder",
        date: makeDate(date),
      });

    const result = await run(
      Sync.resolveConflicts(
        [makeRemove("2025-01-01")],
        [makeRemove("2025-02-01"), makeRemove("2025-02-02")],
      ),
    );

    expect(result.apply).toHaveLength(2);
    expect(result.graveyard).toEqual([]);
  });

  test("empty inputs produce empty results", async () => {
    const result = await run(Sync.resolveConflicts([], []));
    expect(result.apply.length).toBe(0);
    expect(result.graveyard.length).toBe(0);
  });

  test("one side empty: all from other side applied", async () => {
    const patches = [
      Patch.Add({ url: "https://a.com/", name: "A", path: "bar", date: makeDate("2025-01-01") }),
      Patch.Remove({ url: "https://b.com/", name: "B", path: "bar", date: makeDate("2025-01-01") }),
    ];
    const result = await run(Sync.resolveConflicts(patches, []));
    expect(result.apply.length).toBe(2);
    expect(result.graveyard.length).toBe(0);
  });
});

// -- applyPatches --

describe("applyPatches", () => {
  test("add to empty tree creates section and leaf", async () => {
    const tree = emptyTree();
    const patches = [
      Patch.Add({ url: "https://a.com/", name: "A", path: "bar", date: makeDate("2025-01-01") }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    const bar = expectSection(result.bar, "expected bookmarks bar section");
    expect(bar.length).toBe(1);
    const node = expectLeaf(bar[0], "expected added bookmark leaf");
    expect(node.name).toBe("A");
    expect(node.url).toBe("https://a.com/");
  });

  test("add to nested folder path creates folders", async () => {
    const tree = emptyTree();
    const patches = [
      Patch.Add({
        url: "https://gpt.com/",
        name: "ChatGPT",
        path: "bar/AI/Tools",
        date: makeDate("2025-01-01"),
      }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    const bar = expectSection(result.bar, "expected bookmarks bar section");

    const aiFolder = expectFolder(
      bar.find((node) => BookmarkFolder.is(node) && node.name === "AI"),
      'expected "AI" folder',
    );
    const toolsFolder = expectFolder(
      aiFolder.children.find((node) => BookmarkFolder.is(node) && node.name === "Tools"),
      'expected "Tools" folder',
    );
    const gpt = expectLeaf(
      toolsFolder.children.find((node) => BookmarkLeaf.is(node) && node.url === "https://gpt.com/"),
      "expected ChatGPT bookmark",
    );
    expect(gpt.name).toBe("ChatGPT");
  });

  test("remove deletes leaf from tree", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("A", "https://a.com/"), leaf("B", "https://b.com/")],
    });
    const patches = [
      Patch.Remove({ url: "https://a.com/", name: "A", path: "bar", date: makeDate("2025-01-01") }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    const bar = expectSection(result.bar, "expected remaining bar section");
    expect(bar.length).toBe(1);
    const remaining = expectLeaf(bar[0], "expected remaining bookmark");
    expect(remaining.url).toBe("https://b.com/");
  });

  test("remove last leaf prunes empty section", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("A", "https://a.com/")],
      menu: [leaf("B", "https://b.com/")],
    });
    const patches = [
      Patch.Remove({ url: "https://a.com/", name: "A", path: "bar", date: makeDate("2025-01-01") }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    expect(result.bar).toBeUndefined();
    expect(result.menu).toBeDefined();
  });

  test("rename changes leaf name, preserves URL and position", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("Old Name", "https://a.com/")],
    });
    const patches = [
      Patch.Update({
        url: "https://a.com/",
        oldName: "Old Name",
        newName: "New Name",
        fromPath: "bar",
        toPath: "bar",
        date: makeDate("2025-01-01"),
      }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    const bar = expectSection(result.bar, "expected bookmarks bar section");
    const node = expectLeaf(
      bar.find((bookmark) => BookmarkLeaf.is(bookmark) && bookmark.url === "https://a.com/"),
      "expected renamed bookmark",
    );
    expect(node.name).toBe("New Name");
  });

  test("move relocates leaf between sections", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("A", "https://a.com/")],
    });
    const patches = [
      Patch.Update({
        url: "https://a.com/",
        oldName: "A",
        newName: "A",
        fromPath: "bar",
        toPath: "menu",
        date: makeDate("2025-01-01"),
      }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    expect(result.bar).toBeUndefined();
    const menu = expectSection(result.menu, "expected menu section after move");
    const node = expectLeaf(
      menu.find((bookmark) => BookmarkLeaf.is(bookmark) && bookmark.url === "https://a.com/"),
      "expected moved bookmark",
    );
    expect(node.name).toBe("A");
  });

  test("multiple patches applied in correct order", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("ToRemove", "https://remove.com/"), leaf("ToRename", "https://rename.com/")],
    });
    const patches = [
      Patch.Remove({
        url: "https://remove.com/",
        name: "ToRemove",
        path: "bar",
        date: makeDate("2025-01-01"),
      }),
      Patch.Update({
        url: "https://rename.com/",
        oldName: "ToRename",
        newName: "Renamed",
        fromPath: "bar",
        toPath: "bar",
        date: makeDate("2025-01-01"),
      }),
      Patch.Add({
        url: "https://new.com/",
        name: "New",
        path: "bar",
        date: makeDate("2025-01-01"),
      }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    const bar = expectSection(result.bar, "expected bookmarks bar section");

    const urls = bar
      .filter((node): node is BookmarkLeaf => BookmarkLeaf.is(node))
      .map((node) => node.url);

    expect(urls).toContain("https://rename.com/");
    expect(urls).toContain("https://new.com/");
    expect(urls).not.toContain("https://remove.com/");

    const renamed = expectLeaf(
      bar.find((bookmark) => BookmarkLeaf.is(bookmark) && bookmark.url === "https://rename.com/"),
      "expected renamed bookmark",
    );
    expect(renamed.name).toBe("Renamed");
  });

  test("empty patches returns tree unchanged", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("A", "https://a.com/")],
    });
    const result = await run(Sync.applyPatches(tree, []));
    const bar = expectSection(result.bar, "expected bookmarks bar section");
    expect(bar.length).toBe(1);
  });

  test("empty patches preserve sibling ordering and empty folders", async () => {
    const tree = new BookmarkTree({
      bar: [
        leaf("First", "https://first.example/"),
        folder("Empty", []),
        folder("Nested", [leaf("Inside", "https://inside.example/")]),
        leaf("Last", "https://last.example/"),
      ],
      menu: [folder("Other Empty", [])],
    });

    const result = await run(Sync.applyPatches(tree, []));

    expect(result).toEqual(tree);
  });

  test("remove preserves folders that become empty", async () => {
    const tree = new BookmarkTree({
      bar: [folder("Projects", [leaf("Only", "https://only.example/")])],
    });

    const result = await run(
      Sync.applyPatches(tree, [
        Patch.Remove({
          url: "https://only.example/",
          name: "Only",
          path: "bar/Projects",
          date: makeDate("2025-01-01"),
        }),
      ]),
    );

    expect(result).toEqual(
      new BookmarkTree({
        bar: [folder("Projects", [])],
      }),
    );
  });

  test("updates duplicate names by their pre-mutation occurrence when names swap", async () => {
    const url = "https://same.example/";
    const tree = new BookmarkTree({ bar: [leaf("A", url), leaf("B", url)] });

    const result = await run(
      Sync.applyPatches(tree, [
        Patch.Update({
          url,
          oldName: "A",
          newName: "B",
          fromPath: "bar",
          toPath: "bar",
          date: makeDate("2025-01-01"),
        }),
        Patch.Update({
          url,
          oldName: "B",
          newName: "A",
          fromPath: "bar",
          toPath: "bar",
          date: makeDate("2025-01-01"),
        }),
      ]),
    );

    expect(result.bar?.map((node) => (BookmarkLeaf.is(node) ? node.name : ""))).toEqual(["B", "A"]);
  });

  test("moves and renames one duplicate into another duplicate's folder and name", async () => {
    const url = "https://same.example/";
    const tree = new BookmarkTree({
      bar: [leaf("Old", url)],
      menu: [folder("Target", [leaf("Existing", url)])],
    });

    const result = await run(
      Sync.applyPatches(tree, [
        Patch.Update({
          url,
          oldName: "Old",
          newName: "Existing",
          fromPath: "bar",
          toPath: "menu/Target",
          date: makeDate("2025-01-01"),
        }),
      ]),
    );

    const menu = expectSection(result.menu, "expected menu section");
    const target = expectFolder(menu[0], "expected target folder");
    expect(target.children).toHaveLength(2);
    expect(
      target.children.every(
        (node) => BookmarkLeaf.is(node) && node.url === url && node.name === "Existing",
      ),
    ).toBe(true);
  });
});

describe("push", () => {
  test("rejects Chrome Sync mutations before creating a backup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-synced-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["Browser"]);
      await addChromeSyncMetadata(chromePath);
      const originalChrome = await readFile(chromePath, "utf-8");
      const config = makeConfig({
        all: new BookmarkTree({
          bar: [leaf("YAML", "https://yaml.example/")],
        }),
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      await expectRejects(
        run(
          Sync.push({
            yamlPath: join(dir, "bookmarks.yaml"),
            yamlOverride: config,
          }),
        ),
        "Chrome Sync can undo direct disk edits",
      );

      expect(await readFile(chromePath, "utf-8")).toBe(originalChrome);
      expect(await exists(backupDir)).toBe(false);
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("pushes to paired running Chrome through the live bridge and advances only after verification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-paired-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const syncBaselinePath = join(dir, "state", "sync-baselines.json");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");
    const yamlPath = join(dir, "bookmarks.yaml");
    const instanceId = "12345678-1234-1234-1234-123456789abc";
    const initialTree = BookmarkTree.make({
      bar: [leaf("Browser", "https://browser.example/")],
      menu: [],
      mobile: [],
    });
    const desiredTree = BookmarkTree.make({
      bar: [leaf("YAML", "https://yaml.example/")],
      menu: [],
      mobile: [],
    });
    const canonicalDesiredTree = BookmarkTree.make({
      bar: [leaf("YAML", "https://yaml.example/")],
      menu: [],
      mobile: [],
    });
    const config = makeConfig({
      all: desiredTree,
      chrome: { profiles: { default: {} } },
    });
    let liveTree = initialTree;
    let persistReconciliation = false;
    let reconcileCalls = 0;
    const layer = Layer.succeed(ChromeBridgeRuntime, {
      loadBindings: Effect.succeed([{ profilePath: chromePath, instanceId }]),
      saveBindings: () => Effect.die("Unexpected binding write"),
      instances: Effect.succeed([instanceId]),
      request: (_id, request) =>
        Effect.sync(() => {
          const decoded = Schema.decodeUnknownSync(NativeRequestSchema)(request);
          if (decoded.operation === "snapshot") {
            return {
              id: decoded.id,
              ok: true as const,
              value: TargetState.make({ tree: liveTree, readingList: [] }),
              version: 2,
              hostVersion: 2,
              capabilities: ["readingList"],
            };
          }

          reconcileCalls += 1;
          expect(decoded.expectedTree).toEqual(liveTree);
          expect(decoded.tree).toEqual(canonicalDesiredTree);
          if (persistReconciliation) liveTree = decoded.tree;
          return {
            id: decoded.id,
            ok: true as const,
            value: TargetState.make({ tree: decoded.tree, readingList: [] }),
            version: 2,
            hostVersion: 2,
            capabilities: ["readingList"],
          };
        }),
      launch: () => Effect.die("Unexpected browser launch"),
    });

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "Google Chrome";
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["Browser"]);
      await addChromeSyncMetadata(chromePath);
      await run(YamlModule.save(yamlPath, config));
      const originalChrome = await readFile(chromePath, "utf-8");

      await expectRejects(
        Effect.runPromise(Sync.push({ yamlPath }).pipe(Effect.provide(layer))),
        "Post-write verification failed",
      );
      expect(await exists(syncBaselinePath)).toBe(false);
      expect(liveTree).toEqual(initialTree);

      persistReconciliation = true;
      const result = await Effect.runPromise(Sync.push({ yamlPath }).pipe(Effect.provide(layer)));

      expect(result.orchestration).toBeUndefined();
      expect(result.targets[0]?.writeMode).toBe("rewrite");
      expect(reconcileCalls).toBe(2);
      expect(liveTree).toEqual(canonicalDesiredTree);
      expect(await readFile(chromePath, "utf-8")).toBe(originalChrome);

      const liveBackupPath = result.backup?.files.find((path) =>
        path.endsWith("--chrome--default--live-tree.json"),
      );
      expect(liveBackupPath).toBeDefined();
      if (!liveBackupPath) throw new Error("Expected a live Chrome tree backup");
      const liveBackup = Schema.decodeUnknownSync(TargetState)(
        JSON.parse(await readFile(liveBackupPath, "utf-8")),
      ).tree;
      expect(liveBackup).toEqual(initialTree);

      const baseline = await run(Baseline.load(syncBaselinePath));
      expect(baseline).toEqual({
        "chrome/default": TargetState.make({ tree: canonicalDesiredTree, readingList: [] }),
      });

      const status = await Effect.runPromise(Sync.status({ yamlPath }).pipe(Effect.provide(layer)));
      expect(status.targets[0]?.yamlPatches).toEqual([]);
      expect(status.targets[0]?.browserPatches).toEqual([]);
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("allows an already-matching Chrome Sync target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-synced-noop-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["Browser"]);
      await addChromeSyncMetadata(chromePath);
      const originalChrome = await readFile(chromePath, "utf-8");
      const config = makeConfig({
        all: new BookmarkTree({
          bar: [leaf("Browser", "https://browser.example/")],
        }),
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      const result = await run(
        Sync.push({
          yamlPath: join(dir, "bookmarks.yaml"),
          yamlOverride: config,
        }),
      );

      expect(result.targets[0]?.writeMode).toBe("patches");
      expect(result.targets[0]?.applied).toEqual([]);
      expect(await readFile(chromePath, "utf-8")).toBe(originalChrome);
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("projects structural-only YAML changes exactly through a target rewrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["First", "Last"]);

      const config = makeConfig({
        all: new BookmarkTree({
          bar: [
            leaf("Last", "https://last.example/"),
            leaf("First", "https://first.example/"),
            folder("Empty", []),
          ],
        }),
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      const result = await run(
        Sync.push({
          yamlPath: join(dir, "bookmarks.yaml"),
          yamlOverride: config,
        }),
      );

      expect(result.orchestration).toBeUndefined();
      expect(result.targets[0]?.writeMode).toBe("rewrite");
      expect(result.backup?.backupDir).toBe(backupDir);
      expect(result.backup?.files).toHaveLength(1);
      expect(result.backup?.files[0]).toContain("chrome--default--Bookmarks");
      expect(result.backup?.skipped).toEqual(["yaml", "sync baselines"]);
      expect(await readdir(backupDir)).toHaveLength(1);
      const browserTree = await run(Chrome.readBookmarks(chromePath));
      expect(browserTree).toEqual(config.all);
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("replaces ambiguous source folders with the exact YAML layout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-ambiguous-source-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeAmbiguousChromeFolderFixture(chromePath);

      const desiredTree = new BookmarkTree({
        bar: [
          folder("Heartbeat", [leaf("Heartbeat", "https://heartbeat.example/")]),
          folder("Build", [leaf("Effect", "https://effect.example/")]),
        ],
      });
      const config = makeConfig({
        all: desiredTree,
        chrome: {
          profiles: {
            default: {},
          },
        },
      });
      const yamlPath = join(dir, "bookmarks.yaml");
      const originalTree = await run(Chrome.readBookmarks(chromePath));

      const preview = await run(Sync.push({ dryRun: true, yamlPath, yamlOverride: config }));
      expect(preview.targets[0]?.writeMode).toBe("rewrite");
      expect(preview.targets[0]?.applied).toEqual([]);
      expect(await run(Chrome.readBookmarks(chromePath))).toEqual(originalTree);

      const result = await run(Sync.push({ yamlPath, yamlOverride: config }));
      expect(result.targets[0]?.writeMode).toBe("rewrite");
      expect(result.targets[0]?.applied).toEqual([]);
      expect(result.backup?.files).toHaveLength(1);
      const backupPath = expectDefined(result.backup?.files[0], "expected Chrome backup");
      expect(await run(Chrome.readBookmarks(backupPath))).toEqual(originalTree);
      expect(await run(Chrome.readBookmarks(chromePath))).toEqual(desiredTree);
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("push preserves duplicate YAML placements and then reports no pending changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-duplicates-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["First"]);

      const config = makeConfig({
        all: new BookmarkTree({
          bar: [
            leaf("First Copy", "https://dup.example/"),
            leaf("Second Copy", "https://dup.example/"),
          ],
        }),
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      const yamlPath = join(dir, "bookmarks.yaml");
      const result = await run(Sync.push({ yamlPath, yamlOverride: config }));
      expect(result.backup?.files).toHaveLength(1);

      const browserTree = await run(Chrome.readBookmarks(chromePath));
      expect(browserTree).toEqual(config.all);

      const status = await run(Sync.status({ yamlPath, yamlOverride: config }));
      expect(status.targets[0]?.yamlPatches).toEqual([]);
      expect(status.targets[0]?.browserPatches).toEqual([]);
      expect(status.targets[0]?.browserDuplicates).toEqual({
        urlGroups: 1,
        extraPlacements: 1,
      });
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails clearly for permanently missing configured targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-missing-target-"));
    const runtimeDir = join(dir, "runtime");
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);

    try {
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      const config = makeConfig({
        all: new BookmarkTree({
          bar: [leaf("First", "https://first.example/")],
        }),
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      await expectRejects(
        run(
          Sync.push({
            yamlPath: join(dir, "bookmarks.yaml"),
            yamlOverride: config,
          }),
        ),
        'Configured Chrome profile "default" was not discovered on this machine.',
      );
    } finally {
      discovery.restore();
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("defers when another sync already holds the runtime lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-locked-"));
    const runtimeDir = join(dir, "runtime");
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");

    try {
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["First"]);
      await mkdir(runtimeDir, { recursive: true });
      await Bun.write(
        join(runtimeDir, "sync.lock.json"),
        JSON.stringify({
          pid: process.pid,
          operation: "sync",
          resourcePath: join(dir, "bookmarks.yaml"),
          acquiredAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const config = makeConfig({
        all: new BookmarkTree({
          bar: [leaf("First", "https://first.example/")],
        }),
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      const result = await run(
        Sync.push({
          yamlPath: join(dir, "bookmarks.yaml"),
          yamlOverride: config,
        }),
      );

      expect(result.applied).toHaveLength(0);
      expect(result.orchestration?.state).toBe("busy");
      expect(result.orchestration?.message).toContain("already running");
    } finally {
      discovery.restore();
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("git history", () => {
  test("auto-commit is a no-op outside git and records each changed YAML inside git", async () => {
    const outside = await mkdtemp(join(tmpdir(), "bookmarks-sync-non-git-"));
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-sync-git-"));
    const yamlPath = join(dir, "bookmarks.yaml");

    try {
      await run(Sync.gitAutoCommit(join(outside, "bookmarks.yaml")));

      await runGit(dir, "init", "-b", "main");
      await runGit(dir, "config", "user.name", "Bookmarks Test");
      await runGit(dir, "config", "user.email", "bookmarks-test@example.com");
      await run(YamlModule.save(yamlPath, makeConfig()));
      await run(Sync.gitAutoCommit(yamlPath));
      await run(
        YamlModule.save(
          yamlPath,
          makeConfig({ all: BookmarkTree.make({ bar: [leaf("New", "https://new.example/")] }) }),
        ),
      );
      await run(Sync.gitAutoCommit(yamlPath));
      await run(Sync.gitAutoCommit(yamlPath));

      const log = Bun.spawnSync(["git", "log", "--format=%s"], { cwd: dir }).stdout.toString();
      expect(log.trim().split("\n")).toEqual([
        "chore(bookmarks): auto-sync bookmarks.yaml",
        "chore(bookmarks): auto-sync bookmarks.yaml",
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("unsupported browser constructs", () => {
  test("refuses unsupported separator constructs before mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-sync-separator-"));
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");

    try {
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
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
                guid: "bookmark-bar",
                date_added: "0",
                date_modified: "0",
                children: [
                  {
                    type: "separator",
                    id: "2",
                    guid: "separator",
                    name: "",
                    date_added: "0",
                    date_modified: "0",
                  },
                ],
              },
              other: {
                type: "folder",
                name: "Other Bookmarks",
                id: "10",
                guid: "other",
                date_added: "0",
                date_modified: "0",
                children: [],
              },
              synced: {
                type: "folder",
                name: "Mobile Bookmarks",
                id: "11",
                guid: "mobile",
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

      const config = makeConfig({
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      await expectRejects(
        run(
          Sync.sync({
            yamlPath: join(dir, "bookmarks.yaml"),
            yamlOverride: config,
            dryRun: true,
          }),
        ),
        "Bookmark separators are not supported",
      );
    } finally {
      discovery.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sync", () => {
  test("rejects ambiguous sibling folder paths without changing either source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-sync-dry-run-ambiguous-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");
    const yamlPath = join(dir, "bookmarks.yaml");

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["Browser"]);
      const config = makeConfig({
        all: new BookmarkTree({
          bar: [folder("Duplicate", []), folder("Duplicate", [])],
        }),
        chrome: {
          profiles: {
            default: {},
          },
        },
      });
      await run(YamlModule.save(yamlPath, config));
      const originalYaml = await readFile(yamlPath, "utf-8");
      const originalChrome = await readFile(chromePath, "utf-8");

      await expectRejects(
        run(Sync.sync({ dryRun: true, yamlPath })),
        'Sibling bookmark folders named "Duplicate" cannot be addressed safely',
      );
      await expectRejects(
        run(Sync.sync({ yamlPath })),
        'Sibling bookmark folders named "Duplicate" cannot be addressed safely',
      );

      expect(await readFile(yamlPath, "utf-8")).toBe(originalYaml);
      expect(await readFile(chromePath, "utf-8")).toBe(originalChrome);
      expect(await exists(backupDir)).toBe(false);
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges an open browser into the YAML and writes it once the browser closes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-sync-browser-running-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const originalForcedBrowserRunning = process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");
    const yamlPath = join(dir, "bookmarks.yaml");

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "Google Chrome";
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["Browser"]);
      await run(
        YamlModule.save(
          yamlPath,
          makeConfig({
            all: new BookmarkTree({
              bar: [leaf("YAML", "https://yaml.example/")],
            }),
            chrome: {
              profiles: {
                default: {},
              },
            },
          }),
        ),
      );
      const originalChrome = await readFile(chromePath, "utf-8");

      const open = await run(Sync.sync({ yamlPath }));

      // The open browser's bookmarks reach the YAML; its own file waits for it to close.
      expect(open.orchestration).toBeUndefined();
      expect(
        open.waiting?.map((waiting) => [
          waiting.target.browser,
          waiting.target.profile,
          waiting.browser,
        ]),
      ).toEqual([["chrome", "default", "Google Chrome"]]);
      expect(open.yamlChanged).toBe(true);
      expect(open.backup?.files.some((file) => file.endsWith("--bookmarks.yaml"))).toBe(true);
      expect(await readFile(chromePath, "utf-8")).toBe(originalChrome);
      const merged = await run(YamlModule.load(yamlPath));
      expect(merged.all.bar?.map((node) => node.name).sort()).toEqual(["Browser", "YAML"]);

      // Asked again while still open, the sync changes nothing and adds nothing twice.
      const again = await run(Sync.sync({ yamlPath }));
      expect(again.yamlChanged).toBe(false);
      expect(again.backup).toBeUndefined();
      expect(
        (await run(YamlModule.load(yamlPath))).all.bar?.map((node) => node.name).sort(),
      ).toEqual(["Browser", "YAML"]);

      process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "";
      const closed = await run(Sync.sync({ yamlPath }));
      expect(closed.waiting).toBeUndefined();
      expect(closed.yamlChanged).toBe(false);
      const chromeAfter = await run(Chrome.readBookmarks(chromePath));
      expect(chromeAfter.bar?.map((node) => node.name).sort()).toEqual(["Browser", "YAML"]);
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      if (originalForcedBrowserRunning === undefined) {
        delete process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"];
      } else {
        process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = originalForcedBrowserRunning;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("imports browser duplicates and the second sync is stable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-sync-browser-duplicates-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["Dup", "Dup"]);

      const yamlPath = join(dir, "bookmarks.yaml");
      const first = await run(Sync.sync({ yamlPath }));
      expect(first.backup?.files).toHaveLength(1);

      const saved = await run(YamlModule.load(yamlPath));
      expect(saved.all.bar?.map((node) => node.name)).toEqual(["Dup", "Dup"]);

      const second = await run(Sync.sync({ yamlPath }));
      expect(second.applied).toEqual([]);
      expect(second.targets[0]?.applied).toEqual([]);

      const status = await run(Sync.status({ yamlPath }));
      expect(status.targets[0]?.yamlPatches).toEqual([]);
      expect(status.targets[0]?.browserPatches).toEqual([]);
      expect(status.targets[0]?.browserDuplicates).toEqual({
        urlGroups: 1,
        extraPlacements: 1,
      });
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fresh sync outside git imports browser state into bookmarks.yaml and preserves the target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-sync-fresh-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");
    const yamlPath = join(dir, "bookmarks.yaml");

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["Imported"]);

      const result = await run(
        Sync.sync({
          yamlPath,
        }),
      );

      expect(result.targets).toHaveLength(1);
      expect(result.backup?.backupDir).toBe(backupDir);
      expect(result.backup?.files).toHaveLength(1);

      const saved = await run(YamlModule.load(yamlPath));
      expect(saved.all.bar?.map((node) => node.name)).toEqual(["Imported"]);

      const browserTree = await run(Chrome.readBookmarks(chromePath));
      expect(browserTree.bar?.map((node) => node.name)).toEqual(["Imported"]);
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the per-target baseline in the state folder keeps later structural syncs on the fast path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-sync-managed-baseline-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const syncBaselinePath = join(dir, "state", "sync-baselines.json");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const originalSyncBaselinePath = process.env["BOOKMARKS_SYNC_BASELINE_PATH"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");
    const yamlPath = join(dir, "bookmarks.yaml");
    const initialBrowserTree = BookmarkTree.make({
      bar: [folder("Existing Empty", []), leaf("Imported", "https://imported.example/")],
    });
    const updatedConfig = makeConfig({
      all: BookmarkTree.make({
        bar: [
          folder("Existing Empty", []),
          leaf("Imported", "https://imported.example/"),
          folder("_Sync Test", [
            leaf("Test Link 1", "https://example.com/?bookmarks-sync-test=1"),
            leaf("Test Link 2", "https://example.com/?bookmarks-sync-test=2"),
            leaf("Test Link 3", "https://example.com/?bookmarks-sync-test=3"),
          ]),
        ],
      }),
    });

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      process.env["BOOKMARKS_SYNC_BASELINE_PATH"] = syncBaselinePath;
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, []);
      await run(Chrome.writeTree(chromePath, initialBrowserTree));

      await run(
        Sync.sync({
          yamlPath,
        }),
      );

      expect(await Bun.file(syncBaselinePath).exists()).toBe(true);
      const initialBaseline = await run(Baseline.load(syncBaselinePath));
      expect(initialBaseline["chrome/default"]?.tree.bar?.map((node) => node.name)).toEqual([
        "Existing Empty",
        "Imported",
      ]);

      await run(YamlModule.save(yamlPath, updatedConfig));

      const result = await run(
        Sync.sync({
          yamlPath,
        }),
      );

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]?.target.profile).toBe("default");
      expect(result.targets[0]?.writeMode).toBe("patches");

      const browserTree = await run(Chrome.readBookmarks(chromePath));
      expect(browserTree).toEqual(updatedConfig.all);

      const managedBaseline = await run(Baseline.load(syncBaselinePath));
      expect(managedBaseline).toEqual({
        "chrome/default": TargetState.make({
          tree: BookmarkTree.make(updatedConfig.all),
          readingList: [],
        }),
      });
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      if (originalSyncBaselinePath === undefined) {
        delete process.env["BOOKMARKS_SYNC_BASELINE_PATH"];
      } else {
        process.env["BOOKMARKS_SYNC_BASELINE_PATH"] = originalSyncBaselinePath;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("status and backup", () => {
  test("status reports pending patches in both directions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-status-"));
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");

    try {
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["Browser"]);

      const config = makeConfig({
        all: BookmarkTree.make({
          bar: [leaf("Yaml", "https://yaml.example/")],
        }),
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      const result = await run(
        Sync.status({
          yamlPath: join(dir, "bookmarks.yaml"),
          yamlOverride: config,
        }),
      );

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]?.yamlPatches.length).toBeGreaterThan(0);
      expect(result.targets[0]?.browserPatches.length).toBeGreaterThan(0);
    } finally {
      discovery.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("backup copies yaml and discovered target files while skipping missing candidates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-backup-"));
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");
    const yamlPath = join(dir, "bookmarks.yaml");
    const backupDir = join(dir, "backups");

    try {
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["Browser"]);
      await run(
        YamlModule.save(
          yamlPath,
          makeConfig({
            chrome: {
              profiles: {
                default: {},
              },
            },
          }),
        ),
      );

      await run(
        Baseline.save({
          "chrome/default": TargetState.make({ tree: BookmarkTree.make({}), readingList: [] }),
        }),
      );

      const result = await run(
        Sync.backup({
          yamlPath,
          backupDir,
        }),
      );

      // The YAML, the per-target baselines, and the browser file.
      expect(result.files).toHaveLength(3);
      expect(result.skipped).toEqual([]);
      expect(await readdir(backupDir)).toHaveLength(3);
    } finally {
      discovery.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("gc", () => {
  test("removes expired graveyard entries from yaml and target state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-gc-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");
    const expiredFolderName = "2020-01-01_chrome_conflict";

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, []);

      const treeWithGraveyard = BookmarkTree.make({
        menu: [
          BookmarkFolder.make({
            name: "_graveyard",
            children: [
              BookmarkFolder.make({
                name: expiredFolderName,
                children: [leaf("Old", "https://old.example/")],
              }),
            ],
          }),
        ],
      });
      await run(Chrome.writeTree(chromePath, treeWithGraveyard));

      const result = await run(
        Sync.gc({
          yamlPath: join(dir, "bookmarks.yaml"),
          yamlOverride: makeConfig({
            all: treeWithGraveyard,
            chrome: {
              profiles: {
                default: {},
              },
            },
          }),
        }),
      );

      expect(result.targets).toHaveLength(1);
      const yaml = await run(YamlModule.load(join(dir, "bookmarks.yaml")));
      expect(yaml.all.menu).toBeUndefined();

      const browserTree = await run(Chrome.readBookmarks(chromePath));
      expect(browserTree.menu).toBeUndefined();
    } finally {
      discovery.restore();
      if (originalBackupDir === undefined) {
        delete process.env["BOOKMARKS_BACKUP_DIR"];
      } else {
        process.env["BOOKMARKS_BACKUP_DIR"] = originalBackupDir;
      }
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"];
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
