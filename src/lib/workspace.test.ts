/* oxlint-disable no-await-in-loop, no-unsafe-type-assertion, prefer-optional-chain */
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Chrome from "./chrome.ts";
import * as Safari from "./safari.ts";
import {
  BookmarkLeaf,
  BookmarksConfig,
  BookmarkTree,
  ChromeBookmarks,
  ChromeProfileBookmarks,
} from "./schema/__.ts";
import { writeSafariBookmarksFixture } from "./test-fixtures.ts";
import * as Workspace from "./workspace.ts";
import * as YamlModule from "./yaml.ts";

const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "BOOKMARKS_CONFIG_DIR",
  "BOOKMARKS_STATE_DIR",
  "BOOKMARKS_YAML_PATH",
  "BOOKMARKS_WORKSPACE_PATH",
  "BOOKMARKS_IMPORT_LOCK_PATH",
  "BOOKMARKS_PUBLISH_PLAN_PATH",
  "BOOKMARKS_BACKUP_DIR",
  "BOOKMARKS_RUNTIME_DIR",
  "BOOKMARKS_SAFARI_PLIST_PATH",
  "BOOKMARKS_SAFARI_TABS_DB_PATH",
  "BOOKMARKS_CHROME_DATA_DIR",
  "BOOKMARKS_FORCE_BROWSER_RUNNING",
  "BOOKMARKS_FORCE_FULL_DISK_ACCESS",
] as const;

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);
const runError = async <A>(effect: Effect.Effect<A, Error>): Promise<Error> => {
  try {
    await run(effect);
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected Error, received ${String(error)}`, { cause: error });
  }

  throw new Error("Expected effect to fail");
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

const setupWorkspaceEnv = async (
  profiles = [{ directory: "Default", title: "Top Link", url: "https://top.example" }],
  options: { readonly safariFixture?: boolean } = {},
) => {
  const dir = await mkdtemp(join(tmpdir(), "bookmarks-workspace-"));
  const yamlPath = join(dir, "bookmarks.yaml");
  const workspacePath = join(dir, "workspace.yaml");
  const importLockPath = join(dir, "import.lock.json");
  const publishPlanPath = join(dir, "publish.plan.json");
  const backupDir = join(dir, "backups");
  const runtimeDir = join(dir, "runtime");
  const chromeDataDir = join(dir, "Chrome");
  const chromePath = join(chromeDataDir, "Default", "Bookmarks");
  const safariPath = join(dir, "Safari", "Bookmarks.plist");
  const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db");

  process.env["BOOKMARKS_YAML_PATH"] = yamlPath;
  process.env["BOOKMARKS_WORKSPACE_PATH"] = workspacePath;
  process.env["BOOKMARKS_IMPORT_LOCK_PATH"] = importLockPath;
  process.env["BOOKMARKS_PUBLISH_PLAN_PATH"] = publishPlanPath;
  process.env["BOOKMARKS_BACKUP_DIR"] = backupDir;
  process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;
  process.env["BOOKMARKS_SAFARI_PLIST_PATH"] = safariPath;
  process.env["BOOKMARKS_SAFARI_TABS_DB_PATH"] = safariTabsDbPath;
  process.env["BOOKMARKS_CHROME_DATA_DIR"] = chromeDataDir;
  process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "";

  await mkdir(chromeDataDir, { recursive: true });
  await Bun.write(
    join(chromeDataDir, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: Object.fromEntries(profiles.map((profile) => [profile.directory, {}])),
      },
    }),
  );

  for (const profile of profiles) {
    const bookmarksPath = join(chromeDataDir, profile.directory, "Bookmarks");
    await mkdir(join(chromeDataDir, profile.directory), { recursive: true });
    await writeChromeBookmarks(bookmarksPath, profile.title, profile.url);
  }

  if (options.safariFixture) {
    await mkdir(join(dir, "Safari"), { recursive: true });
    await writeSafariBookmarksFixture(safariPath);
  }

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

  return {
    dir,
    yamlPath,
    workspacePath,
    importLockPath,
    publishPlanPath,
    backupDir,
    runtimeDir,
    chromeDataDir,
    chromePath,
    safariPath,
  };
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

describe("workspace workflow", () => {
  test("next routes to sync when no workspace exists", async () => {
    const env = await setupWorkspaceEnv();

    try {
      const result = await run(Workspace.next());
      expect(result.state).toBe("needs_import");
      expect(result.nextAction.kind).toBe("run_command");
      if (result.nextAction.kind === "run_command") {
        expect(result.nextAction.command).toBe("bookmarks sync");
      }
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("import creates a review workspace with immutable source occurrences", async () => {
    const env = await setupWorkspaceEnv();

    try {
      const imported = await run(Workspace.importState(["chrome/default"]));
      expect(imported.workspacePath).toBe(env.workspacePath);
      expect(imported.importLockPath).toBe(env.importLockPath);
      expect(imported.targets).toEqual(["chrome/default"]);
      expect(imported.backup).toBeNull();

      const workspace = await run(Workspace.load(env.workspacePath));
      expect(workspace.inbox["chrome/default"]?.bar?.[0]?.kind).toBe("bookmark");
      expect(workspace.publish.global.bar).toBeUndefined();

      const validation = await run(Workspace.validate());
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);

      const next = await run(Workspace.next());
      expect(next.state).toBe("needs_review");
      expect(next.summary.inboxItems).toBeGreaterThan(0);
      expect(next.nextAction.kind).toBe("edit_file");
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("load normalizes the legacy canonical/archive/quarantine workspace shape", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await Bun.write(
        env.workspacePath,
        `version: 1
snapshotId: snap_legacy
importedAt: 2026-03-06T00:00:00.000Z
targets:
  chrome/default:
    browser: chrome
    profile: default
    path: ${JSON.stringify(env.chromePath)}
inbox: {}
canonical:
  bar:
    - kind: bookmark
      id: legacy_bookmark
      title: Legacy
      url: https://legacy.example
archive:
  menu:
    - kind: bookmark
      id: archived_bookmark
      title: Archived
      url: https://archived.example
quarantine: {}
`,
      );

      const workspace = await run(Workspace.load(env.workspacePath));
      expect(workspace.publish.global.bar?.[0]?.kind).toBe("bookmark");
      expect(workspace.archive.global.menu?.[0]?.kind).toBe("bookmark");
      expect(workspace.quarantine.global).toEqual({});
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("validate reports duplicate ids, missing targets, and unknown source occurrences", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await Bun.write(
        env.workspacePath,
        `version: 1
snapshotId: snap_invalid
importedAt: 2026-03-06T00:00:00.000Z
targets:
  chrome/default:
    browser: chrome
    profile: default
    path: ${JSON.stringify(env.chromePath)}
inbox:
  ghost:
    bar:
      - kind: bookmark
        id: duplicate_node
        title: Ghost
        url: https://ghost.example
        sources: [missing_occurrence]
publish:
  global:
    bar:
      - kind: bookmark
        id: duplicate_node
        title: Publish
        url: https://publish.example
        sources: [missing_occurrence]
  profiles:
    ghost:
      bar:
        - kind: bookmark
          id: another_node
          title: Profile Ghost
          url: https://profile-ghost.example
archive:
  global: {}
  profiles: {}
quarantine:
  global: {}
  profiles: {}
`,
      );
      await Bun.write(
        env.importLockPath,
        JSON.stringify({
          version: 1,
          snapshotId: "snap_invalid",
          importedAt: "2026-03-06T00:00:00.000Z",
          targets: {
            "chrome/default": {
              browser: "chrome",
              profile: "default",
              path: env.chromePath,
              importedAt: "2026-03-06T00:00:00.000Z",
              occurrences: [],
            },
          },
        }),
      );

      const validation = await run(Workspace.validate());
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Inbox target ghost is not present in workspace.targets");
      expect(validation.errors).toContain(
        "Scoped tree target ghost is not present in workspace.targets",
      );
      expect(validation.errors).toContain(
        "Unknown source occurrence missing_occurrence referenced at inbox/ghost/bar/Ghost",
      );
      expect(validation.errors).toContain(
        "Duplicate workspace node id duplicate_node at publish/global/bar/Publish",
      );
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("import backs up existing workspace artifacts before replacing them", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await Bun.write(
        env.workspacePath,
        "version: 1\nsnapshotId: stale\nimportedAt: 2026-03-06T00:00:00.000Z\ntargets: {}\ninbox: {}\npublish:\n  global: {}\n  profiles: {}\narchive:\n  global: {}\n  profiles: {}\nquarantine:\n  global: {}\n  profiles: {}\n",
      );
      await Bun.write(
        env.importLockPath,
        JSON.stringify({
          version: 1,
          snapshotId: "stale",
          importedAt: "2026-03-06T00:00:00.000Z",
          targets: {},
        }),
      );
      await Bun.write(env.publishPlanPath, JSON.stringify({ version: 1 }));

      const imported = await run(Workspace.importState(["chrome/default"]));
      expect(imported.backup).not.toBeNull();
      expect(imported.backup?.files).toHaveLength(3);
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("plan and publish rewrite a curated workspace and then report done", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));

      const workspace = await run(Workspace.load(env.workspacePath));
      const importedNode = workspace.inbox["chrome/default"]?.bar?.[0];
      expect(importedNode?.kind).toBe("bookmark");
      if (importedNode?.kind !== "bookmark") {
        throw new Error("Expected imported bookmark in bar");
      }

      workspace.inbox = {};
      workspace.publish.profiles["chrome/default"] = {
        bar: [
          {
            ...importedNode,
            title: "Curated Link",
          },
        ],
      };

      await run(Workspace.save(env.workspacePath, workspace));

      const plan = await run(Workspace.plan());
      expect(plan.targets).toHaveLength(1);
      expect(plan.blockers).toEqual([]);
      expect(plan.targets[0]?.status).toBe("ready");

      const published = await run(Workspace.publish());
      expect(published.publishedTargets).toEqual(["chrome/default"]);
      expect(published.plan.publishedAt).not.toBeNull();
      expect(published.backup.files).toHaveLength(4);

      const tree = await run(Chrome.readBookmarks(env.chromePath));
      const first = tree.bar?.[0];
      expect(first?.name).toBe("Curated Link");

      const next = await run(Workspace.next());
      expect(next.state).toBe("done");
      expect(next.nextAction.kind).toBe("done");
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("next routes to plan once review is complete but no plan has been generated yet", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));
      const workspace = await run(Workspace.load(env.workspacePath));
      const importedNode = workspace.inbox["chrome/default"]?.bar?.[0];
      if (!importedNode || importedNode.kind !== "bookmark") {
        throw new Error("Expected imported bookmark in bar");
      }

      workspace.inbox = {};
      workspace.publish.profiles["chrome/default"] = {
        bar: [{ ...importedNode, title: "Ready To Plan" }],
      };
      await run(Workspace.save(env.workspacePath, workspace));

      const next = await run(Workspace.next());
      expect(next.state).toBe("needs_plan");
      expect(next.nextAction.kind).toBe("run_command");
      if (next.nextAction.kind === "run_command") {
        expect(next.nextAction.command).toBe("bookmarks plan");
      }
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("next surfaces workspace blockers that require manual edits", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));
      const workspace = await run(Workspace.load(env.workspacePath));
      const importedNode = workspace.inbox["chrome/default"]?.bar?.[0];
      if (!importedNode || importedNode.kind !== "bookmark") {
        throw new Error("Expected imported bookmark in bar");
      }

      workspace.inbox = {};
      workspace.publish.global = {
        bar: [
          { ...importedNode, title: "First Copy", url: "https://dup.example" },
          { ...importedNode, id: "dup_second", title: "Second Copy", url: "https://dup.example" },
        ],
      };
      await run(Workspace.save(env.workspacePath, workspace));

      const next = await run(Workspace.next());
      expect(next.state).toBe("has_blockers");
      expect(next.blockers.some((blocker) => blocker.code === "duplicate-url")).toBe(true);
      expect(next.nextAction.kind).toBe("edit_file");
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("next surfaces validation errors as edit-file blockers", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await Bun.write(
        env.workspacePath,
        `version: 1
snapshotId: snap_invalid
importedAt: 2026-03-06T00:00:00.000Z
targets:
  chrome/default:
    browser: chrome
    profile: default
    path: ${JSON.stringify(env.chromePath)}
inbox:
  chrome/default:
    bar:
      - kind: bookmark
        id: broken_node
        title: Broken
        url: https://broken.example
        sources: [missing_occurrence]
publish:
  global: {}
  profiles: {}
archive:
  global: {}
  profiles: {}
quarantine:
  global: {}
  profiles: {}
`,
      );
      await Bun.write(
        env.importLockPath,
        JSON.stringify({
          version: 1,
          snapshotId: "snap_invalid",
          importedAt: "2026-03-06T00:00:00.000Z",
          targets: {
            "chrome/default": {
              browser: "chrome",
              profile: "default",
              path: env.chromePath,
              importedAt: "2026-03-06T00:00:00.000Z",
              occurrences: [],
            },
          },
        }),
      );

      const next = await run(Workspace.next());
      expect(next.state).toBe("has_blockers");
      expect(next.nextAction.kind).toBe("edit_file");
      expect(next.blockers[0]?.message).toContain("Unknown source occurrence missing_occurrence");
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("publish proceeds even when browsers are reported as running", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));

      const workspace = await run(Workspace.load(env.workspacePath));
      const importedNode = workspace.inbox["chrome/default"]?.bar?.[0];
      expect(importedNode?.kind).toBe("bookmark");
      if (importedNode?.kind !== "bookmark") {
        throw new Error("Expected imported bookmark in bar");
      }

      workspace.inbox = {};
      workspace.publish.profiles["chrome/default"] = {
        bar: [
          {
            ...importedNode,
            title: "Queued Link",
          },
        ],
      };

      await run(Workspace.save(env.workspacePath, workspace));

      process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "Google Chrome";

      const plan = await run(Workspace.plan());
      expect(plan.blockers).toEqual([]);
      expect(plan.targets[0]?.status).toBe("ready");
      expect(plan.targets[0]?.blockers).toEqual([]);

      const published = await run(Workspace.publish());
      expect(published.publishedTargets).toEqual(["chrome/default"]);

      const tree = await run(Chrome.readBookmarks(env.chromePath));
      expect(tree.bar?.[0]?.name).toBe("Queued Link");
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("plan blocks unsupported profile-only sections for Chrome", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));

      const workspace = await run(Workspace.load(env.workspacePath));
      workspace.inbox = {};
      workspace.publish.profiles["chrome/default"] = {
        reading_list: [
          {
            kind: "bookmark",
            id: "manual_chrome_reading_item",
            title: "Should Block",
            url: "https://blocked.example",
          },
        ],
      };

      await run(Workspace.save(env.workspacePath, workspace));

      const plan = await run(Workspace.plan());
      expect(plan.summary.blockerCount).toBe(1);
      expect(plan.targets[0]?.status).toBe("blocked");
      expect(plan.blockers).toContainEqual({
        code: "unsupported-node",
        targetId: "chrome/default",
        location: "publish/profiles/chrome/default/reading_list",
        message: 'Section "reading_list" is not supported for chrome/default.',
      });
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("plan reports unresolved inbox and quarantine review blockers", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));
      const workspace = await run(Workspace.load(env.workspacePath));
      const importedNode = workspace.inbox["chrome/default"]?.bar?.[0];
      if (!importedNode || importedNode.kind !== "bookmark") {
        throw new Error("Expected imported bookmark in bar");
      }

      workspace.quarantine.global = {
        bar: [{ ...importedNode, id: "quarantined_node", title: "Quarantined" }],
      };
      await run(Workspace.save(env.workspacePath, workspace));

      const plan = await run(Workspace.plan());
      expect(plan.blockers).toContainEqual({
        code: "review-inbox",
        message: "1 inbox item(s) remain unresolved.",
      });
      expect(plan.blockers).toContainEqual({
        code: "review-quarantine",
        message: "1 quarantined item(s) remain unresolved.",
      });
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("plan blocks unavailable configured targets", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));
      const workspace = await run(Workspace.load(env.workspacePath));
      const importedNode = workspace.inbox["chrome/default"]?.bar?.[0];
      if (!importedNode || importedNode.kind !== "bookmark") {
        throw new Error("Expected imported bookmark in bar");
      }

      workspace.inbox = {};
      const target = workspace.targets["chrome/default"];
      if (!target) {
        throw new Error("Expected chrome/default target");
      }
      workspace.targets["chrome/default"] = {
        ...target,
        path: join(env.dir, "missing", "Bookmarks"),
      };
      workspace.publish.profiles["chrome/default"] = {
        bar: [{ ...importedNode, title: "Blocked By Missing Target" }],
      };
      await run(Workspace.save(env.workspacePath, workspace));

      const plan = await run(Workspace.plan());
      expect(plan.targets[0]?.status).toBe("blocked");
      expect(plan.blockers).toContainEqual({
        code: "target-unavailable",
        targetId: "chrome/default",
        location: join(env.dir, "missing", "Bookmarks"),
        message: `Configured target is unavailable at ${join(env.dir, "missing", "Bookmarks")}.`,
      });
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("plan fails when the workspace is invalid", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await Bun.write(
        env.workspacePath,
        `version: 1
snapshotId: snap_invalid
importedAt: 2026-03-06T00:00:00.000Z
targets:
  chrome/default:
    browser: chrome
    profile: default
    path: ${JSON.stringify(env.chromePath)}
inbox:
  chrome/default:
    bar:
      - kind: bookmark
        id: broken_node
        title: Broken
        url: https://broken.example
        sources: [missing_occurrence]
publish:
  global: {}
  profiles: {}
archive:
  global: {}
  profiles: {}
quarantine:
  global: {}
  profiles: {}
`,
      );
      await Bun.write(
        env.importLockPath,
        JSON.stringify({
          version: 1,
          snapshotId: "snap_invalid",
          importedAt: "2026-03-06T00:00:00.000Z",
          targets: {
            "chrome/default": {
              browser: "chrome",
              profile: "default",
              path: env.chromePath,
              importedAt: "2026-03-06T00:00:00.000Z",
              occurrences: [],
            },
          },
        }),
      );

      const error = await runError(Workspace.plan());
      expect(error.message).toContain("Unknown source occurrence");
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("plan blocks separators and raw nodes in the publish tree", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));
      const workspace = await run(Workspace.load(env.workspacePath));
      workspace.inbox = {};
      workspace.publish.global = {
        bar: [
          {
            kind: "separator",
            id: "separator_node",
          },
          {
            kind: "raw",
            id: "raw_node",
            title: "Raw",
            nativeKinds: ["mystery"],
          },
        ],
      };
      await run(Workspace.save(env.workspacePath, workspace));

      const plan = await run(Workspace.plan());
      expect(plan.blockers.map((blocker) => blocker.code)).toEqual([
        "unsupported-node",
        "unsupported-node",
      ]);
      expect(plan.targets[0]?.status).toBe("blocked");
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("plan converts published folders into bookmark-tree folders", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));
      const workspace = await run(Workspace.load(env.workspacePath));
      workspace.inbox = {};
      workspace.publish.global = {
        bar: [
          {
            kind: "folder",
            id: "folder_node",
            title: "Projects",
            children: [
              {
                kind: "bookmark",
                id: "child_bookmark",
                title: "Docs",
                url: "https://docs.example",
              },
            ],
          },
        ],
      };
      await run(Workspace.save(env.workspacePath, workspace));

      const plan = await run(Workspace.plan());
      expect(plan.blockers).toEqual([]);
      expect(plan.targets[0]?.status).toBe("ready");
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("next routes environment blockers back to planning commands", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));
      const workspace = await run(Workspace.load(env.workspacePath));
      const importedNode = workspace.inbox["chrome/default"]?.bar?.[0];
      if (!importedNode || importedNode.kind !== "bookmark") {
        throw new Error("Expected imported bookmark in bar");
      }

      workspace.inbox = {};
      const target = workspace.targets["chrome/default"];
      if (!target) {
        throw new Error("Expected chrome/default target");
      }
      workspace.targets["chrome/default"] = {
        ...target,
        path: join(env.dir, "missing", "Bookmarks"),
      };
      workspace.publish.profiles["chrome/default"] = {
        bar: [{ ...importedNode, title: "Blocked" }],
      };
      await run(Workspace.save(env.workspacePath, workspace));

      const next = await run(Workspace.next());
      expect(next.state).toBe("has_blockers");
      expect(next.nextAction.kind).toBe("run_command");
      if (next.nextAction.kind === "run_command") {
        expect(next.nextAction.command).toBe("bookmarks plan --json");
      }
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("plan reports Safari permission blockers when Full Disk Access is unavailable", async () => {
    const env = await setupWorkspaceEnv(undefined, { safariFixture: true });

    try {
      process.env["BOOKMARKS_FORCE_FULL_DISK_ACCESS"] = "false";
      await run(Workspace.importState(["safari"]));

      const workspace = await run(Workspace.load(env.workspacePath));
      const importedNode = workspace.inbox["safari"]?.bar?.find((node) => node.kind === "bookmark");
      if (!importedNode) {
        throw new Error("Expected imported Safari bookmark");
      }

      workspace.inbox = {};
      workspace.publish.global = {
        bar: [{ ...importedNode, title: "Safari Publish" }],
      };
      await run(Workspace.save(env.workspacePath, workspace));

      const plan = await run(Workspace.plan());
      expect(plan.targets[0]?.status).toBe("blocked");
      expect(plan.blockers).toContainEqual({
        code: "permission-denied",
        targetId: "safari",
        location: env.safariPath,
        message: "Full Disk Access is required for safari.",
      });
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("publish projects global reading_list to Safari only", async () => {
    const env = await setupWorkspaceEnv(undefined, { safariFixture: true });

    try {
      const imported = await run(Workspace.importState([]));
      expect(imported.targets).toEqual(["safari", "chrome/default"]);

      const workspace = await run(Workspace.load(env.workspacePath));
      const safariReadingNode = workspace.inbox["safari"]?.reading_list?.find(
        (node) => node.kind === "bookmark",
      );
      const chromeBarNode = workspace.inbox["chrome/default"]?.bar?.find(
        (node) => node.kind === "bookmark",
      );

      if (!safariReadingNode || !chromeBarNode) {
        throw new Error("Expected Safari reading list and Chrome bar bookmarks");
      }

      workspace.inbox = {};
      workspace.publish.global = {
        reading_list: [{ ...safariReadingNode, title: "Global Reading Item" }],
      };
      workspace.publish.profiles["chrome/default"] = {
        bar: [{ ...chromeBarNode, title: "Chrome Local Link" }],
      };

      await run(Workspace.save(env.workspacePath, workspace));

      const plan = await run(Workspace.plan());
      expect(plan.blockers).toEqual([]);
      expect(plan.targets.map((target) => target.status)).toEqual(["ready", "ready"]);

      const published = await run(Workspace.publish());
      expect(published.publishedTargets).toEqual(["safari", "chrome/default"]);

      const chromeTree = await run(Chrome.readBookmarks(env.chromePath));
      expect(chromeTree.reading_list).toBeUndefined();
      expect(chromeTree.bar?.map((node) => node.name)).toEqual(["Chrome Local Link"]);

      const safariTree = await run(Safari.readBookmarks(env.safariPath));
      expect(safariTree.reading_list?.map((node) => node.name)).toContain("Global Reading Item");
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("next reports ready_to_publish when a fresh unpublished plan already exists", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));
      const workspace = await run(Workspace.load(env.workspacePath));
      const importedNode = workspace.inbox["chrome/default"]?.bar?.[0];
      if (!importedNode || importedNode.kind !== "bookmark") {
        throw new Error("Expected imported bookmark in bar");
      }

      workspace.inbox = {};
      workspace.publish.profiles["chrome/default"] = {
        bar: [{ ...importedNode, title: "Ready" }],
      };
      await run(Workspace.save(env.workspacePath, workspace));
      await run(Workspace.plan());

      const next = await run(Workspace.next());
      expect(next.state).toBe("ready_to_publish");
      expect(next.nextAction.kind).toBe("run_command");
      if (next.nextAction.kind === "run_command") {
        expect(next.nextAction.command).toBe("bookmarks publish");
      }
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("import without selectors discovers all profiles and only global bookmarks span profiles", async () => {
    const env = await setupWorkspaceEnv([
      { directory: "Default", title: "Shared Candidate", url: "https://shared.example" },
      { directory: "Profile 1", title: "Work Link", url: "https://work.example" },
    ]);

    try {
      const imported = await run(Workspace.importState([]));
      expect(imported.targets).toEqual(["chrome/default", "chrome/profile-1"]);

      const workspace = await run(Workspace.load(env.workspacePath));
      const sharedNode = workspace.inbox["chrome/default"]?.bar?.[0];
      const workNode = workspace.inbox["chrome/profile-1"]?.bar?.[0];

      expect(sharedNode?.kind).toBe("bookmark");
      expect(workNode?.kind).toBe("bookmark");
      if (sharedNode?.kind !== "bookmark" || !workNode || workNode.kind !== "bookmark") {
        throw new Error("Expected imported bookmarks for both Chrome profiles");
      }

      workspace.inbox = {};
      workspace.publish.global = {
        bar: [{ ...sharedNode, title: "Shared Everywhere" }],
      };
      workspace.publish.profiles["chrome/profile-1"] = {
        bar: [{ ...workNode, title: "Profile One Only" }],
      };

      await run(Workspace.save(env.workspacePath, workspace));

      const plan = await run(Workspace.plan());
      expect(plan.blockers).toEqual([]);
      const published = await run(Workspace.publish());
      expect(published.publishedTargets).toEqual(["chrome/default", "chrome/profile-1"]);

      const defaultTree = await run(
        Chrome.readBookmarks(join(env.chromeDataDir, "Default", "Bookmarks")),
      );
      expect(defaultTree.bar?.map((node) => node.name)).toEqual(["Shared Everywhere"]);

      const profileTree = await run(
        Chrome.readBookmarks(join(env.chromeDataDir, "Profile 1", "Bookmarks")),
      );
      expect(profileTree.bar?.map((node) => node.name)).toEqual([
        "Shared Everywhere",
        "Profile One Only",
      ]);
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("import fails clearly when no bookmark targets are discovered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-workspace-empty-"));

    try {
      process.env["BOOKMARKS_YAML_PATH"] = join(dir, "bookmarks.yaml");
      process.env["BOOKMARKS_WORKSPACE_PATH"] = join(dir, "workspace.yaml");
      process.env["BOOKMARKS_IMPORT_LOCK_PATH"] = join(dir, "import.lock.json");
      process.env["BOOKMARKS_PUBLISH_PLAN_PATH"] = join(dir, "publish.plan.json");
      process.env["BOOKMARKS_BACKUP_DIR"] = join(dir, "backups");
      process.env["BOOKMARKS_RUNTIME_DIR"] = join(dir, "runtime");
      process.env["BOOKMARKS_SAFARI_PLIST_PATH"] = join(dir, "Safari", "Missing-Bookmarks.plist");
      process.env["BOOKMARKS_SAFARI_TABS_DB_PATH"] = join(dir, "Safari", "Missing-SafariTabs.db");
      process.env["BOOKMARKS_CHROME_DATA_DIR"] = join(dir, "Chrome");

      const error = await runError(Workspace.importState([]));
      expect(error.message).toContain("No bookmark targets were discovered");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("import fails when bookmarks.yaml configures an undiscovered Chrome profile", async () => {
    const env = await setupWorkspaceEnv();

    try {
      const config = BookmarksConfig.make({
        all: new BookmarkTree({}),
        chrome: ChromeBookmarks.make({
          profiles: {
            work: ChromeProfileBookmarks.make({}),
          },
        }),
      });
      await run(YamlModule.save(env.yamlPath, config));

      const error = await runError(Workspace.importState([]));
      expect(error.message).toContain(
        'Configured Chrome profile "work" was not discovered on this machine.',
      );
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("import fails when an explicitly requested target is disabled in bookmarks.yaml", async () => {
    const env = await setupWorkspaceEnv();

    try {
      const config = BookmarksConfig.make({
        all: new BookmarkTree({}),
        chrome: ChromeBookmarks.make({
          enabled: false,
          profiles: {
            default: ChromeProfileBookmarks.make({}),
          },
        }),
      });
      await run(YamlModule.save(env.yamlPath, config));

      const error = await runError(Workspace.importState(["chrome/default"]));
      expect(error.message).toContain("Requested target(s) are disabled: chrome/default.");
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("publish fails when the workspace is invalid", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await Bun.write(
        env.workspacePath,
        `version: 1
snapshotId: snap_invalid
importedAt: 2026-03-06T00:00:00.000Z
targets:
  chrome/default:
    browser: chrome
    profile: default
    path: ${JSON.stringify(env.chromePath)}
inbox:
  chrome/default:
    bar:
      - kind: bookmark
        id: broken_node
        title: Broken
        url: https://broken.example
        sources: [missing_occurrence]
publish:
  global: {}
  profiles: {}
archive:
  global: {}
  profiles: {}
quarantine:
  global: {}
  profiles: {}
`,
      );
      await Bun.write(
        env.importLockPath,
        JSON.stringify({
          version: 1,
          snapshotId: "snap_invalid",
          importedAt: "2026-03-06T00:00:00.000Z",
          targets: {
            "chrome/default": {
              browser: "chrome",
              profile: "default",
              path: env.chromePath,
              importedAt: "2026-03-06T00:00:00.000Z",
              occurrences: [],
            },
          },
        }),
      );

      const error = await runError(Workspace.publish());
      expect(error.message).toContain("Unknown source occurrence");
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });

  test("publish fails when plan blockers remain", async () => {
    const env = await setupWorkspaceEnv();

    try {
      await run(Workspace.importState(["chrome/default"]));
      const workspace = await run(Workspace.load(env.workspacePath));
      const importedNode = workspace.inbox["chrome/default"]?.bar?.[0];
      if (!importedNode || importedNode.kind !== "bookmark") {
        throw new Error("Expected imported bookmark in bar");
      }

      workspace.inbox = {};
      workspace.publish.global = {
        bar: [
          { ...importedNode, title: "First Copy", url: "https://dup.example" },
          { ...importedNode, id: "dup_blocked", title: "Second Copy", url: "https://dup.example" },
        ],
      };
      await run(Workspace.save(env.workspacePath, workspace));

      const error = await runError(Workspace.publish());
      expect(error.message).toContain('Duplicate URL "https://dup.example"');
    } finally {
      await rm(env.dir, { recursive: true, force: true });
    }
  });
});
