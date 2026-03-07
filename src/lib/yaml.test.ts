import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const leaf = (name: string, url: string) => new BookmarkLeaf({ name, url });
const folder = (name: string, children: Array<BookmarkLeaf | BookmarkFolder>) =>
  new BookmarkFolder({ name, children });

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

describe("yaml", () => {
  test("decodeDocument upgrades legacy v1 config into the v2 browser model", async () => {
    const raw = {
      targets: {
        safari: {
          default: { enabled: false },
        },
        chrome: {
          default: { enabled: true },
          work: { enabled: false },
        },
      },
      base: {
        favorites_bar: [{ _tag: "BookmarkLeaf", name: "Shared", url: "https://shared.example" }],
        other: [{ _tag: "BookmarkLeaf", name: "Menu Item", url: "https://menu.example" }],
      },
      profiles: {
        "chrome/default": {
          favorites_bar: [
            { _tag: "BookmarkLeaf", name: "Default Only", url: "https://default.example" },
          ],
        },
        "chrome/work": {
          other: [{ _tag: "BookmarkLeaf", name: "Work Menu", url: "https://work.example" }],
        },
      },
    };

    const decoded = await run(YamlModule.decodeDocument(raw, "legacy bookmarks.yaml"));

    expect(decoded.version).toBe(2);
    expect(decoded.all.bar?.map((node) => node.name)).toEqual(["Shared"]);
    expect(decoded.all.menu?.map((node) => node.name)).toEqual(["Menu Item"]);
    expect(decoded.safari?.enabled).toBe(false);
    expect(decoded.chrome?.enabled).toBe(true);
    expect(decoded.chrome?.profiles?.["default"]?.enabled).toBe(true);
    expect(decoded.chrome?.profiles?.["default"]?.bar?.map((node) => node.name)).toEqual([
      "Default Only",
    ]);
    expect(decoded.chrome?.profiles?.["work"]?.menu?.map((node) => node.name)).toEqual([
      "Work Menu",
    ]);
  });

  test("decodeDocument rejects legacy Safari profile overlays", async () => {
    const error = await runError(
      YamlModule.decodeDocument(
        {
          profiles: {
            "safari/default": {
              favorites_bar: [{ name: "Nope", url: "https://nope.example" }],
            },
          },
        },
        "legacy bookmarks.yaml",
      ),
    );
    expect(error.message).toContain(
      'Legacy Safari profile overlay "safari/default" is no longer supported',
    );
  });

  test("decodeDocument rejects legacy profile overlays without a browser prefix", async () => {
    const error = await runError(
      YamlModule.decodeDocument(
        {
          profiles: {
            default: {
              favorites_bar: [{ _tag: "BookmarkLeaf", name: "Nope", url: "https://nope.example" }],
            },
          },
        },
        "legacy bookmarks.yaml",
      ),
    );
    expect(error.message).toContain('Legacy profile overlay "default" is invalid');
  });

  test("decodeDocument rejects reading_list in Chrome overlays", async () => {
    const chromeError = await runError(
      YamlModule.decodeDocument(
        {
          version: 2,
          all: {},
          chrome: {
            reading_list: [{ name: "Blocked", url: "https://blocked.example" }],
          },
        },
        "bookmarks.yaml",
      ),
    );
    expect(chromeError.message).toContain("chrome cannot define reading_list");

    const profileError = await runError(
      YamlModule.decodeDocument(
        {
          version: 2,
          all: {},
          chrome: {
            profiles: {
              default: {
                reading_list: [{ name: "Blocked", url: "https://blocked.example" }],
              },
            },
          },
        },
        "bookmarks.yaml",
      ),
    );
    expect(profileError.message).toContain("chrome.profiles.default cannot define reading_list");
  });

  test("save/load preserves sibling ordering and empty folders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-yaml-"));
    const yamlPath = join(dir, "bookmarks.yaml");

    try {
      const config = BookmarksConfig.make({
        all: new BookmarkTree({
          bar: [
            leaf("First", "https://first.example"),
            folder("Empty", []),
            folder("Nested", [leaf("Inside", "https://inside.example")]),
            leaf("Last", "https://last.example"),
          ],
        }),
        safari: SafariBookmarks.make({
          menu: [folder("Profile Empty", []), leaf("Profile Bookmark", "https://profile.example")],
        }),
      });

      await run(YamlModule.save(yamlPath, config));
      const loaded = await run(YamlModule.load(yamlPath));

      expect(loaded).toEqual(config);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resolveTarget merges shared, browser, and Chrome profile overlays with browser projection", async () => {
    const config = BookmarksConfig.make({
      all: new BookmarkTree({
        bar: [leaf("Shared Bar", "https://shared-bar.example")],
        menu: [leaf("Shared Menu", "https://shared-menu.example")],
        reading_list: [leaf("Shared Reading", "https://shared-reading.example")],
        mobile: [leaf("Shared Mobile", "https://shared-mobile.example")],
      }),
      safari: SafariBookmarks.make({
        bar: [leaf("Safari Bar", "https://safari-bar.example")],
      }),
      chrome: ChromeBookmarks.make({
        enabled: true,
        menu: [leaf("Chrome Menu", "https://chrome-menu.example")],
        profiles: {
          default: ChromeProfileBookmarks.make({
            bar: [leaf("Chrome Profile", "https://chrome-profile.example")],
          }),
        },
      }),
    });

    const safariTree = await run(YamlModule.resolveTarget(config, { browser: "safari" }));
    expect(safariTree.bar?.map((node) => node.name)).toEqual(["Shared Bar", "Safari Bar"]);
    expect(safariTree.menu?.map((node) => node.name)).toEqual(["Shared Menu"]);
    expect(safariTree.reading_list?.map((node) => node.name)).toEqual(["Shared Reading"]);
    expect(safariTree.mobile).toBeUndefined();

    const chromeTree = await run(
      YamlModule.resolveTarget(config, { browser: "chrome", profile: "default" }),
    );
    expect(chromeTree.bar?.map((node) => node.name)).toEqual(["Shared Bar", "Chrome Profile"]);
    expect(chromeTree.menu?.map((node) => node.name)).toEqual(["Shared Menu", "Chrome Menu"]);
    expect(chromeTree.mobile?.map((node) => node.name)).toEqual(["Shared Mobile"]);
    expect(chromeTree.reading_list).toBeUndefined();
  });

  test("configuredChromeProfiles and isTargetEnabled follow browser and profile flags", () => {
    const config = BookmarksConfig.make({
      all: new BookmarkTree({}),
      safari: SafariBookmarks.make({ enabled: false }),
      chrome: ChromeBookmarks.make({
        enabled: true,
        profiles: {
          default: ChromeProfileBookmarks.make({ enabled: true }),
          work: ChromeProfileBookmarks.make({ enabled: false }),
        },
      }),
    });

    expect(YamlModule.configuredChromeProfiles(config)).toEqual(["default", "work"]);
    expect(YamlModule.isTargetEnabled(config, { browser: "safari" })).toBe(false);
    expect(YamlModule.isTargetEnabled(config, { browser: "chrome" })).toBe(true);
    expect(YamlModule.isTargetEnabled(config, { browser: "chrome", profile: "default" })).toBe(
      true,
    );
    expect(YamlModule.isTargetEnabled(config, { browser: "chrome", profile: "work" })).toBe(false);
    expect(YamlModule.isTargetEnabled(config, { browser: "firefox" })).toBe(true);
  });
});
