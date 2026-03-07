/* oxlint-disable await-thenable, no-confusing-void-expression, no-non-null-assertion, no-unsafe-argument, no-unsafe-type-assertion */
import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Chrome from "./chrome.ts";
import {
  BookmarkFolder,
  BookmarkLeaf,
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

type SafariInput = Parameters<typeof SafariBookmarks.make>[0];
type ChromeProfileInput = Parameters<typeof ChromeProfileBookmarks.make>[0];
type ChromeInput = Omit<Parameters<typeof ChromeBookmarks.make>[0], "profiles"> & {
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

const makeDate = (iso: string): DateTime.Utc => DateTime.unsafeMake(iso);

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
              url: `https://${name.toLowerCase()}.example`,
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

const setupDiscoveryEnv = async (
  dir: string,
  profileDirectories: readonly string[] = ["Default"],
): Promise<{
  readonly chromeDataDir: string;
  readonly restore: () => void;
}> => {
  const chromeDataDir = join(dir, "Chrome");
  const originalChromeDataDir = process.env["BOOKMARKS_CHROME_DATA_DIR"];
  const originalSafariPlistPath = process.env["BOOKMARKS_SAFARI_PLIST_PATH"];
  const originalSafariTabsDbPath = process.env["BOOKMARKS_SAFARI_TABS_DB_PATH"];

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
    },
  };
};

// -- resolveConflicts --

describe("resolveConflicts", () => {
  test("non-overlapping patches: all applied, none graveyarded", async () => {
    const yamlPatches = [
      Patch.Add({ url: "https://a.com", name: "A", path: "bar", date: makeDate("2025-01-01") }),
    ];
    const browserPatches = [
      Patch.Add({ url: "https://b.com", name: "B", path: "bar", date: makeDate("2025-01-01") }),
    ];

    const result = await run(Sync.resolveConflicts(yamlPatches, browserPatches));
    expect(result.apply.length).toBe(2);
    expect(result.graveyard.length).toBe(0);
  });

  test("conflicting URL: newest wins", async () => {
    const older = makeDate("2025-01-01");
    const newer = makeDate("2025-06-01");

    const yamlPatches = [
      Patch.Add({ url: "https://conflict.com", name: "YAML Version", path: "bar", date: older }),
    ];
    const browserPatches = [
      Patch.Add({ url: "https://conflict.com", name: "Browser Version", path: "bar", date: newer }),
    ];

    const result = await run(Sync.resolveConflicts(yamlPatches, browserPatches));
    expect(result.apply.length).toBe(1);
    expect(result.graveyard.length).toBe(1);

    // Browser is newer → browser wins
    const applied = result.apply[0]!;
    expect(Patch.$is("Add")(applied)).toBe(true);
    if (Patch.$is("Add")(applied)) {
      expect(applied.name).toBe("Browser Version");
    }
    const graveyarded = result.graveyard[0]!;
    if (Patch.$is("Add")(graveyarded)) {
      expect(graveyarded.name).toBe("YAML Version");
    }
  });

  test("tie-break: YAML wins when dates are equal", async () => {
    const sameDate = makeDate("2025-03-15");

    const yamlPatches = [
      Patch.Add({ url: "https://tie.com", name: "YAML", path: "bar", date: sameDate }),
    ];
    const browserPatches = [
      Patch.Add({ url: "https://tie.com", name: "Browser", path: "bar", date: sameDate }),
    ];

    const result = await run(Sync.resolveConflicts(yamlPatches, browserPatches));
    expect(result.apply.length).toBe(1);
    expect(result.graveyard.length).toBe(1);
    const applied = result.apply[0]!;
    if (Patch.$is("Add")(applied)) {
      expect(applied.name).toBe("YAML");
    }
  });

  test("empty inputs produce empty results", async () => {
    const result = await run(Sync.resolveConflicts([], []));
    expect(result.apply.length).toBe(0);
    expect(result.graveyard.length).toBe(0);
  });

  test("one side empty: all from other side applied", async () => {
    const patches = [
      Patch.Add({ url: "https://a.com", name: "A", path: "bar", date: makeDate("2025-01-01") }),
      Patch.Remove({ url: "https://b.com", name: "B", path: "bar", date: makeDate("2025-01-01") }),
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
      Patch.Add({ url: "https://a.com", name: "A", path: "bar", date: makeDate("2025-01-01") }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    expect(result.bar).toBeDefined();
    expect(result.bar!.length).toBe(1);
    const node = result.bar![0] as BookmarkLeaf;
    expect(node.name).toBe("A");
    expect(node.url).toBe("https://a.com");
  });

  test("add to nested folder path creates folders", async () => {
    const tree = emptyTree();
    const patches = [
      Patch.Add({
        url: "https://gpt.com",
        name: "ChatGPT",
        path: "bar/AI/Tools",
        date: makeDate("2025-01-01"),
      }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    expect(result.bar).toBeDefined();

    const aiFolder = result.bar!.find(
      (n) => BookmarkFolder.is(n) && n.name === "AI",
    ) as BookmarkFolder;
    expect(aiFolder).toBeDefined();

    const toolsFolder = aiFolder.children.find(
      (n) => BookmarkFolder.is(n) && n.name === "Tools",
    ) as BookmarkFolder;
    expect(toolsFolder).toBeDefined();

    const gpt = toolsFolder.children.find(
      (n) => BookmarkLeaf.is(n) && n.url === "https://gpt.com",
    ) as BookmarkLeaf;
    expect(gpt).toBeDefined();
    expect(gpt.name).toBe("ChatGPT");
  });

  test("remove deletes leaf from tree", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("A", "https://a.com"), leaf("B", "https://b.com")],
    });
    const patches = [
      Patch.Remove({ url: "https://a.com", name: "A", path: "bar", date: makeDate("2025-01-01") }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    expect(result.bar).toBeDefined();
    expect(result.bar!.length).toBe(1);
    const remaining = result.bar![0] as BookmarkLeaf;
    expect(remaining.url).toBe("https://b.com");
  });

  test("remove last leaf prunes empty section", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("A", "https://a.com")],
      menu: [leaf("B", "https://b.com")],
    });
    const patches = [
      Patch.Remove({ url: "https://a.com", name: "A", path: "bar", date: makeDate("2025-01-01") }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    expect(result.bar).toBeUndefined();
    expect(result.menu).toBeDefined();
  });

  test("rename changes leaf name, preserves URL and position", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("Old Name", "https://a.com")],
    });
    const patches = [
      Patch.Rename({
        url: "https://a.com",
        path: "bar",
        oldName: "Old Name",
        newName: "New Name",
        date: makeDate("2025-01-01"),
      }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    expect(result.bar).toBeDefined();
    const node = result.bar!.find(
      (n) => BookmarkLeaf.is(n) && n.url === "https://a.com",
    ) as BookmarkLeaf;
    expect(node).toBeDefined();
    expect(node.name).toBe("New Name");
  });

  test("move relocates leaf between sections", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("A", "https://a.com")],
    });
    const patches = [
      Patch.Move({
        url: "https://a.com",
        name: "A",
        fromPath: "bar",
        toPath: "menu",
        date: makeDate("2025-01-01"),
      }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    expect(result.bar).toBeUndefined();
    expect(result.menu).toBeDefined();
    const node = result.menu!.find(
      (n) => BookmarkLeaf.is(n) && n.url === "https://a.com",
    ) as BookmarkLeaf;
    expect(node).toBeDefined();
    expect(node.name).toBe("A");
  });

  test("multiple patches applied in correct order", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("ToRemove", "https://remove.com"), leaf("ToRename", "https://rename.com")],
    });
    const patches = [
      Patch.Remove({
        url: "https://remove.com",
        name: "ToRemove",
        path: "bar",
        date: makeDate("2025-01-01"),
      }),
      Patch.Rename({
        url: "https://rename.com",
        path: "bar",
        oldName: "ToRename",
        newName: "Renamed",
        date: makeDate("2025-01-01"),
      }),
      Patch.Add({ url: "https://new.com", name: "New", path: "bar", date: makeDate("2025-01-01") }),
    ];
    const result = await run(Sync.applyPatches(tree, patches));
    expect(result.bar).toBeDefined();

    const urls = result.bar!.filter((n): n is BookmarkLeaf => BookmarkLeaf.is(n)).map((n) => n.url);

    expect(urls).toContain("https://rename.com");
    expect(urls).toContain("https://new.com");
    expect(urls).not.toContain("https://remove.com");

    const renamed = result.bar!.find(
      (n) => BookmarkLeaf.is(n) && n.url === "https://rename.com",
    ) as BookmarkLeaf;
    expect(renamed.name).toBe("Renamed");
  });

  test("empty patches returns tree unchanged", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("A", "https://a.com")],
    });
    const result = await run(Sync.applyPatches(tree, []));
    expect(result.bar).toBeDefined();
    expect(result.bar!.length).toBe(1);
  });

  test("empty patches preserve sibling ordering and empty folders", async () => {
    const tree = new BookmarkTree({
      bar: [
        leaf("First", "https://first.example"),
        folder("Empty", []),
        folder("Nested", [leaf("Inside", "https://inside.example")]),
        leaf("Last", "https://last.example"),
      ],
      menu: [folder("Other Empty", [])],
    });

    const result = await run(Sync.applyPatches(tree, []));

    expect(result).toEqual(tree);
  });

  test("remove preserves folders that become empty", async () => {
    const tree = new BookmarkTree({
      bar: [folder("Projects", [leaf("Only", "https://only.example")])],
    });

    const result = await run(
      Sync.applyPatches(tree, [
        Patch.Remove({
          url: "https://only.example",
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
});

describe("decomposeResolvedTrees", () => {
  test("extracts common bookmarks into base and profile-specific bookmarks into overlays", () => {
    const safariTree = new BookmarkTree({
      bar: [
        folder("Shared", [leaf("Common", "https://common.example")]),
        leaf("Safari Only", "https://safari-only.example"),
      ],
    });
    const chromeTree = new BookmarkTree({
      bar: [
        folder("Shared", [leaf("Common", "https://common.example")]),
        leaf("Chrome Only", "https://chrome-only.example"),
      ],
    });

    const config = Sync.decomposeResolvedTrees(
      makeConfig({
        safari: {},
        chrome: { profiles: { work: {} } },
      }),
      {
        safari: safariTree,
        "chrome/work": chromeTree,
      },
    );

    expect(config.all.bar).toBeDefined();
    const sharedFolder = config.all.bar!.find(
      (node): node is BookmarkFolder => BookmarkFolder.is(node) && node.name === "Shared",
    );
    expect(sharedFolder).toBeDefined();
    expect(sharedFolder!.children.length).toBe(1);

    expect(config.safari?.bar).toBeDefined();
    expect(config.chrome?.bar).toBeDefined();

    const safariOnly = config.safari?.bar?.find((node): node is BookmarkLeaf =>
      BookmarkLeaf.is(node),
    );
    const chromeOnly = config.chrome?.bar?.find((node): node is BookmarkLeaf =>
      BookmarkLeaf.is(node),
    );
    expect(safariOnly?.url).toBe("https://safari-only.example");
    expect(chromeOnly?.url).toBe("https://chrome-only.example");
  });

  test("omits profile overlays when every resolved tree is identical", () => {
    const sharedTree = new BookmarkTree({
      menu: [leaf("Shared", "https://shared.example")],
    });

    const config = Sync.decomposeResolvedTrees(
      makeConfig({
        safari: {},
        chrome: { profiles: { default: {} } },
      }),
      {
        safari: sharedTree,
        "chrome/default": sharedTree,
      },
    );

    expect(config.all.menu).toBeDefined();
    expect(config.all.menu!.length).toBe(1);
    expect(config.safari?.menu).toBeUndefined();
    expect(config.chrome?.profiles?.["default"]?.menu).toBeUndefined();
  });

  test("preserves exact resolved ordering when shared bookmarks diverge after the prefix", async () => {
    const safariTree = new BookmarkTree({
      bar: [
        leaf("Common A", "https://common-a.example"),
        leaf("Safari Only", "https://safari-only.example"),
        folder("Shared Empty", []),
        leaf("Common B", "https://common-b.example"),
      ],
    });

    const chromeTree = new BookmarkTree({
      bar: [
        leaf("Common A", "https://common-a.example"),
        leaf("Chrome Only", "https://chrome-only.example"),
        folder("Shared Empty", []),
        leaf("Common B", "https://common-b.example"),
      ],
    });

    const config = Sync.decomposeResolvedTrees(
      makeConfig({
        safari: {},
        chrome: { profiles: { work: {} } },
      }),
      {
        safari: safariTree,
        "chrome/work": chromeTree,
      },
    );

    expect(config.all.bar?.map((node) => node.name)).toEqual(["Common A"]);

    const safariResolved = await run(YamlModule.resolveTarget(config, { browser: "safari" }));
    const chromeResolved = await run(
      YamlModule.resolveTarget(config, { browser: "chrome", profile: "work" }),
    );

    expect(safariResolved).toEqual(safariTree);
    expect(chromeResolved).toEqual(chromeTree);
  });
});

describe("push", () => {
  test("projects structural-only YAML changes exactly through a target rewrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-"));
    const backupDir = join(dir, "backups");
    const runtimeDir = join(dir, "runtime");
    const originalBackupDir = process.env["BOOKMARKS_BACKUP_DIR"];
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];
    const originalForcedBrowserRunning = process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"];
    const discovery = await setupDiscoveryEnv(dir);
    const chromePath = join(discovery.chromeDataDir, "Default", "Bookmarks");

    try {
      process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
      process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "Google Chrome";
      await mkdir(join(discovery.chromeDataDir, "Default"), { recursive: true });
      await writeChromeFixture(chromePath, ["First", "Last"]);

      const config = makeConfig({
        all: new BookmarkTree({
          bar: [
            leaf("Last", "https://last.example"),
            leaf("First", "https://first.example"),
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
      expect(result.backup?.skipped).toEqual(["yaml"]);
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
      if (originalForcedBrowserRunning === undefined) {
        delete process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"];
      } else {
        process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = originalForcedBrowserRunning;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses duplicate URLs in YAML with actionable diagnostics", async () => {
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
            leaf("First Copy", "https://dup.example"),
            leaf("Second Copy", "https://dup.example"),
          ],
        }),
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      await expect(
        run(
          Sync.push({
            yamlPath: join(dir, "bookmarks.yaml"),
            yamlOverride: config,
          }),
        ),
      ).rejects.toThrow('Duplicate URL "https://dup.example"');
      await expect(readdir(backupDir)).rejects.toThrow();
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
          bar: [leaf("First", "https://first.example")],
        }),
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      await expect(
        run(
          Sync.push({
            yamlPath: join(dir, "bookmarks.yaml"),
            yamlOverride: config,
          }),
        ),
      ).rejects.toThrow('Configured Chrome profile "default" was not discovered on this machine.');
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
          yamlPath: join(dir, "bookmarks.yaml"),
          acquiredAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const config = makeConfig({
        all: new BookmarkTree({
          bar: [leaf("First", "https://first.example")],
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

describe("git baseline helpers", () => {
  test("treats non-git yaml paths as having no committed baseline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-sync-non-git-"));
    const yamlPath = join(dir, "bookmarks.yaml");

    try {
      expect(await run(Sync.readGitBaselineConfig(yamlPath))).toBeNull();
      expect(await run(Sync.readGitBaseline(yamlPath))).toEqual(BookmarkTree.make({}));
      await expect(run(Sync.gitAutoCommit(yamlPath))).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads the committed baseline and auto-commits updated bookmarks when git is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-sync-git-"));
    const yamlPath = join(dir, "bookmarks.yaml");
    const baseline = makeConfig({
      all: BookmarkTree.make({
        bar: [leaf("Baseline", "https://baseline.example")],
      }),
    });
    const updated = makeConfig({
      all: BookmarkTree.make({
        bar: [leaf("Updated", "https://updated.example")],
      }),
    });

    try {
      await runGit(dir, "init", "-b", "main");
      await runGit(dir, "config", "user.name", "Bookmarks Test");
      await runGit(dir, "config", "user.email", "bookmarks-test@example.com");
      await run(YamlModule.save(yamlPath, baseline));
      await runGit(dir, "add", "bookmarks.yaml");
      await runGit(dir, "commit", "-m", "baseline");

      const readBaseline = await run(Sync.readGitBaselineConfig(yamlPath));
      expect(readBaseline).toEqual(baseline);

      await run(YamlModule.save(yamlPath, updated));
      await run(Sync.gitAutoCommit(yamlPath));

      const readUpdatedBaseline = await run(Sync.readGitBaselineConfig(yamlPath));
      expect(readUpdatedBaseline).toEqual(updated);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("pull", () => {
  test("refuses unsupported separator constructs before mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-pull-separator-"));
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

      await expect(
        run(
          Sync.pull({
            yamlPath: join(dir, "bookmarks.yaml"),
            yamlOverride: config,
            dryRun: true,
          }),
        ),
      ).rejects.toThrow("Bookmark separators are not supported");
    } finally {
      discovery.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes browser state back into bookmarks.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-pull-save-"));
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

      const config = makeConfig({
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      const result = await run(
        Sync.pull({
          yamlPath,
          yamlOverride: config,
        }),
      );

      expect(result.targets).toHaveLength(1);
      expect(result.backup?.files).toHaveLength(1);
      const saved = await run(YamlModule.load(yamlPath));
      const resolved = await run(
        YamlModule.resolveTarget(saved, { browser: "chrome", profile: "default" }),
      );
      expect(resolved.bar?.map((node) => node.name)).toEqual(["Imported"]);
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

describe("sync", () => {
  test("fails clearly for duplicate URLs in the browser before backup", async () => {
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

      const config = makeConfig({
        chrome: {
          profiles: {
            default: {},
          },
        },
      });

      await expect(
        run(
          Sync.sync({
            yamlPath: join(dir, "bookmarks.yaml"),
            yamlOverride: config,
          }),
        ),
      ).rejects.toThrow('Duplicate URL "https://dup.example"');
      await expect(readdir(backupDir)).rejects.toThrow();
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
          bar: [leaf("Yaml", "https://yaml.example")],
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

      const result = await run(
        Sync.backup({
          yamlPath,
          backupDir,
        }),
      );

      expect(result.files).toHaveLength(2);
      expect(result.skipped).toEqual([]);
      expect(await readdir(backupDir)).toHaveLength(2);
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
                children: [leaf("Old", "https://old.example")],
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
