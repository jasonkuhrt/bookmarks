import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Layers from "./layers.ts";
import {
  BookmarkFolder,
  BookmarkLeaf,
  BookmarksConfig,
  BookmarkTree,
  ChromeBookmarks,
  ChromeProfileBookmarks,
  SafariBookmarks,
  SharedBookmarks,
  ReadingListItem,
} from "./schema/__.ts";
import * as YamlModule from "./yaml.ts";

const leaf = (name: string) =>
  BookmarkLeaf.make({ name, url: `https://${name.toLowerCase()}.example/` });
const folder = (name: string, children: readonly (BookmarkLeaf | BookmarkFolder)[]) =>
  BookmarkFolder.make({ name, children });
const names = (nodes: readonly (BookmarkLeaf | BookmarkFolder)[] | undefined) =>
  nodes?.map((node) => node.name);

const chrome = { browser: "chrome", profile: "default" } as const;
const safari = { browser: "safari" } as const;

const resolve = (
  config: BookmarksConfig,
  target: { readonly browser: string; readonly profile?: string },
) => Effect.runPromise(YamlModule.resolveTarget(config, target));

describe("absorbTargetTree", () => {
  test("an edit inside a shared folder stays shared, so every browser receives it", async () => {
    const config = BookmarksConfig.make({
      all: BookmarkTree.make({ bar: [folder("Build", [leaf("A")])] }),
      chrome: ChromeBookmarks.make({ profiles: { default: ChromeProfileBookmarks.make({}) } }),
    });
    const chromeTree = BookmarkTree.make({ bar: [folder("Build", [leaf("A"), leaf("B")])] });

    const next = Layers.absorbTargetTree(config, chrome, chromeTree);

    expect(next.all.bar).toEqual(chromeTree.bar);
    expect(next.chrome?.bar).toBeUndefined();
    expect(next.chrome?.profiles?.["default"]?.bar).toBeUndefined();
    expect((await resolve(next, safari)).bar).toEqual(chromeTree.bar);
  });

  test("each top-level node keeps its layer, and a new one joins its neighbour's", async () => {
    const config = BookmarksConfig.make({
      all: BookmarkTree.make({ bar: [leaf("Shared")] }),
      safari: SafariBookmarks.make({ bar: [leaf("Safari Only")] }),
    });
    const safariTree = BookmarkTree.make({
      bar: [leaf("New First"), leaf("Shared"), leaf("Safari Only"), leaf("New Last")],
    });

    const next = Layers.absorbTargetTree(config, safari, safariTree);

    expect(names(next.all.bar)).toEqual(["New First", "Shared"]);
    expect(names(next.safari?.bar)).toEqual(["Safari Only", "New Last"]);
    expect(await resolve(next, safari)).toEqual(safariTree);
  });

  test("a browser-only node moved before a shared one becomes shared, never hidden", async () => {
    const config = BookmarksConfig.make({
      all: BookmarkTree.make({ bar: [leaf("Shared")] }),
      safari: SafariBookmarks.make({ bar: [leaf("Safari Only")] }),
    });
    const safariTree = BookmarkTree.make({ bar: [leaf("Safari Only"), leaf("Shared")] });

    const next = Layers.absorbTargetTree(config, safari, safariTree);

    expect(names(next.all.bar)).toEqual(["Safari Only", "Shared"]);
    expect(next.safari?.bar).toBeUndefined();
    expect(await resolve(next, safari)).toEqual(safariTree);
  });

  test("tree absorption leaves the separate shared Reading List untouched", () => {
    const items = [
      ReadingListItem.make({ name: "Article", url: "https://article.example/", read: true }),
    ];
    const config = BookmarksConfig.make({
      all: SharedBookmarks.make({ reading_list: items, mobile: [leaf("Phone")] }),
    });
    const fromChrome = Layers.absorbTargetTree(
      config,
      chrome,
      BookmarkTree.make({ mobile: [leaf("Phone")] }),
    );
    const fromSafari = Layers.absorbTargetTree(
      fromChrome,
      safari,
      BookmarkTree.make({ bar: [leaf("Later")] }),
    );
    expect(fromSafari.all.reading_list).toEqual(items);
    expect(names(fromSafari.all.mobile)).toEqual(["Phone"]);
  });

  test("a shared folder renamed in one browser stays shared, next to a browser-only folder", async () => {
    const config = BookmarksConfig.make({
      all: BookmarkTree.make({ bar: [folder("Shared", [leaf("A")])] }),
      safari: SafariBookmarks.make({ bar: [folder("Local", [leaf("B")])] }),
    });
    const safariTree = BookmarkTree.make({
      bar: [folder("Renamed", [leaf("A")]), folder("Local", [leaf("B")])],
    });

    const next = Layers.absorbTargetTree(config, safari, safariTree);

    expect(next.all.bar).toEqual([folder("Renamed", [leaf("A")])]);
    expect(next.safari?.bar).toEqual([folder("Local", [leaf("B")])]);
    expect((await resolve(next, chrome)).bar).toEqual([folder("Renamed", [leaf("A")])]);
    expect(await resolve(next, safari)).toEqual(safariTree);
  });

  test("a shared bookmark renamed in one browser stays shared", async () => {
    const config = BookmarksConfig.make({
      all: BookmarkTree.make({ bar: [leaf("A")] }),
      safari: SafariBookmarks.make({ bar: [leaf("B")] }),
    });
    const renamed = BookmarkLeaf.make({ name: "A renamed", url: leaf("A").url });

    const next = Layers.absorbTargetTree(
      config,
      safari,
      BookmarkTree.make({ bar: [renamed, leaf("B")] }),
    );

    expect(next.all.bar).toEqual([renamed]);
    expect(next.safari?.bar).toEqual([leaf("B")]);
  });

  test("a browser-only folder renamed in that browser stays browser-only", () => {
    const config = BookmarksConfig.make({
      all: BookmarkTree.make({ bar: [folder("Shared", [leaf("A")])] }),
      safari: SafariBookmarks.make({ bar: [folder("Local", [leaf("B")])] }),
    });

    const next = Layers.absorbTargetTree(
      config,
      safari,
      BookmarkTree.make({ bar: [folder("Shared", [leaf("A")]), folder("Mine", [leaf("B")])] }),
    );

    expect(next.all.bar).toEqual([folder("Shared", [leaf("A")])]);
    expect(next.safari?.bar).toEqual([folder("Mine", [leaf("B")])]);
  });

  test("a deleted top-level folder leaves its layer", () => {
    const config = BookmarksConfig.make({
      all: BookmarkTree.make({ bar: [folder("Keep", []), folder("Drop", [leaf("A")])] }),
    });

    const next = Layers.absorbTargetTree(
      config,
      chrome,
      BookmarkTree.make({ bar: [folder("Keep", [])] }),
    );

    expect(names(next.all.bar)).toEqual(["Keep"]);
  });
});

describe("assignLayers", () => {
  test("orders layers outermost first, filling new nodes from their neighbours", () => {
    expect(
      Layers.assignLayers([[leaf("A")], [leaf("B")]], [leaf("A"), leaf("X"), leaf("B")]),
    ).toEqual([0, 0, 1]);
    expect(Layers.assignLayers([[], [leaf("B")]], [leaf("X"), leaf("B")])).toEqual([1, 1]);
    expect(Layers.assignLayers([[], []], [leaf("X")])).toEqual([0]);
  });
});
