import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serialize } from "@plist/binary.serialize";
import { Effect, Layer, Schema } from "effect";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Chrome from "./chrome.ts";
import { NativeRequestSchema } from "./chrome-native-protocol.ts";
import { ChromeBridgeRuntime } from "./chrome-native-runtime.ts";
import * as Safari from "./safari.ts";
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
import * as Sync from "./sync.ts";
import * as Targets from "./targets.ts";
import * as YamlModule from "./yaml.ts";

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);
const leaf = (name: string, url = `https://${name.toLowerCase()}.example/`) =>
  BookmarkLeaf.make({ name, url });
const folder = (name: string, children: readonly BookmarkNode[]) =>
  BookmarkFolder.make({ name, children });
const names = (nodes: readonly BookmarkNode[] | undefined) => nodes?.map((node) => node.name);

type PlistNode = { [key: string]: string | PlistNode | PlistNode[] };

const plistNode = (node: BookmarkNode): PlistNode =>
  BookmarkLeaf.is(node)
    ? {
        WebBookmarkType: "WebBookmarkTypeLeaf",
        URLString: node.url,
        URIDictionary: { title: node.name },
      }
    : {
        WebBookmarkType: "WebBookmarkTypeList",
        Title: node.name,
        Children: node.children.map(plistNode),
      };

const writeSafari = async (path: string, tree: BookmarkTree): Promise<void> => {
  const section = (title: string, nodes: readonly BookmarkNode[] | undefined) => ({
    WebBookmarkType: "WebBookmarkTypeList",
    Title: title,
    Children: (nodes ?? []).map(plistNode),
  });
  await Bun.write(
    path,
    serialize({
      Children: [
        section("BookmarksBar", tree.bar),
        section("BookmarksMenu", tree.menu),
        section("com.apple.ReadingList", tree.reading_list),
      ],
    }),
  );
};

const emptyChromeFile = JSON.stringify({
  checksum: "",
  version: 1,
  roots: {
    bookmark_bar: {
      type: "folder",
      name: "Bookmarks Bar",
      id: "1",
      guid: "bar",
      date_added: "0",
      date_modified: "0",
      children: [],
    },
    other: {
      type: "folder",
      name: "Other Bookmarks",
      id: "2",
      guid: "other",
      date_added: "0",
      date_modified: "0",
      children: [],
    },
    synced: {
      type: "folder",
      name: "Mobile Bookmarks",
      id: "3",
      guid: "mobile",
      date_added: "0",
      date_modified: "0",
      children: [],
    },
  },
});

const ENV_KEYS = [
  "BOOKMARKS_BACKUP_DIR",
  "BOOKMARKS_CHROME_DATA_DIR",
  "BOOKMARKS_RUNTIME_DIR",
  "BOOKMARKS_SAFARI_PLIST_PATH",
  "BOOKMARKS_SYNC_BASELINE_PATH",
] as const;

interface World {
  readonly dir: string;
  readonly yamlPath: string;
  readonly chromePath: string;
  readonly safariPath: string;
}

let world: World;
let originalEnv: Record<string, string | undefined>;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "bookmarks-sync-browsers-"));
  const chromeDataDir = join(dir, "Chrome");
  originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env["BOOKMARKS_BACKUP_DIR"] = join(dir, "backups");
  process.env["BOOKMARKS_CHROME_DATA_DIR"] = chromeDataDir;
  process.env["BOOKMARKS_RUNTIME_DIR"] = join(dir, "runtime");
  process.env["BOOKMARKS_SAFARI_PLIST_PATH"] = join(dir, "Safari", "Bookmarks.plist");
  process.env["BOOKMARKS_SYNC_BASELINE_PATH"] = join(dir, "state", "sync-baselines.json");
  await mkdir(join(chromeDataDir, "Default"), { recursive: true });
  await mkdir(join(dir, "Safari"), { recursive: true });
  await writeFile(
    join(chromeDataDir, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: {} } } }),
  );
  await writeFile(join(chromeDataDir, "Default", "Bookmarks"), emptyChromeFile);
  world = {
    dir,
    yamlPath: join(dir, "bookmarks.yaml"),
    chromePath: join(chromeDataDir, "Default", "Bookmarks"),
    safariPath: join(dir, "Safari", "Bookmarks.plist"),
  };
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(world.dir, { recursive: true, force: true });
});

const sharedConfig = (all: BookmarkTree) =>
  BookmarksConfig.make({
    all,
    chrome: ChromeBookmarks.make({ profiles: { default: ChromeProfileBookmarks.make({}) } }),
  });

const readChrome = () =>
  run(
    Targets.readTree({
      browser: "chrome",
      profile: "default",
      path: world.chromePath,
      enabled: true,
    }),
  );
const readSafari = () => run(Safari.readBookmarks(world.safariPath));
const readYaml = () => run(YamlModule.load(world.yamlPath));
const syncNow = () => run(Sync.sync({ yamlPath: world.yamlPath }));

describe("sync across browsers", () => {
  test("an edit in Chrome to a shared folder reaches Safari and stays in the shared bar", async () => {
    const start = BookmarkTree.make({ bar: [folder("Build", [leaf("A")])] });
    await run(YamlModule.save(world.yamlPath, sharedConfig(start)));
    await writeSafari(world.safariPath, start);
    await run(Chrome.writeTree(world.chromePath, start));
    await syncNow();

    await run(
      Chrome.writeTree(
        world.chromePath,
        BookmarkTree.make({ bar: [folder("Build", [leaf("A"), leaf("B")])] }),
      ),
    );
    const result = await syncNow();

    expect(result.yamlChanged).toBe(true);
    const yaml = await readYaml();
    expect(yaml.all.bar).toEqual([folder("Build", [leaf("A"), leaf("B")])]);
    expect(yaml.safari?.bar).toBeUndefined();
    expect(yaml.chrome?.bar).toBeUndefined();
    expect((await readSafari()).bar).toEqual([folder("Build", [leaf("A"), leaf("B")])]);

    const settled = await syncNow();
    expect(settled.yamlChanged).toBe(false);
    expect(settled.applied).toEqual([]);
    expect(settled.backup).toBeUndefined();
  });

  test("a shared folder renamed in Safari keeps its bookmarks in Chrome, beside a Safari-only folder", async () => {
    await run(
      YamlModule.save(
        world.yamlPath,
        BookmarksConfig.make({
          all: BookmarkTree.make({ bar: [folder("Shared", [leaf("A")])] }),
          safari: SafariBookmarks.make({ bar: [folder("Local", [leaf("B")])] }),
          chrome: ChromeBookmarks.make({ profiles: { default: ChromeProfileBookmarks.make({}) } }),
        }),
      ),
    );
    await writeSafari(
      world.safariPath,
      BookmarkTree.make({ bar: [folder("Shared", [leaf("A")]), folder("Local", [leaf("B")])] }),
    );
    await run(
      Chrome.writeTree(
        world.chromePath,
        BookmarkTree.make({ bar: [folder("Shared", [leaf("A")])] }),
      ),
    );
    await syncNow();

    await writeSafari(
      world.safariPath,
      BookmarkTree.make({ bar: [folder("Renamed", [leaf("A")]), folder("Local", [leaf("B")])] }),
    );
    await syncNow();

    expect((await readChrome()).bar).toEqual([folder("Renamed", [leaf("A")])]);
    const yaml = await readYaml();
    expect(yaml.all.bar).toEqual([folder("Renamed", [leaf("A")])]);
    expect(yaml.safari?.bar).toEqual([folder("Local", [leaf("B")])]);
  });

  test("a shared folder renamed in Safari reaches Chrome when the YAML has only the shared layer", async () => {
    const start = BookmarkTree.make({ bar: [folder("Shared", [leaf("A")])] });
    await run(YamlModule.save(world.yamlPath, sharedConfig(start)));
    await writeSafari(world.safariPath, start);
    await run(Chrome.writeTree(world.chromePath, start));
    await syncNow();

    await writeSafari(
      world.safariPath,
      BookmarkTree.make({ bar: [folder("Renamed", [leaf("A")])] }),
    );
    await syncNow();

    expect((await readChrome()).bar).toEqual([folder("Renamed", [leaf("A")])]);
    expect((await readYaml()).all.bar).toEqual([folder("Renamed", [leaf("A")])]);
  });

  test("a deletion in Safari reaches Chrome", async () => {
    const start = BookmarkTree.make({ bar: [leaf("Keep"), leaf("Drop")] });
    await run(YamlModule.save(world.yamlPath, sharedConfig(start)));
    await writeSafari(world.safariPath, start);
    await run(Chrome.writeTree(world.chromePath, start));
    await syncNow();

    await writeSafari(world.safariPath, BookmarkTree.make({ bar: [leaf("Keep")] }));
    await syncNow();

    expect(names((await readYaml()).all.bar)).toEqual(["Keep"]);
    expect(names((await readChrome()).bar)).toEqual(["Keep"]);
  });

  test("a YAML edit committed to git before any browser saw it is added, not deleted", async () => {
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: world.dir });
    git("init", "-b", "main");
    git("config", "user.name", "Bookmarks Test");
    git("config", "user.email", "bookmarks-test@example.com");
    const start = BookmarkTree.make({ bar: [leaf("A")] });
    await run(YamlModule.save(world.yamlPath, sharedConfig(start)));
    await run(Chrome.writeTree(world.chromePath, start));
    await syncNow();

    await run(
      YamlModule.save(
        world.yamlPath,
        sharedConfig(BookmarkTree.make({ bar: [leaf("A"), leaf("B")] })),
      ),
    );
    git("commit", "-am", "an agent's YAML edit");
    await syncNow();

    expect(names((await readChrome()).bar)).toEqual(["A", "B"]);
    expect(names((await readYaml()).all.bar)).toEqual(["A", "B"]);
  });

  test("a bookmarklet and a multi-line title compare equal across Safari and Chrome", async () => {
    const typed =
      "javascript:location='https://pinboard.in/add?url='+encodeURIComponent(location.href)";
    const stored =
      "javascript:location='https://pinboard.in/add?url=%27+encodeURIComponent(location.href)";
    await run(YamlModule.save(world.yamlPath, sharedConfig(BookmarkTree.make({}))));
    await writeSafari(
      world.safariPath,
      BookmarkTree.make({ bar: [leaf("Pin", typed)], reading_list: [leaf("Dan\n818 likes")] }),
    );
    await run(
      Chrome.writeTree(world.chromePath, BookmarkTree.make({ bar: [leaf("Pin", stored)] })),
    );

    await syncNow();

    const yaml = await readYaml();
    expect(yaml.all.bar).toEqual([leaf("Pin", stored)]);
    expect(yaml.safari).toBeUndefined();
    expect(yaml.chrome?.bar).toBeUndefined();
    expect(names(yaml.all.reading_list)).toEqual(["Dan 818 likes"]);
    const status = await run(Sync.status({ yamlPath: world.yamlPath }));
    for (const target of status.targets) {
      expect(target.yamlPatches).toEqual([]);
      expect(target.browserPatches).toEqual([]);
    }
  });

  test("Chrome keeps the shared reading list in Other Bookmarks, both ways", async () => {
    await run(
      YamlModule.save(
        world.yamlPath,
        sharedConfig(
          BookmarkTree.make({ menu: [leaf("Menu Item")], reading_list: [leaf("First")] }),
        ),
      ),
    );
    await writeSafari(world.safariPath, BookmarkTree.make({}));
    await syncNow();

    const native = await run(Chrome.readBookmarks(world.chromePath));
    expect(native.menu).toEqual([
      leaf("Menu Item"),
      folder(Targets.CHROME_READING_LIST_FOLDER, [leaf("First")]),
    ]);
    expect(names((await readSafari()).reading_list)).toEqual(["First"]);

    await run(
      Chrome.writeTree(
        world.chromePath,
        BookmarkTree.make({
          menu: [
            folder(Targets.CHROME_READING_LIST_FOLDER, [leaf("First"), leaf("Second")]),
            leaf("Menu Item"),
          ],
        }),
      ),
    );
    await syncNow();

    expect(names((await readYaml()).all.reading_list)).toEqual(["First", "Second"]);
    expect(names((await readYaml()).all.menu)).toEqual(["Menu Item"]);
    expect(names((await readSafari()).reading_list)).toEqual(["First", "Second"]);
    // The folder keeps the place Jason gave it in Chrome.
    expect(names((await run(Chrome.readBookmarks(world.chromePath))).menu)).toEqual([
      Targets.CHROME_READING_LIST_FOLDER,
      "Menu Item",
    ]);
  });

  test("a YAML addition survives a structural change made in the browser", async () => {
    const start = BookmarkTree.make({ bar: [leaf("A")] });
    await run(YamlModule.save(world.yamlPath, sharedConfig(start)));
    await run(Chrome.writeTree(world.chromePath, start));
    await syncNow();

    await run(
      Chrome.writeTree(
        world.chromePath,
        BookmarkTree.make({ bar: [folder("Empty", []), leaf("A")] }),
      ),
    );
    await run(
      YamlModule.save(
        world.yamlPath,
        sharedConfig(BookmarkTree.make({ bar: [leaf("A"), leaf("B")] })),
      ),
    );
    await syncNow();

    expect(names((await readChrome()).bar)).toEqual(["Empty", "A", "B"]);
    expect(names((await readYaml()).all.bar)).toEqual(["Empty", "A", "B"]);
  });

  test("a YAML edit made while a sync runs is never overwritten", async () => {
    await run(
      YamlModule.save(world.yamlPath, sharedConfig(BookmarkTree.make({ bar: [leaf("A")] }))),
    );
    let liveTree = BookmarkTree.make({ bar: [leaf("Browser")], menu: [], mobile: [] });
    const layer = Layer.succeed(ChromeBridgeRuntime, {
      loadBindings: Effect.succeed([{ profilePath: world.chromePath, instanceId: "instance" }]),
      saveBindings: () => Effect.die("Unexpected binding write"),
      instances: Effect.succeed(["instance"]),
      request: (_id, request) =>
        Effect.promise(async () => {
          const decoded = Schema.decodeUnknownSync(NativeRequestSchema)(request);
          // Someone edits the YAML while the sync reads Chrome.
          await appendFile(world.yamlPath, "# an edit made during the sync\n");
          if (decoded.operation === "reconcile") liveTree = decoded.tree;
          return { id: decoded.id, ok: true as const, value: liveTree };
        }),
      launch: () => Effect.die("Unexpected browser launch"),
    });

    const error = await Effect.runPromise(
      Effect.flip(Sync.sync({ yamlPath: world.yamlPath }).pipe(Effect.provide(layer))),
    );

    expect(error.message).toContain("bookmarks.yaml changed while the sync ran");
    expect(names(liveTree.bar)).toEqual(["Browser"]);
    expect(await readFile(world.yamlPath, "utf-8")).toContain("# an edit made during the sync");
    expect(await Bun.file(process.env["BOOKMARKS_SYNC_BASELINE_PATH"] ?? "").exists()).toBe(false);
  });
});
