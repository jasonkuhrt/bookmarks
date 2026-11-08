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

  test("Chrome's reading list is the shared one, and sections a browser lacks are untouched", async () => {
    const config = BookmarksConfig.make({
      all: BookmarkTree.make({ reading_list: [leaf("Article")], mobile: [leaf("Phone")] }),
    });

    const fromChrome = Layers.absorbTargetTree(
      config,
      chrome,
      BookmarkTree.make({
        reading_list: [leaf("Article"), leaf("Later")],
        mobile: [leaf("Phone")],
      }),
    );
    expect(names(fromChrome.all.reading_list)).toEqual(["Article", "Later"]);

    const fromSafari = Layers.absorbTargetTree(
      fromChrome,
      safari,
      BookmarkTree.make({ reading_list: [leaf("Later")] }),
    );
    expect(names(fromSafari.all.reading_list)).toEqual(["Later"]);
    expect(names(fromSafari.all.mobile)).toEqual(["Phone"]);
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
