import { describe, expect, test } from "bun:test";
import { parse } from "@plist/binary.parse";
import { serialize } from "@plist/binary.serialize";
import { DateTime, Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Patch from "./patch.ts";
import { BookmarkFolder, BookmarkLeaf, type BookmarkNode, BookmarkTree } from "./schema/__.ts";
import * as Safari from "./safari.ts";
import { writeSafariBookmarksFixture } from "./test-fixtures.ts";

// -- Test helpers --

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);
const now = DateTime.unsafeNow();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const expectDefined = <T>(value: T | undefined, message: string): T => {
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
};

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

const setupFixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bookmarks-safari-fixture-"));
  const path = join(dir, "Bookmarks.plist");
  await writeSafariBookmarksFixture(path);
  return { dir, path };
};

const withFixture = async <A>(fn: (path: string) => Promise<A>): Promise<A> => {
  const { dir, path } = await setupFixture();

  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// -- readBookmarks --

describe("readBookmarks", () => {
  test("reads fixture Safari plist and produces a BookmarkTree", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path));
      expect(tree).toBeInstanceOf(BookmarkTree);
    });
  });

  test("bar contains folders from BookmarksBar", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path));
      const bar = expectDefined(tree.bar, "expected bookmarks bar section");
      expect(bar.length).toBeGreaterThan(0);
      const firstItem = expectFolder(bar[0], "expected folder in bookmarks bar");
      expect(firstItem).toBeInstanceOf(BookmarkFolder);
    });
  });

  test("reading_list contains leaves from com.apple.ReadingList", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path));
      const readingList = expectDefined(tree.reading_list, "expected reading list section");
      expect(readingList.length).toBeGreaterThan(0);
      const firstItem = expectLeaf(readingList[0], "expected reading list bookmark");
      expect(firstItem.url).toMatch(/^https?:\/\//);
    });
  });

  test("other section collects root-level folders and BookmarksMenu content", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path));
      const menu = expectDefined(tree.menu, "expected menu section");
      expect(menu.length).toBeGreaterThan(0);
    });
  });

  test("History proxy is excluded", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path));
      const allNames = [
        ...(tree.bar ?? []),
        ...(tree.menu ?? []),
        ...(tree.reading_list ?? []),
      ].map((n) => ("name" in n ? n.name : ""));
      expect(allNames).not.toContain("History");
    });
  });

  test("leaf nodes have name and url", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path));
      const leaf = expectLeaf(tree.reading_list?.[0], "expected reading list bookmark");
      expect(leaf.name).toBeTruthy();
      expect(leaf.url).toBeTruthy();
      expect(leaf.url).toMatch(/^https?:\/\//);
    });
  });

  test("folder nodes have name and children", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path));
      const folder = expectFolder(tree.bar?.[0], "expected folder in bookmarks bar");
      expect(folder.name).toBeTruthy();
      expect(Array.isArray(folder.children)).toBe(true);
    });
  });

  test("preserves sibling ordering and empty folders in a hermetic fixture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-safari-"));
    const path = join(dir, "Bookmarks.plist");

    try {
      await Bun.write(
        path,
        serialize({
          Children: [
            {
              WebBookmarkType: "WebBookmarkTypeList",
              Title: "BookmarksBar",
              Children: [
                {
                  WebBookmarkType: "WebBookmarkTypeLeaf",
                  URLString: "https://first.example/",
                  URIDictionary: { title: "First" },
                },
                {
                  WebBookmarkType: "WebBookmarkTypeList",
                  Title: "Empty",
                  Children: [],
                },
                {
                  WebBookmarkType: "WebBookmarkTypeList",
                  Title: "Nested",
                  Children: [
                    {
                      WebBookmarkType: "WebBookmarkTypeLeaf",
                      URLString: "https://inside.example/",
                      URIDictionary: { title: "Inside" },
                    },
                  ],
                },
                {
                  WebBookmarkType: "WebBookmarkTypeLeaf",
                  URLString: "https://last.example/",
                  URIDictionary: { title: "Last" },
                },
              ],
            },
            {
              WebBookmarkType: "WebBookmarkTypeList",
              Title: "BookmarksMenu",
              Children: [],
            },
            {
              WebBookmarkType: "WebBookmarkTypeList",
              Title: "com.apple.ReadingList",
              Children: [],
            },
          ],
        }),
      );

      const tree = await run(Safari.readBookmarks(path));

      expect(tree.bar?.map((node) => node.name)).toEqual(["First", "Empty", "Nested", "Last"]);

      const emptyFolder = tree.bar?.[1];
      expect(expectFolder(emptyFolder, 'expected "Empty" folder').children).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses unsupported separator-like nodes that would otherwise be dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-safari-unsupported-"));
    const path = join(dir, "Bookmarks.plist");

    try {
      await Bun.write(
        path,
        serialize({
          Children: [
            {
              WebBookmarkType: "WebBookmarkTypeList",
              Title: "BookmarksBar",
              Children: [
                {
                  WebBookmarkType: "WebBookmarkTypeSeparator",
                  Title: "Separator",
                },
              ],
            },
            {
              WebBookmarkType: "WebBookmarkTypeList",
              Title: "BookmarksMenu",
              Children: [],
            },
            {
              WebBookmarkType: "WebBookmarkTypeList",
              Title: "com.apple.ReadingList",
              Children: [],
            },
          ],
        }),
      );

      await expectRejects(run(Safari.readBookmarks(path)), "Bookmark separators are not supported");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// -- applyPatches --

describe("applyPatches", () => {
  const setupCopy = async () => {
    return setupFixture();
  };

  const cleanup = async (dir: string) => {
    await rm(dir, { recursive: true, force: true });
  };

  test("Add patch inserts a new leaf", async () => {
    const { dir, path } = await setupCopy();
    try {
      const testUrl = "https://test-bookmark-add.example.com/";
      const testName = "Test Add Bookmark";

      await run(
        Safari.applyPatches(path, [
          Patch.Add({ url: testUrl, name: testName, path: "bar", date: now }),
        ]),
      );

      const tree = await run(Safari.readBookmarks(path));
      const found = (tree.bar ?? []).find(
        (n): n is BookmarkLeaf => BookmarkLeaf.is(n) && n.url === testUrl,
      );
      expect(expectLeaf(found, "expected inserted bookmark").name).toBe(testName);
    } finally {
      await cleanup(dir);
    }
  });

  test("Remove patch deletes a leaf", async () => {
    const { dir, path } = await setupCopy();
    try {
      const treeBefore = await run(Safari.readBookmarks(path));
      const target = expectLeaf(
        treeBefore.reading_list?.[0],
        "expected reading list bookmark to remove",
      );

      await run(
        Safari.applyPatches(path, [
          Patch.Remove({ url: target.url, name: target.name, path: "reading_list", date: now }),
        ]),
      );

      const treeAfter = await run(Safari.readBookmarks(path));
      const remainingUrls = (treeAfter.reading_list ?? [])
        .filter((n): n is BookmarkLeaf => BookmarkLeaf.is(n))
        .map((n) => n.url);
      expect(remainingUrls).not.toContain(target.url);
    } finally {
      await cleanup(dir);
    }
  });

  test("Update patch renames a leaf", async () => {
    const { dir, path } = await setupCopy();
    try {
      const treeBefore = await run(Safari.readBookmarks(path));
      const target = expectLeaf(
        treeBefore.reading_list?.[0],
        "expected reading list bookmark to rename",
      );
      const newName = "RENAMED_TEST_BOOKMARK";

      await run(
        Safari.applyPatches(path, [
          Patch.Update({
            url: target.url,
            oldName: target.name,
            newName,
            fromPath: "reading_list",
            toPath: "reading_list",
            date: now,
          }),
        ]),
      );

      const treeAfter = await run(Safari.readBookmarks(path));
      const found = (treeAfter.reading_list ?? []).find(
        (n): n is BookmarkLeaf => BookmarkLeaf.is(n) && n.url === target.url,
      );
      expect(expectLeaf(found, "expected renamed bookmark").name).toBe(newName);
    } finally {
      await cleanup(dir);
    }
  });

  test("Update patch moves a leaf to a different section", async () => {
    const { dir, path } = await setupCopy();
    try {
      const treeBefore = await run(Safari.readBookmarks(path));
      const target = expectLeaf(
        treeBefore.reading_list?.[0],
        "expected reading list bookmark to move",
      );

      await run(
        Safari.applyPatches(path, [
          Patch.Update({
            url: target.url,
            oldName: target.name,
            newName: target.name,
            fromPath: "reading_list",
            toPath: "bar",
            date: now,
          }),
        ]),
      );

      const treeAfter = await run(Safari.readBookmarks(path));

      // Gone from reading_list
      const remainingUrls = (treeAfter.reading_list ?? [])
        .filter((n): n is BookmarkLeaf => BookmarkLeaf.is(n))
        .map((n) => n.url);
      expect(remainingUrls).not.toContain(target.url);

      // Present in bar
      const found = (treeAfter.bar ?? []).find(
        (n): n is BookmarkLeaf => BookmarkLeaf.is(n) && n.url === target.url,
      );
      expect(expectLeaf(found, "expected moved bookmark").name).toBe(target.name);
    } finally {
      await cleanup(dir);
    }
  });

  test("Add patch into nested folder path creates folders as needed", async () => {
    const { dir, path } = await setupCopy();
    try {
      const testUrl = "https://test-nested-add.example.com/";
      const testName = "Nested Add Test";

      await run(
        Safari.applyPatches(path, [
          Patch.Add({ url: testUrl, name: testName, path: "menu/NewFolder/SubFolder", date: now }),
        ]),
      );

      const tree = await run(Safari.readBookmarks(path));
      // Navigate: other → NewFolder → SubFolder → leaf
      const newFolder = (tree.menu ?? []).find(
        (n): n is BookmarkFolder => BookmarkFolder.is(n) && n.name === "NewFolder",
      );
      const folder = expectFolder(newFolder, 'expected "NewFolder" folder');
      const subFolder = expectFolder(
        folder.children.find(
          (n): n is BookmarkFolder => BookmarkFolder.is(n) && n.name === "SubFolder",
        ),
        'expected "SubFolder" folder',
      );
      const leaf = subFolder.children.find(
        (n): n is BookmarkLeaf => BookmarkLeaf.is(n) && n.url === testUrl,
      );
      expect(expectLeaf(leaf, "expected nested bookmark").name).toBe(testName);
    } finally {
      await cleanup(dir);
    }
  });

  test("Update patches claim duplicate sources before swapping names", async () => {
    const { dir, path } = await setupCopy();
    const url = "https://duplicate-swap.example/";
    try {
      await run(
        Safari.writeTree(
          path,
          BookmarkTree.make({
            bar: [BookmarkLeaf.make({ name: "A", url }), BookmarkLeaf.make({ name: "B", url })],
          }),
        ),
      );

      await run(
        Safari.applyPatches(path, [
          Patch.Update({
            url,
            oldName: "A",
            newName: "B",
            fromPath: "bar",
            toPath: "bar",
            date: now,
          }),
          Patch.Update({
            url,
            oldName: "B",
            newName: "A",
            fromPath: "bar",
            toPath: "bar",
            date: now,
          }),
        ]),
      );

      const tree = await run(Safari.readBookmarks(path));
      expect(tree.bar?.map((node) => node.name)).toEqual(["B", "A"]);
    } finally {
      await cleanup(dir);
    }
  });
});

describe("requiresFullRewrite", () => {
  test("requires a rewrite when root-level menu nodes make patch ordering ambiguous", async () => {
    await withFixture(async (path) => {
      expect(
        await run(
          Safari.requiresFullRewrite(path, [
            Patch.Add({
              url: "https://new-menu.example/",
              name: "New menu item",
              path: "menu",
              date: now,
            }),
          ]),
        ),
      ).toBe(true);
    });
  });
});

describe("writeTree", () => {
  test("writes structural changes exactly, including ordering and empty folders", async () => {
    const { dir, path } = await setupFixture();

    try {
      const desired = BookmarkTree.make({
        bar: [
          BookmarkLeaf.make({ name: "Top Link", url: "https://top.example/" }),
          BookmarkFolder.make({
            name: "Favorites Folder",
            children: [BookmarkLeaf.make({ name: "Docs", url: "https://docs.example/" })],
          }),
          BookmarkFolder.make({ name: "Empty", children: [] }),
        ],
        menu: [
          BookmarkLeaf.make({ name: "Menu Link", url: "https://menu.example/" }),
          BookmarkFolder.make({
            name: "Loose Folder",
            children: [
              BookmarkLeaf.make({
                name: "Loose Folder Link",
                url: "https://loose-folder.example/",
              }),
            ],
          }),
          BookmarkLeaf.make({ name: "Loose Leaf", url: "https://loose.example/" }),
        ],
        reading_list: [
          BookmarkLeaf.make({ name: "Reading Item", url: "https://reading.example/" }),
        ],
      });

      await run(Safari.writeTree(path, desired));

      const reread = await run(Safari.readBookmarks(path));
      expect(reread).toEqual(desired);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("never reuses a native UUID when the desired tree reuses one duplicate leaf object", async () => {
    const { dir, path } = await setupFixture();
    const url = "https://shared-object.example/";

    try {
      await run(
        Safari.writeTree(
          path,
          BookmarkTree.make({
            bar: [
              BookmarkLeaf.make({ name: "Shared", url }),
              BookmarkLeaf.make({ name: "Shared", url }),
            ],
          }),
        ),
      );

      const shared = BookmarkLeaf.make({ name: "Shared", url });
      await run(Safari.writeTree(path, BookmarkTree.make({ bar: [shared, shared] })));

      const root = parse(await Bun.file(path).arrayBuffer());
      if (!isRecord(root)) throw new Error("Expected Safari plist root");
      const children = root["Children"];
      if (!Array.isArray(children)) throw new Error("Expected Safari root children");
      const bar = children.find((node) => isRecord(node) && node["Title"] === "BookmarksBar");
      if (!isRecord(bar)) {
        throw new Error("Expected Safari bookmarks bar");
      }
      const leaves = Array.isArray(bar["Children"])
        ? bar["Children"].filter((node) => isRecord(node) && node["URLString"] === url)
        : [];
      expect(leaves).toHaveLength(2);
      const first = leaves[0];
      const second = leaves[1];
      if (!isRecord(first) || !isRecord(second)) {
        throw new Error("Expected Safari bookmark leaves");
      }
      expect(first["WebBookmarkUUID"]).not.toBe(second["WebBookmarkUUID"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("canonical form", () => {
  test("a bookmark Safari stores as typed is read, matched and rewritten in the canonical form", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-safari-canonical-"));
    const path = join(dir, "Bookmarks.plist");
    const typed = "javascript:go('https://x.example/?u='+1)";
    const canonical = "javascript:go('https://x.example/?u=%27+1)";

    try {
      await Bun.write(
        path,
        serialize({
          Children: [
            {
              WebBookmarkType: "WebBookmarkTypeList",
              Title: "BookmarksBar",
              Children: [
                {
                  WebBookmarkType: "WebBookmarkTypeLeaf",
                  URLString: typed,
                  URIDictionary: { title: "Save\nit" },
                },
              ],
            },
          ],
        }),
      );

      expect((await run(Safari.readBookmarks(path))).bar).toEqual([
        BookmarkLeaf.make({ name: "Save it", url: canonical }),
      ]);

      await run(
        Safari.applyPatches(path, [
          Patch.Update({
            url: canonical,
            oldName: "Save it",
            newName: "Saved",
            fromPath: "bar",
            toPath: "bar",
            date: DateTime.unsafeNow(),
          }),
        ]),
      );

      const root = parse(await Bun.file(path).arrayBuffer());
      expect(JSON.stringify(root)).toContain(JSON.stringify(canonical).slice(1, -1));
      expect((await run(Safari.readBookmarks(path))).bar).toEqual([
        BookmarkLeaf.make({ name: "Saved", url: canonical }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
