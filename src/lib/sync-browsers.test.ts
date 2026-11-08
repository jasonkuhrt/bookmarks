import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serialize } from "@plist/binary.serialize";
import { Effect, Layer, Schema } from "effect";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../scripts/migrate-reading-list.ts";
import * as Baseline from "./baseline.ts";
import * as ReadingList from "./reading-list.ts";
import * as Chrome from "./chrome.ts";
import * as Fingerprint from "./fingerprint.ts";
import { stripManagedConfigHeader } from "./managed-config-header.ts";
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
  TargetState,
  SharedBookmarks,
  ReadingListItem,
} from "./schema/__.ts";
import * as Sync from "./sync.ts";
import * as Targets from "./targets.ts";
import * as YamlModule from "./yaml.ts";

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);
const leaf = (name: string, url = `https://${name.toLowerCase()}.example/`) =>
  BookmarkLeaf.make({ name, url });
const folder = (name: string, children: readonly BookmarkNode[]) =>
  BookmarkFolder.make({ name, children });
const names = (nodes: readonly { readonly name: string }[] | undefined) =>
  nodes?.map((node) => node.name);

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
        section("com.apple.ReadingList", []),
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
const syncNowEffect = () => Sync.sync({ yamlPath: world.yamlPath });
const syncNow = () => run(syncNowEffect());

/**
 * Chrome paired through a stand-in for its extension, holding `start` live. `onRequest` runs
 * before each request the sync makes, and fails it by returning an error.
 */
const pairedChrome = (
  start: BookmarkTree,
  onRequest: (operation: "snapshot" | "reconcile") => Error | undefined = () => undefined,
  initialReadingList: readonly ReadingListItem[] = [],
) => {
  let liveList = initialReadingList;
  let live = BookmarkTree.make({ bar: start.bar ?? [], menu: start.menu ?? [], mobile: [] });
  const layer = Layer.succeed(ChromeBridgeRuntime, {
    loadBindings: Effect.succeed([
      { profilePath: world.chromePath, instanceId: "12345678-1234-1234-1234-123456789abc" },
    ]),
    saveBindings: () => Effect.die("Unexpected binding write"),
    instances: Effect.succeed(["12345678-1234-1234-1234-123456789abc"]),
    request: (_id, request) =>
      Effect.suspend(() => {
        const decoded = Schema.decodeUnknownSync(NativeRequestSchema)(request);
        const failure = onRequest(decoded.operation);
        if (failure) return Effect.fail(failure);
        if (decoded.operation === "reconcile") {
          expect(ReadingList.equal(decoded.expectedReadingList, liveList)).toBe(true);
          live = decoded.tree;
          liveList = decoded.readingList;
        }
        return Effect.succeed({
          id: decoded.id,
          ok: true as const,
          value: TargetState.make({ tree: live, readingList: liveList }),
          version: 2,
          hostVersion: 2,
          capabilities: ["readingList"],
        });
      }),
    launch: () => Effect.die("Unexpected browser launch"),
  });
  return {
    layer,
    live: () => live,
    readingList: () => liveList,
    setReadingList: (items: readonly ReadingListItem[]) => {
      liveList = items;
    },
  };
};

const syncThrough = (layer: Layer.Layer<never>) =>
  Sync.sync({ yamlPath: world.yamlPath }).pipe(Effect.provide(layer));

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
    await writeSafari(world.safariPath, BookmarkTree.make({ bar: [leaf("Pin", typed)] }));
    await run(
      Chrome.writeTree(world.chromePath, BookmarkTree.make({ bar: [leaf("Pin", stored)] })),
    );

    await syncNow();

    const yaml = await readYaml();
    expect(yaml.all.bar).toEqual([leaf("Pin", stored)]);
    expect(yaml.safari).toBeUndefined();
    expect(yaml.chrome?.bar).toBeUndefined();
    const status = await run(Sync.status({ yamlPath: world.yamlPath }));
    for (const target of status.targets) {
      expect(target.yamlPatches).toEqual([]);
      expect(target.browserPatches).toEqual([]);
    }
  });

  test("Read Later is now an ordinary bookmark folder", async () => {
    const all = BookmarkTree.make({ menu: [folder("Read Later", [leaf("A")])] });
    await run(YamlModule.save(world.yamlPath, sharedConfig(all)));
    await writeSafari(world.safariPath, BookmarkTree.make({}));
    await syncNow();
    expect((await readChrome()).menu).toEqual(all.menu);
    expect((await readSafari()).menu).toEqual(all.menu);
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

  test("a sync that fails after writing one browser leaves no baseline that duplicates a replaced bookmark", async () => {
    const docs = (host: string) => leaf("Docs", `https://${host}/`);
    const yamlWith = (host: string) =>
      run(YamlModule.save(world.yamlPath, sharedConfig(BookmarkTree.make({ bar: [docs(host)] }))));
    const start = BookmarkTree.make({ bar: [docs("old.example")] });
    await yamlWith("old.example");
    await writeSafari(world.safariPath, start);
    let chromeFails = false;
    const chrome = pairedChrome(start, (operation) =>
      chromeFails && operation === "reconcile" ? new Error("Chrome closed mid-write") : undefined,
    );
    await run(syncThrough(chrome.layer));

    await yamlWith("new.example");
    chromeFails = true;
    const failure = await Effect.runPromise(Effect.flip(syncThrough(chrome.layer)));
    expect(failure.message).toContain("Chrome closed mid-write");
    expect((await readSafari()).bar).toEqual([docs("new.example")]);

    chromeFails = false;
    await yamlWith("corrected.example");
    await run(syncThrough(chrome.layer));

    expect((await readYaml()).all.bar).toEqual([docs("corrected.example")]);
    expect((await readSafari()).bar).toEqual([docs("corrected.example")]);
    expect(chrome.live().bar).toEqual([docs("corrected.example")]);
  });

  test("Safari opened while a sync plans is left unwritten, so its save of the tree it loaded deletes nothing", async () => {
    const start = BookmarkTree.make({ bar: [leaf("A")] });
    await run(YamlModule.save(world.yamlPath, sharedConfig(start)));
    await writeSafari(world.safariPath, start);
    let safariOpensNow = false;
    const chrome = pairedChrome(start, () => {
      if (safariOpensNow) process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "Safari";
      return undefined;
    });
    try {
      await run(syncThrough(chrome.layer));
      await run(
        YamlModule.save(
          world.yamlPath,
          sharedConfig(BookmarkTree.make({ bar: [leaf("A"), leaf("B")] })),
        ),
      );

      // Safari opens while the sync reads Chrome, and loads its file as it is.
      safariOpensNow = true;
      const open = await run(syncThrough(chrome.layer));
      expect(open.waiting?.map((waiting) => waiting.browser)).toEqual(["Safari"]);
      expect(names((await readSafari()).bar)).toEqual(["A"]);

      // Safari saves the tree it loaded, then quits.
      safariOpensNow = false;
      await writeSafari(world.safariPath, start);
      process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "";
      await run(syncThrough(chrome.layer));

      expect(names((await readYaml()).all.bar)).toEqual(["A", "B"]);
      expect(names((await readSafari()).bar)).toEqual(["A", "B"]);
      expect(names(chrome.live().bar)).toEqual(["A", "B"]);
    } finally {
      process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "";
    }
  });

  test("a restore from the YAML stops before writing Safari once Safari opens", async () => {
    const start = BookmarkTree.make({ bar: [leaf("A")] });
    await run(
      YamlModule.save(
        world.yamlPath,
        sharedConfig(BookmarkTree.make({ bar: [leaf("A"), leaf("B")] })),
      ),
    );
    await writeSafari(world.safariPath, start);
    const chrome = pairedChrome(start, () => {
      process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "Safari";
      return undefined;
    });
    try {
      const failure = await Effect.runPromise(
        Effect.flip(Sync.push({ yamlPath: world.yamlPath }).pipe(Effect.provide(chrome.layer))),
      );

      expect(failure.message).toContain("Safari is currently running");
      expect(names((await readSafari()).bar)).toEqual(["A"]);
    } finally {
      process.env["BOOKMARKS_FORCE_BROWSER_RUNNING"] = "";
    }
  });

  test("a sync's snapshot holds what every file it covered now holds", async () => {
    const safari = { browser: "safari", path: world.safariPath } as const;
    const chrome = { browser: "chrome", profile: "default", path: world.chromePath } as const;
    const fileFingerprints = async () => ({
      [world.yamlPath]: Fingerprint.ofText(
        stripManagedConfigHeader(await readFile(world.yamlPath, "utf-8")),
      ),
      [world.safariPath]: Fingerprint.ofState(await run(Safari.readState(safari.path))),
      [world.chromePath]: Fingerprint.ofTree(await run(Targets.readFileTree(chrome))),
    });
    const start = BookmarkTree.make({
      bar: [leaf("A")],
      menu: [leaf("Menu Item")],
    });
    await run(YamlModule.save(world.yamlPath, sharedConfig(start)));
    await writeSafari(world.safariPath, start);
    await syncNow();

    // Chrome's edit reaches the YAML and Safari, so the sync writes all three files.
    await run(
      Chrome.writeTree(
        world.chromePath,
        BookmarkTree.make({ bar: [leaf("A"), leaf("B")], menu: start.menu }),
      ),
    );
    const result = await syncNow();

    expect(result.yamlChanged).toBe(true);
    const snapshot = new Map(
      (result.snapshot?.files ?? []).map((file) => [file.path, file.fingerprints]),
    );
    for (const [path, fingerprint] of Object.entries(await fileFingerprints())) {
      expect(snapshot.get(path)).toContain(fingerprint);
    }
  });

  test("a paired Chrome's snapshot holds what its file held before the sync read it live", async () => {
    const start = BookmarkTree.make({ bar: [leaf("A")] });
    await run(YamlModule.save(world.yamlPath, sharedConfig(start)));
    await writeSafari(world.safariPath, start);
    const chrome = pairedChrome(BookmarkTree.make({ bar: [leaf("A"), leaf("Live")] }));
    const fileBefore = Fingerprint.ofTree(
      await run(
        Targets.readFileTree({ browser: "chrome", profile: "default", path: world.chromePath }),
      ),
    );

    const result = await run(syncThrough(chrome.layer));

    const chromeFile = result.snapshot?.files.find((file) => file.path === world.chromePath);
    expect(chromeFile?.fingerprints).toContain(fileBefore);
    expect(chromeFile?.fingerprints).toContain(Fingerprint.ofTree(chrome.live()));
  });

  test("a YAML edit made while a sync runs is never overwritten", async () => {
    await run(
      YamlModule.save(world.yamlPath, sharedConfig(BookmarkTree.make({ bar: [leaf("A")] }))),
    );
    let liveTree = BookmarkTree.make({ bar: [leaf("Browser")], menu: [], mobile: [] });
    const layer = Layer.succeed(ChromeBridgeRuntime, {
      loadBindings: Effect.succeed([
        { profilePath: world.chromePath, instanceId: "12345678-1234-1234-1234-123456789abc" },
      ]),
      saveBindings: () => Effect.die("Unexpected binding write"),
      instances: Effect.succeed(["12345678-1234-1234-1234-123456789abc"]),
      request: (_id, request) =>
        Effect.promise(async () => {
          const decoded = Schema.decodeUnknownSync(NativeRequestSchema)(request);
          // Someone edits the YAML while the sync reads Chrome.
          await appendFile(world.yamlPath, "# an edit made during the sync\n");
          if (decoded.operation === "reconcile") liveTree = decoded.tree;
          return {
            id: decoded.id,
            ok: true as const,
            value: TargetState.make({ tree: liveTree, readingList: [] }),
            version: 2,
            hostVersion: 2,
            capabilities: ["readingList"],
          };
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

const article = (name: string, read = false, url = "https://article.example/") =>
  ReadingListItem.make({ name, url, read });

test("first sync after migration reconciles native overlap and deletion history; second sync is a no-op", async () => {
  const oldLeaf = leaf("Article", "https://article.example/");
  const oldTree = BookmarkTree.make({ menu: [folder("Read Later", [oldLeaf])] });
  const migrated = migrate(
    JSON.stringify({ version: 2, all: { reading_list: [oldLeaf] } }),
    JSON.stringify({
      version: 1,
      targets: {
        safari: { reading_list: [oldLeaf] },
        "chrome/default": { reading_list: [oldLeaf] },
      },
    }),
    { "chrome/default": oldTree },
  );
  await writeFile(world.yamlPath, migrated.yaml);
  await run(Baseline.save(migrated.baselines));
  await run(Chrome.writeTree(world.chromePath, oldTree));
  await writeSafari(world.safariPath, BookmarkTree.make({}));
  await run(
    Safari.writeState(
      world.safariPath,
      TargetState.make({ tree: BookmarkTree.make({}), readingList: [article("Article")] }),
    ),
  );
  const chromeOnly = article("Chrome Only", false, "https://chrome-only.example/");
  const chrome = pairedChrome(oldTree, () => undefined, [
    chromeOnly,
    article("Chrome title", true),
  ]);
  const result = await Effect.runPromise(syncThrough(chrome.layer));
  expect(chrome.live().menu ?? []).toEqual([]);
  expect(ReadingList.equal(chrome.readingList(), [chromeOnly, article("Chrome title", true)])).toBe(
    true,
  );
  expect((await run(Safari.readState(world.safariPath))).readingList).toEqual([
    chromeOnly,
    article("Chrome title", true),
  ]);
  expect(
    result.targets
      .find((entry) => entry.target.browser === "safari")
      ?.readingListChanges?.map((change) => change._tag),
  ).toEqual(["Added", "Renamed", "MarkedRead"]);
  const again = await Effect.runPromise(syncThrough(chrome.layer));
  expect(again.yamlChanged).toBe(false);
  expect(again.applied).toEqual([]);
  expect(again.readingListChanges).toEqual([]);
  expect(again.backup).toBeUndefined();
});

test("read-only native change reaches YAML/Safari, backs up the full live list and acknowledges consumed stamps", async () => {
  const tree = BookmarkTree.make({});
  await run(
    YamlModule.save(
      world.yamlPath,
      BookmarksConfig.make({ all: SharedBookmarks.make({ reading_list: [article("Article")] }) }),
    ),
  );
  await writeSafari(world.safariPath, tree);
  const chrome = pairedChrome(tree, () => undefined, [article("Article")]);
  await Effect.runPromise(syncThrough(chrome.layer));
  chrome.setReadingList([article("Article", true)]);
  const result = await Effect.runPromise(syncThrough(chrome.layer));
  expect((await readYaml()).all.reading_list).toEqual([article("Article", true)]);
  expect((await run(Safari.readState(world.safariPath))).readingList).toEqual([
    article("Article", true),
  ]);
  const backup = result.backup?.files.find((path) => path.endsWith("--live-tree.json"));
  if (!backup) throw new Error("Missing full live backup");
  const backedUp = Schema.decodeUnknownSync(TargetState)(
    JSON.parse(await readFile(backup, "utf8")),
  );
  expect(backedUp.readingList).toEqual([article("Article", true)]);
  const stamp = result.snapshot?.files.find((file) => file.path.endsWith(".reading-list"));
  expect(stamp?.fingerprints).toContain(ReadingList.fingerprint([article("Article", true)]));
  expect(stamp?.fingerprints).not.toContain(
    ReadingList.fingerprint([article("Later external edit")]),
  );
});

test("Safari writes YAML-only reordering while list fingerprints stay unchanged", async () => {
  const tree = BookmarkTree.make({});
  const a = article("A");
  const b = article("B", false, "https://b.example/");
  const config = (items: readonly ReadingListItem[]) =>
    BookmarksConfig.make({ all: SharedBookmarks.make({ reading_list: items }) });
  await run(YamlModule.save(world.yamlPath, config([a, b])));
  await writeSafari(world.safariPath, tree);
  await syncNow();
  const before = Fingerprint.ofState(await run(Safari.readState(world.safariPath)));
  await run(YamlModule.save(world.yamlPath, config([b, a])));
  const result = await syncNow();
  expect(result.targets.find((entry) => entry.target.browser === "safari")?.writeMode).toBe(
    "rewrite",
  );
  expect((await run(Safari.readState(world.safariPath))).readingList).toEqual([b, a]);
  expect(Fingerprint.ofState(await run(Safari.readState(world.safariPath)))).toBe(before);
});

test("status, from-YAML sync and gc carry the Reading List with the tree", async () => {
  const tree = BookmarkTree.make({});
  await writeSafari(world.safariPath, tree);
  await run(
    YamlModule.save(
      world.yamlPath,
      BookmarksConfig.make({
        all: SharedBookmarks.make({ reading_list: [article("Article", true)] }),
      }),
    ),
  );
  const chrome = pairedChrome(tree, () => undefined, [article("Article")]);
  const status = await Effect.runPromise(
    Sync.status({ yamlPath: world.yamlPath }).pipe(Effect.provide(chrome.layer)),
  );
  expect(
    status.targets
      .find((entry) => entry.target.browser === "chrome")
      ?.yamlReadingListChanges.map((change) => change._tag),
  ).toEqual(["MarkedRead"]);
  const pushed = await Effect.runPromise(
    Sync.push({ yamlPath: world.yamlPath }).pipe(Effect.provide(chrome.layer)),
  );
  expect(
    pushed.targets
      .find((entry) => entry.target.browser === "chrome")
      ?.readingListChanges?.map((change) => change._tag),
  ).toEqual(["MarkedRead"]);
  expect(chrome.readingList()).toEqual([article("Article", true)]);
  await Effect.runPromise(Sync.gc({ yamlPath: world.yamlPath }).pipe(Effect.provide(chrome.layer)));
  expect((await readYaml()).all.reading_list).toEqual([article("Article", true)]);
  expect((await run(Safari.readState(world.safariPath))).readingList).toEqual([
    article("Article", true),
  ]);
});
