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
  "BOOKMARKS_WORKSPACE_PUBLISH_QUEUE_PATH",
  "BOOKMARKS_BACKUP_DIR",
  "BOOKMARKS_RUNTIME_DIR",
  "BOOKMARKS_SAFARI_PLIST_PATH",
  "BOOKMARKS_SAFARI_TABS_DB_PATH",
  "BOOKMARKS_CHROME_DATA_DIR",
  "BOOKMARKS_FORCE_BROWSER_RUNNING",
] as const;

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);

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
  test("next routes to import when no workspace exists", async () => {
    const env = await setupWorkspaceEnv();

    try {
      const result = await run(Workspace.next());
      expect(result.state).toBe("needs_import");
      expect(result.nextAction.kind).toBe("run_command");
      if (result.nextAction.kind === "run_command") {
        expect(result.nextAction.command).toBe("bookmarks import");
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
});
