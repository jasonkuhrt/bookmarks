import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { BookmarkLeaf } from "./bookmark-leaf.ts";
import { BookmarkFolder, BookmarkNode } from "./bookmark-structure.ts";
import { BookmarkTree } from "./bookmark-tree.ts";
import {
  BookmarksConfig,
  ChromeBookmarks,
  ChromeProfileBookmarks,
  SafariBookmarks,
} from "./bookmarks-config.ts";
import { TargetProfile } from "./target-profile.ts";

describe("schema models", () => {
  test("bookmark classes expose constructors and type guards", () => {
    const leaf = new BookmarkLeaf({ name: "Docs", url: "https://docs.example" });
    const folder = new BookmarkFolder({ name: "Reference", children: [leaf] });
    const tree = new BookmarkTree({ bar: [folder] });

    expect(BookmarkLeaf.is(leaf)).toBe(true);
    expect(BookmarkFolder.is(folder)).toBe(true);
    expect(BookmarkTree.is(tree)).toBe(true);
    expect(
      Schema.decodeUnknownSync(BookmarkNode)({
        _tag: "BookmarkLeaf",
        name: leaf.name,
        url: leaf.url,
      }),
    ).toEqual(leaf);
    expect(
      Schema.decodeUnknownSync(BookmarkNode)({
        _tag: "BookmarkFolder",
        name: folder.name,
        children: folder.children,
      }),
    ).toEqual(folder);
  });

  test("individual bookmark schemas decode and encode their runtime shapes", () => {
    const leaf = Schema.decodeUnknownSync(BookmarkLeaf)({
      _tag: "BookmarkLeaf",
      name: "Docs",
      url: "https://docs.example",
    });
    const folder = Schema.decodeUnknownSync(BookmarkFolder)({
      _tag: "BookmarkFolder",
      name: "Reference",
      children: [
        {
          _tag: "BookmarkLeaf",
          name: "Docs",
          url: "https://docs.example",
        },
      ],
    });
    const tree = Schema.decodeUnknownSync(BookmarkTree)({
      bar: [Schema.encodeSync(BookmarkLeaf)(leaf)],
      menu: [Schema.encodeSync(BookmarkFolder)(folder)],
    });

    expect(Schema.encodeSync(BookmarkLeaf)(leaf)).toEqual({
      _tag: "BookmarkLeaf",
      name: "Docs",
      url: "https://docs.example",
    });
    expect(Schema.encodeSync(BookmarkFolder)(folder)).toEqual({
      _tag: "BookmarkFolder",
      name: "Reference",
      children: [
        {
          _tag: "BookmarkLeaf",
          name: "Docs",
          url: "https://docs.example",
        },
      ],
    });
    expect(Schema.encodeSync(BookmarkTree)(tree)).toEqual({
      bar: [{ _tag: "BookmarkLeaf", name: "Docs", url: "https://docs.example" }],
      menu: [
        {
          _tag: "BookmarkFolder",
          name: "Reference",
          children: [{ _tag: "BookmarkLeaf", name: "Docs", url: "https://docs.example" }],
        },
      ],
    });
  });

  test("config classes expose constructors and type guards", () => {
    const safari = new SafariBookmarks({
      enabled: true,
      bar: [new BookmarkLeaf({ name: "Bar", url: "https://bar.example" })],
      menu: [new BookmarkLeaf({ name: "Menu", url: "https://menu.example" })],
      reading_list: [new BookmarkLeaf({ name: "Read", url: "https://read.example" })],
    });
    const defaultProfile = new ChromeProfileBookmarks({
      enabled: true,
      bar: [new BookmarkLeaf({ name: "Chrome", url: "https://chrome.example" })],
    });
    const chrome = new ChromeBookmarks({
      enabled: true,
      profiles: { default: defaultProfile },
    });
    const config = new BookmarksConfig({
      all: new BookmarkTree({}),
      safari,
      chrome,
    });
    const targetProfile = new TargetProfile({ path: "/tmp/Bookmarks", enabled: true });

    expect(SafariBookmarks.is(safari)).toBe(true);
    expect(ChromeProfileBookmarks.is(defaultProfile)).toBe(true);
    expect(ChromeBookmarks.is(chrome)).toBe(true);
    expect(BookmarksConfig.is(config)).toBe(true);
    expect(TargetProfile.is(targetProfile)).toBe(true);
  });

  test("config schemas decode and encode nested browser config values", () => {
    const targetProfile = Schema.decodeUnknownSync(TargetProfile)({
      path: "/tmp/Bookmarks",
      enabled: true,
    });
    const safari = Schema.decodeUnknownSync(SafariBookmarks)({
      enabled: true,
      bar: [{ _tag: "BookmarkLeaf", name: "Bar", url: "https://bar.example" }],
      menu: [{ _tag: "BookmarkLeaf", name: "Menu", url: "https://menu.example" }],
      reading_list: [{ _tag: "BookmarkLeaf", name: "Read", url: "https://read.example" }],
    });
    const defaultProfile = Schema.decodeUnknownSync(ChromeProfileBookmarks)({
      enabled: true,
      bar: [{ _tag: "BookmarkLeaf", name: "Chrome", url: "https://chrome.example" }],
    });
    const chrome = Schema.decodeUnknownSync(ChromeBookmarks)({
      enabled: true,
      profiles: {
        default: Schema.encodeSync(ChromeProfileBookmarks)(defaultProfile),
      },
    });
    const config = Schema.decodeUnknownSync(BookmarksConfig)({
      version: 2,
      all: { bar: [{ _tag: "BookmarkLeaf", name: "Shared", url: "https://shared.example" }] },
      safari: Schema.encodeSync(SafariBookmarks)(safari),
      chrome: Schema.encodeSync(ChromeBookmarks)(chrome),
    });

    expect(Schema.encodeSync(TargetProfile)(targetProfile)).toEqual({
      path: "/tmp/Bookmarks",
      enabled: true,
    });
    expect(Schema.encodeSync(ChromeProfileBookmarks)(defaultProfile)).toEqual({
      enabled: true,
      bar: [{ _tag: "BookmarkLeaf", name: "Chrome", url: "https://chrome.example" }],
    });
    expect(Schema.encodeSync(BookmarksConfig)(config)).toEqual({
      version: 2,
      all: { bar: [{ _tag: "BookmarkLeaf", name: "Shared", url: "https://shared.example" }] },
      safari: {
        enabled: true,
        bar: [{ _tag: "BookmarkLeaf", name: "Bar", url: "https://bar.example" }],
        menu: [{ _tag: "BookmarkLeaf", name: "Menu", url: "https://menu.example" }],
        reading_list: [{ _tag: "BookmarkLeaf", name: "Read", url: "https://read.example" }],
      },
      chrome: {
        enabled: true,
        profiles: {
          default: {
            enabled: true,
            bar: [{ _tag: "BookmarkLeaf", name: "Chrome", url: "https://chrome.example" }],
          },
        },
      },
    });
  });
});
