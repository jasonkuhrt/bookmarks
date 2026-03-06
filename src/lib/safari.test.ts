import { describe, expect, test } from "bun:test"
import { serialize } from "@plist/binary.serialize"
import { DateTime, Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Patch from "./patch.js"
import { BookmarkFolder, BookmarkLeaf, BookmarkTree } from "./schema/__.js"
import * as Safari from "./safari.js"
import { writeSafariBookmarksFixture } from "./test-fixtures.js"

// -- Test helpers --

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)
const now = DateTime.unsafeNow()

const setupFixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bookmarks-safari-fixture-"))
  const path = join(dir, "Bookmarks.plist")
  await writeSafariBookmarksFixture(path)
  return { dir, path }
}

const withFixture = async <A>(fn: (path: string) => Promise<A>): Promise<A> => {
  const { dir, path } = await setupFixture()

  try {
    return await fn(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// -- readBookmarks --

describe("readBookmarks", () => {
  test("reads fixture Safari plist and produces a BookmarkTree", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path))
      expect(tree).toBeInstanceOf(BookmarkTree)
    })
  })

  test("bar contains folders from BookmarksBar", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path))
      expect(tree.bar).toBeDefined()
      expect(tree.bar!.length).toBeGreaterThan(0)
      const firstItem = tree.bar![0]!
      expect(firstItem).toBeInstanceOf(BookmarkFolder)
    })
  })

  test("reading_list contains leaves from com.apple.ReadingList", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path))
      expect(tree.reading_list).toBeDefined()
      expect(tree.reading_list!.length).toBeGreaterThan(0)
      const firstItem = tree.reading_list![0]!
      expect(firstItem).toBeInstanceOf(BookmarkLeaf)
      expect((firstItem as BookmarkLeaf).url).toMatch(/^https?:\/\//)
    })
  })

  test("other section collects root-level folders and BookmarksMenu content", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path))
      expect(tree.menu).toBeDefined()
      expect(tree.menu!.length).toBeGreaterThan(0)
    })
  })

  test("History proxy is excluded", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path))
      const allNames = [
        ...(tree.bar ?? []),
        ...(tree.menu ?? []),
        ...(tree.reading_list ?? []),
      ].map((n) => ("name" in n ? n.name : ""))
      expect(allNames).not.toContain("History")
    })
  })

  test("leaf nodes have name and url", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path))
      const leaf = tree.reading_list![0]! as BookmarkLeaf
      expect(leaf.name).toBeTruthy()
      expect(leaf.url).toBeTruthy()
      expect(leaf.url).toMatch(/^https?:\/\//)
    })
  })

  test("folder nodes have name and children", async () => {
    await withFixture(async (path) => {
      const tree = await run(Safari.readBookmarks(path))
      const folder = tree.bar![0]! as BookmarkFolder
      expect(folder.name).toBeTruthy()
      expect(Array.isArray(folder.children)).toBe(true)
    })
  })

  test("preserves sibling ordering and empty folders in a hermetic fixture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-safari-"))
    const path = join(dir, "Bookmarks.plist")

    try {
      await Bun.write(path, serialize({
        Children: [
          {
            WebBookmarkType: "WebBookmarkTypeList",
            Title: "BookmarksBar",
            Children: [
              {
                WebBookmarkType: "WebBookmarkTypeLeaf",
                URLString: "https://first.example",
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
                    URLString: "https://inside.example",
                    URIDictionary: { title: "Inside" },
                  },
                ],
              },
              {
                WebBookmarkType: "WebBookmarkTypeLeaf",
                URLString: "https://last.example",
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
      }))

      const tree = await run(Safari.readBookmarks(path))

      expect(tree.bar?.map((node) => node.name)).toEqual([
        "First",
        "Empty",
        "Nested",
        "Last",
      ])

      const emptyFolder = tree.bar?.[1]
      expect(emptyFolder).toBeInstanceOf(BookmarkFolder)
      expect((emptyFolder as BookmarkFolder).children).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses unsupported separator-like nodes that would otherwise be dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-safari-unsupported-"))
    const path = join(dir, "Bookmarks.plist")

    try {
      await Bun.write(path, serialize({
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
      }))

      await expect(run(Safari.readBookmarks(path))).rejects.toThrow("Bookmark separators are not supported")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// -- applyPatches --

describe("applyPatches", () => {
  const setupCopy = async () => {
    return setupFixture()
  }

  const cleanup = async (dir: string) => {
    await rm(dir, { recursive: true, force: true })
  }

  test("Add patch inserts a new leaf", async () => {
    const { dir, path } = await setupCopy()
    try {
      const testUrl = "https://test-bookmark-add.example.com/"
      const testName = "Test Add Bookmark"

      await run(Safari.applyPatches(path, [
        Patch.Add({ url: testUrl, name: testName, path: "bar", date: now }),
      ]))

      const tree = await run(Safari.readBookmarks(path))
      const found = (tree.bar ?? []).find(
        (n): n is BookmarkLeaf => BookmarkLeaf.is(n) && n.url === testUrl,
      )
      expect(found).toBeDefined()
      expect(found!.name).toBe(testName)
    } finally {
      await cleanup(dir)
    }
  })

  test("Remove patch deletes a leaf", async () => {
    const { dir, path } = await setupCopy()
    try {
      const treeBefore = await run(Safari.readBookmarks(path))
      const target = treeBefore.reading_list![0]! as BookmarkLeaf

      await run(Safari.applyPatches(path, [
        Patch.Remove({ url: target.url, name: target.name, path: "reading_list", date: now }),
      ]))

      const treeAfter = await run(Safari.readBookmarks(path))
      const remainingUrls = (treeAfter.reading_list ?? [])
        .filter((n): n is BookmarkLeaf => BookmarkLeaf.is(n))
        .map((n) => n.url)
      expect(remainingUrls).not.toContain(target.url)
    } finally {
      await cleanup(dir)
    }
  })

  test("Rename patch updates a leaf's title", async () => {
    const { dir, path } = await setupCopy()
    try {
      const treeBefore = await run(Safari.readBookmarks(path))
      const target = treeBefore.reading_list![0]! as BookmarkLeaf
      const newName = "RENAMED_TEST_BOOKMARK"

      await run(Safari.applyPatches(path, [
        Patch.Rename({ url: target.url, path: "reading_list", oldName: target.name, newName, date: now }),
      ]))

      const treeAfter = await run(Safari.readBookmarks(path))
      const found = (treeAfter.reading_list ?? []).find(
        (n): n is BookmarkLeaf => BookmarkLeaf.is(n) && n.url === target.url,
      )
      expect(found).toBeDefined()
      expect(found!.name).toBe(newName)
    } finally {
      await cleanup(dir)
    }
  })

  test("Move patch relocates a leaf to a different section", async () => {
    const { dir, path } = await setupCopy()
    try {
      const treeBefore = await run(Safari.readBookmarks(path))
      const target = treeBefore.reading_list![0]! as BookmarkLeaf

      await run(Safari.applyPatches(path, [
        Patch.Move({ url: target.url, name: target.name, fromPath: "reading_list", toPath: "bar", date: now }),
      ]))

      const treeAfter = await run(Safari.readBookmarks(path))

      // Gone from reading_list
      const remainingUrls = (treeAfter.reading_list ?? [])
        .filter((n): n is BookmarkLeaf => BookmarkLeaf.is(n))
        .map((n) => n.url)
      expect(remainingUrls).not.toContain(target.url)

      // Present in bar
      const found = (treeAfter.bar ?? []).find(
        (n): n is BookmarkLeaf => BookmarkLeaf.is(n) && n.url === target.url,
      )
      expect(found).toBeDefined()
      expect(found!.name).toBe(target.name)
    } finally {
      await cleanup(dir)
    }
  })

  test("Add patch into nested folder path creates folders as needed", async () => {
    const { dir, path } = await setupCopy()
    try {
      const testUrl = "https://test-nested-add.example.com/"
      const testName = "Nested Add Test"

      await run(Safari.applyPatches(path, [
        Patch.Add({ url: testUrl, name: testName, path: "menu/NewFolder/SubFolder", date: now }),
      ]))

      const tree = await run(Safari.readBookmarks(path))
      // Navigate: other → NewFolder → SubFolder → leaf
      const newFolder = (tree.menu ?? []).find(
        (n): n is BookmarkFolder => BookmarkFolder.is(n) && n.name === "NewFolder",
      )
      expect(newFolder).toBeDefined()
      const subFolder = newFolder!.children.find(
        (n): n is BookmarkFolder => BookmarkFolder.is(n) && n.name === "SubFolder",
      )
      expect(subFolder).toBeDefined()
      const leaf = subFolder!.children.find(
        (n): n is BookmarkLeaf => BookmarkLeaf.is(n) && n.url === testUrl,
      )
      expect(leaf).toBeDefined()
      expect(leaf!.name).toBe(testName)
    } finally {
      await cleanup(dir)
    }
  })
})

describe("writeTree", () => {
  test("writes structural changes exactly, including ordering and empty folders", async () => {
    const { dir, path } = await setupFixture()

    try {
      const desired = BookmarkTree.make({
        bar: [
          BookmarkLeaf.make({ name: "Top Link", url: "https://top.example" }),
          BookmarkFolder.make({
            name: "Favorites Folder",
            children: [
              BookmarkLeaf.make({ name: "Docs", url: "https://docs.example" }),
            ],
          }),
          BookmarkFolder.make({ name: "Empty", children: [] }),
        ],
        menu: [
          BookmarkLeaf.make({ name: "Menu Link", url: "https://menu.example" }),
          BookmarkFolder.make({
            name: "Loose Folder",
            children: [
              BookmarkLeaf.make({ name: "Loose Folder Link", url: "https://loose-folder.example" }),
            ],
          }),
          BookmarkLeaf.make({ name: "Loose Leaf", url: "https://loose.example" }),
        ],
        reading_list: [
          BookmarkLeaf.make({ name: "Reading Item", url: "https://reading.example" }),
        ],
      })

      await run(Safari.writeTree(path, desired))

      const reread = await run(Safari.readBookmarks(path))
      expect(reread).toEqual(desired)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
