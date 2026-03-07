import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Chrome from "./chrome.ts";
import * as Patch from "./patch.ts";
import { BookmarkFolder, BookmarkLeaf, type BookmarkNode, BookmarkTree } from "./schema/__.ts";
import { CHROME_BOOKMARKS_FIXTURE_PATH, copyChromeBookmarksFixture } from "./test-fixtures.ts";

// -- Test helpers --

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);
const now = DateTime.unsafeNow();

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

type ChromeChecksumFixture = {
  readonly roots: Parameters<typeof Chrome.calculateChecksum>[0];
  readonly checksum: string;
};

const readChecksumFixture = async (path: string): Promise<ChromeChecksumFixture> => {
  const value: unknown = JSON.parse(await Bun.file(path).text());
  if (!isRecord(value) || !("roots" in value) || typeof value["checksum"] !== "string") {
    throw new Error(`Expected Chrome checksum fixture shape in ${path}`);
  }
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Fixture JSON is repository-controlled and matches Chrome's root object shape.
    roots: value["roots"] as ChromeChecksumFixture["roots"],
    checksum: value["checksum"],
  };
};

const findLeaf = (nodes: readonly BookmarkNode[]): BookmarkLeaf | undefined => {
  for (const node of nodes) {
    if (BookmarkLeaf.is(node)) return node;
    if (BookmarkFolder.is(node)) {
      const found = findLeaf(node.children);
      if (found) return found;
    }
  }
  return undefined;
};

const findLeafByUrl = (nodes: readonly BookmarkNode[], url: string): BookmarkLeaf | undefined => {
  for (const node of nodes) {
    if (BookmarkLeaf.is(node) && node.url === url) return node;
    if (BookmarkFolder.is(node)) {
      const found = findLeafByUrl(node.children, url);
      if (found) return found;
    }
  }
  return undefined;
};

const collectUrls = (nodes: readonly BookmarkNode[]): string[] => {
  const urls: string[] = [];
  for (const node of nodes) {
    if (BookmarkLeaf.is(node)) urls.push(node.url);
    if (BookmarkFolder.is(node)) urls.push(...collectUrls(node.children));
  }
  return urls;
};

// -- Timestamp conversion --

describe("chromeTimestampToUnixMs", () => {
  test("converts a known Chrome timestamp to a reasonable date", () => {
    // 13410289672995717 should decode to approximately 2025-12-15
    const unixMs = Chrome.chromeTimestampToUnixMs("13410289672995717");
    const date = new Date(unixMs);
    expect(date.getFullYear()).toBeGreaterThanOrEqual(2020);
    expect(date.getFullYear()).toBeLessThanOrEqual(2030);
  });

  test("zero returns zero", () => {
    expect(Chrome.chromeTimestampToUnixMs("0")).toBe(0);
  });

  test("round-trips through unixMsToChromeTimestamp within 1 second", () => {
    const original = Date.now();
    const chromeTs = Chrome.unixMsToChromeTimestamp(original);
    const roundTripped = Chrome.chromeTimestampToUnixMs(chromeTs);
    // Precision loss is sub-second due to microsecond → second → microsecond
    expect(Math.abs(original - roundTripped)).toBeLessThan(1000);
  });
});

describe("unixMsToChromeTimestamp", () => {
  test("produces a large numeric string (Windows epoch microseconds)", () => {
    const ts = Chrome.unixMsToChromeTimestamp(Date.now());
    expect(ts.length).toBeGreaterThan(15);
    expect(Number(ts)).toBeGreaterThan(13_000_000_000_000_000);
  });
});

// -- Checksum --

describe("calculateChecksum", () => {
  test("matches the stored checksum in the fixture Chrome bookmarks file", async () => {
    const fixture = await readChecksumFixture(CHROME_BOOKMARKS_FIXTURE_PATH);
    const calculated = Chrome.calculateChecksum(fixture.roots);
    expect(calculated).toBe(fixture.checksum);
  });

  test("produces a 32-character hex string", async () => {
    const fixture = await readChecksumFixture(CHROME_BOOKMARKS_FIXTURE_PATH);
    const checksum = Chrome.calculateChecksum(fixture.roots);
    expect(checksum).toMatch(/^[0-9a-f]{32}$/);
  });
});

// -- readBookmarks --

describe("readBookmarks", () => {
  test("reads fixture Chrome bookmarks and produces a BookmarkTree", async () => {
    const tree = await run(Chrome.readBookmarks(CHROME_BOOKMARKS_FIXTURE_PATH));
    expect(tree).toBeInstanceOf(BookmarkTree);
  });

  test("bar contains bookmarks from bookmark_bar", async () => {
    const tree = await run(Chrome.readBookmarks(CHROME_BOOKMARKS_FIXTURE_PATH));
    const bar = expectDefined(tree.bar, "expected bookmarks bar section");
    expect(bar.length).toBeGreaterThan(0);
  });

  test("leaf nodes have name and url", async () => {
    const tree = await run(Chrome.readBookmarks(CHROME_BOOKMARKS_FIXTURE_PATH));
    const leaf = findLeaf(tree.bar ?? []);
    const foundLeaf = expectDefined(leaf, "expected leaf bookmark in bar");
    expect(foundLeaf.name).toBeTruthy();
    expect(foundLeaf.url).toMatch(/^https?:\/\//);
  });

  test("folder nodes have name and children", async () => {
    const tree = await run(Chrome.readBookmarks(CHROME_BOOKMARKS_FIXTURE_PATH));
    const folder = expectFolder(
      tree.bar?.find((node): node is BookmarkFolder => BookmarkFolder.is(node)),
      "expected folder bookmark in bar",
    );
    expect(folder.name).toBeTruthy();
    expect(Array.isArray(folder.children)).toBe(true);
  });

  test("preserves sibling ordering and empty folders in a hermetic fixture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-chrome-"));
    const path = join(dir, "Bookmarks");

    try {
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
                    name: "First",
                    url: "https://first.example",
                    id: "2",
                    guid: "first",
                    date_added: "0",
                    date_last_used: "0",
                  },
                  {
                    type: "folder",
                    name: "Empty",
                    children: [],
                    id: "3",
                    guid: "empty",
                    date_added: "0",
                    date_modified: "0",
                    date_last_used: "0",
                  },
                  {
                    type: "folder",
                    name: "Nested",
                    children: [
                      {
                        type: "url",
                        name: "Inside",
                        url: "https://inside.example",
                        id: "5",
                        guid: "inside",
                        date_added: "0",
                        date_last_used: "0",
                      },
                    ],
                    id: "4",
                    guid: "nested",
                    date_added: "0",
                    date_modified: "0",
                    date_last_used: "0",
                  },
                  {
                    type: "url",
                    name: "Last",
                    url: "https://last.example",
                    id: "6",
                    guid: "last",
                    date_added: "0",
                    date_last_used: "0",
                  },
                ],
              },
              other: {
                type: "folder",
                name: "Other Bookmarks",
                id: "7",
                guid: "root-other",
                date_added: "0",
                date_modified: "0",
                children: [],
              },
              synced: {
                type: "folder",
                name: "Mobile Bookmarks",
                id: "8",
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

      const tree = await run(Chrome.readBookmarks(path));

      expect(tree.bar?.map((node) => node.name)).toEqual(["First", "Empty", "Nested", "Last"]);

      const emptyFolder = tree.bar?.[1];
      const folder = expectFolder(emptyFolder, 'expected "Empty" folder');
      expect(folder.children).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses separator nodes that would otherwise be dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-chrome-unsupported-"));
    const path = join(dir, "Bookmarks");

    try {
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
                    type: "separator",
                    name: "",
                    id: "2",
                    guid: "separator",
                    date_added: "0",
                    date_modified: "0",
                  },
                ],
              },
              other: {
                type: "folder",
                name: "Other Bookmarks",
                id: "7",
                guid: "root-other",
                date_added: "0",
                date_modified: "0",
                children: [],
              },
              synced: {
                type: "folder",
                name: "Mobile Bookmarks",
                id: "8",
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

      await expectRejects(run(Chrome.readBookmarks(path)), "Bookmark separators are not supported");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// -- applyPatches --

describe("applyPatches", () => {
  const setupCopy = async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-chrome-patches-"));
    const path = join(dir, "Bookmarks");
    await copyChromeBookmarksFixture(path);
    return { dir, path };
  };

  const cleanup = async (dir: string) => rm(dir, { recursive: true, force: true });

  test("Add patch inserts a new leaf", async () => {
    const { dir, path } = await setupCopy();
    try {
      const testUrl = "https://test-chrome-add.example.com/";
      const testName = "Test Chrome Add Bookmark";

      await run(
        Chrome.applyPatches(path, [
          Patch.Add({ url: testUrl, name: testName, path: "bar", date: now }),
        ]),
      );

      const tree = await run(Chrome.readBookmarks(path));
      const found = (tree.bar ?? []).find(
        (n): n is BookmarkLeaf => BookmarkLeaf.is(n) && n.url === testUrl,
      );
      expect(expectLeaf(found, "expected inserted bookmark").name).toBe(testName);
    } finally {
      await cleanup(dir);
    }
  });

  test("Add patch preserves valid checksum", async () => {
    const { dir, path } = await setupCopy();
    try {
      await run(
        Chrome.applyPatches(path, [
          Patch.Add({
            url: "https://test-checksum.example.com/",
            name: "Checksum Test",
            path: "bar",
            date: now,
          }),
        ]),
      );

      const fixture = await readChecksumFixture(path);
      const calculated = Chrome.calculateChecksum(fixture.roots);
      expect(calculated).toBe(fixture.checksum);
    } finally {
      await cleanup(dir);
    }
  });

  test("Remove patch deletes a leaf", async () => {
    const { dir, path } = await setupCopy();
    try {
      const treeBefore = await run(Chrome.readBookmarks(path));
      const target = expectDefined(findLeaf(treeBefore.bar ?? []), "expected bookmark to remove");

      await run(
        Chrome.applyPatches(path, [
          Patch.Remove({ url: target.url, name: target.name, path: "bar", date: now }),
        ]),
      );

      const treeAfter = await run(Chrome.readBookmarks(path));
      expect(collectUrls(treeAfter.bar ?? [])).not.toContain(target.url);
    } finally {
      await cleanup(dir);
    }
  });

  test("Rename patch updates a leaf's name", async () => {
    const { dir, path } = await setupCopy();
    try {
      const treeBefore = await run(Chrome.readBookmarks(path));
      const target = expectDefined(findLeaf(treeBefore.bar ?? []), "expected bookmark to rename");
      const newName = "RENAMED_CHROME_TEST_BOOKMARK";

      await run(
        Chrome.applyPatches(path, [
          Patch.Rename({
            url: target.url,
            path: "bar",
            oldName: target.name,
            newName,
            date: now,
          }),
        ]),
      );

      const treeAfter = await run(Chrome.readBookmarks(path));
      const found = expectLeaf(
        findLeafByUrl(treeAfter.bar ?? [], target.url),
        "expected renamed bookmark",
      );
      expect(found.name).toBe(newName);
    } finally {
      await cleanup(dir);
    }
  });

  test("Move patch relocates a leaf to a different section", async () => {
    const { dir, path } = await setupCopy();
    try {
      const treeBefore = await run(Chrome.readBookmarks(path));
      const target = expectDefined(findLeaf(treeBefore.bar ?? []), "expected bookmark to move");

      await run(
        Chrome.applyPatches(path, [
          Patch.Move({
            url: target.url,
            name: target.name,
            fromPath: "bar",
            toPath: "menu",
            date: now,
          }),
        ]),
      );

      const treeAfter = await run(Chrome.readBookmarks(path));

      // Gone from bar
      expect(collectUrls(treeAfter.bar ?? [])).not.toContain(target.url);

      // Present in other
      const foundInOther = collectUrls(treeAfter.menu ?? []);
      expect(foundInOther).toContain(target.url);
    } finally {
      await cleanup(dir);
    }
  });

  test("Add patch into nested folder path creates folders as needed", async () => {
    const { dir, path } = await setupCopy();
    try {
      const testUrl = "https://test-chrome-nested-add.example.com/";
      const testName = "Nested Chrome Add Test";

      await run(
        Chrome.applyPatches(path, [
          Patch.Add({
            url: testUrl,
            name: testName,
            path: "menu/NewFolder/SubFolder",
            date: now,
          }),
        ]),
      );

      const tree = await run(Chrome.readBookmarks(path));
      // Navigate: menu -> NewFolder -> SubFolder -> leaf
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
});

describe("writeTree", () => {
  test("writes structural changes exactly, including ordering and empty folders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-chrome-write-tree-"));
    const path = join(dir, "Bookmarks.json");

    try {
      await copyChromeBookmarksFixture(path);

      const desired = BookmarkTree.make({
        bar: [
          BookmarkLeaf.make({ name: "Top Link", url: "https://top.example" }),
          BookmarkFolder.make({ name: "Empty", children: [] }),
          BookmarkFolder.make({
            name: "Work",
            children: [BookmarkLeaf.make({ name: "Docs", url: "https://docs.example" })],
          }),
          BookmarkLeaf.make({ name: "Move Me", url: "https://move.example" }),
        ],
        menu: [BookmarkLeaf.make({ name: "Other Link", url: "https://other.example" })],
      });

      await run(Chrome.writeTree(path, desired));

      const reread = await run(Chrome.readBookmarks(path));
      expect(reread).toEqual(desired);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
