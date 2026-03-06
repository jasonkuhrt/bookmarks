import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BookmarkFolder, BookmarkLeaf, BookmarksConfig, BookmarkTree, TargetProfile } from "./schema/__.js"
import * as Patch from "./patch.js"
import * as Sync from "./sync.js"
import * as YamlModule from "./yaml.js"

// -- Test helpers --

const leaf = (name: string, url: string) => new BookmarkLeaf({ name, url })
const folder = (name: string, children: Array<BookmarkLeaf | BookmarkFolder>) =>
  new BookmarkFolder({ name, children })

const emptyTree = () => new BookmarkTree({})

const run = <A>(effect: Effect.Effect<A, Error>) =>
  Effect.runPromise(effect)

const makeDate = (iso: string): DateTime.Utc =>
  DateTime.unsafeMake(iso)

const writeChromeFixture = async (path: string, names: readonly string[]) => {
  await Bun.write(path, JSON.stringify({
    checksum: "",
    version: 1,
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "Bookmarks Bar",
        id: "1",
        guid: "bookmark-bar",
        date_added: "0",
        date_modified: "0",
        children: names.map((name, index) => ({
          type: "url" as const,
          name,
          url: `https://${name.toLowerCase()}.example`,
          id: String(index + 2),
          guid: `guid-${index + 2}`,
          date_added: "0",
          date_last_used: "0",
        })),
      },
      other: {
        type: "folder",
        name: "Other Bookmarks",
        id: "10",
        guid: "other",
        date_added: "0",
        date_modified: "0",
        children: [],
      },
      synced: {
        type: "folder",
        name: "Mobile Bookmarks",
        id: "11",
        guid: "mobile",
        date_added: "0",
        date_modified: "0",
        children: [],
      },
    },
  }, null, 2))
}

// -- resolveConflicts --

describe("resolveConflicts", () => {
  test("non-overlapping patches: all applied, none graveyarded", async () => {
    const yamlPatches = [Patch.Add({ url: "https://a.com", name: "A", path: "favorites_bar", date: makeDate("2025-01-01") })]
    const browserPatches = [Patch.Add({ url: "https://b.com", name: "B", path: "favorites_bar", date: makeDate("2025-01-01") })]

    const result = await run(Sync.resolveConflicts(yamlPatches, browserPatches))
    expect(result.apply.length).toBe(2)
    expect(result.graveyard.length).toBe(0)
  })

  test("conflicting URL: newest wins", async () => {
    const older = makeDate("2025-01-01")
    const newer = makeDate("2025-06-01")

    const yamlPatches = [Patch.Add({ url: "https://conflict.com", name: "YAML Version", path: "favorites_bar", date: older })]
    const browserPatches = [Patch.Add({ url: "https://conflict.com", name: "Browser Version", path: "favorites_bar", date: newer })]

    const result = await run(Sync.resolveConflicts(yamlPatches, browserPatches))
    expect(result.apply.length).toBe(1)
    expect(result.graveyard.length).toBe(1)

    // Browser is newer → browser wins
    const applied = result.apply[0]!
    expect(Patch.$is("Add")(applied)).toBe(true)
    if (Patch.$is("Add")(applied)) {
      expect(applied.name).toBe("Browser Version")
    }
    const graveyarded = result.graveyard[0]!
    if (Patch.$is("Add")(graveyarded)) {
      expect(graveyarded.name).toBe("YAML Version")
    }
  })

  test("tie-break: YAML wins when dates are equal", async () => {
    const sameDate = makeDate("2025-03-15")

    const yamlPatches = [Patch.Add({ url: "https://tie.com", name: "YAML", path: "favorites_bar", date: sameDate })]
    const browserPatches = [Patch.Add({ url: "https://tie.com", name: "Browser", path: "favorites_bar", date: sameDate })]

    const result = await run(Sync.resolveConflicts(yamlPatches, browserPatches))
    expect(result.apply.length).toBe(1)
    expect(result.graveyard.length).toBe(1)
    const applied = result.apply[0]!
    if (Patch.$is("Add")(applied)) {
      expect(applied.name).toBe("YAML")
    }
  })

  test("empty inputs produce empty results", async () => {
    const result = await run(Sync.resolveConflicts([], []))
    expect(result.apply.length).toBe(0)
    expect(result.graveyard.length).toBe(0)
  })

  test("one side empty: all from other side applied", async () => {
    const patches = [
      Patch.Add({ url: "https://a.com", name: "A", path: "favorites_bar", date: makeDate("2025-01-01") }),
      Patch.Remove({ url: "https://b.com", path: "favorites_bar", date: makeDate("2025-01-01") }),
    ]
    const result = await run(Sync.resolveConflicts(patches, []))
    expect(result.apply.length).toBe(2)
    expect(result.graveyard.length).toBe(0)
  })
})

// -- applyPatches --

describe("applyPatches", () => {
  test("add to empty tree creates section and leaf", async () => {
    const tree = emptyTree()
    const patches = [
      Patch.Add({ url: "https://a.com", name: "A", path: "favorites_bar", date: makeDate("2025-01-01") }),
    ]
    const result = await run(Sync.applyPatches(tree, patches))
    expect(result.favorites_bar).toBeDefined()
    expect(result.favorites_bar!.length).toBe(1)
    const node = result.favorites_bar![0] as BookmarkLeaf
    expect(node.name).toBe("A")
    expect(node.url).toBe("https://a.com")
  })

  test("add to nested folder path creates folders", async () => {
    const tree = emptyTree()
    const patches = [
      Patch.Add({ url: "https://gpt.com", name: "ChatGPT", path: "favorites_bar/AI/Tools", date: makeDate("2025-01-01") }),
    ]
    const result = await run(Sync.applyPatches(tree, patches))
    expect(result.favorites_bar).toBeDefined()

    const aiFolder = result.favorites_bar!.find(
      (n) => BookmarkFolder.is(n) && n.name === "AI",
    ) as BookmarkFolder
    expect(aiFolder).toBeDefined()

    const toolsFolder = aiFolder.children.find(
      (n) => BookmarkFolder.is(n) && n.name === "Tools",
    ) as BookmarkFolder
    expect(toolsFolder).toBeDefined()

    const gpt = toolsFolder.children.find(
      (n) => BookmarkLeaf.is(n) && n.url === "https://gpt.com",
    ) as BookmarkLeaf
    expect(gpt).toBeDefined()
    expect(gpt.name).toBe("ChatGPT")
  })

  test("remove deletes leaf from tree", async () => {
    const tree = new BookmarkTree({
      favorites_bar: [leaf("A", "https://a.com"), leaf("B", "https://b.com")],
    })
    const patches = [
      Patch.Remove({ url: "https://a.com", path: "favorites_bar", date: makeDate("2025-01-01") }),
    ]
    const result = await run(Sync.applyPatches(tree, patches))
    expect(result.favorites_bar).toBeDefined()
    expect(result.favorites_bar!.length).toBe(1)
    const remaining = result.favorites_bar![0] as BookmarkLeaf
    expect(remaining.url).toBe("https://b.com")
  })

  test("remove last leaf prunes empty section", async () => {
    const tree = new BookmarkTree({
      favorites_bar: [leaf("A", "https://a.com")],
      other: [leaf("B", "https://b.com")],
    })
    const patches = [
      Patch.Remove({ url: "https://a.com", path: "favorites_bar", date: makeDate("2025-01-01") }),
    ]
    const result = await run(Sync.applyPatches(tree, patches))
    expect(result.favorites_bar).toBeUndefined()
    expect(result.other).toBeDefined()
  })

  test("rename changes leaf name, preserves URL and position", async () => {
    const tree = new BookmarkTree({
      favorites_bar: [leaf("Old Name", "https://a.com")],
    })
    const patches = [
      Patch.Rename({ url: "https://a.com", oldName: "Old Name", newName: "New Name", date: makeDate("2025-01-01") }),
    ]
    const result = await run(Sync.applyPatches(tree, patches))
    expect(result.favorites_bar).toBeDefined()
    const node = result.favorites_bar!.find(
      (n) => BookmarkLeaf.is(n) && n.url === "https://a.com",
    ) as BookmarkLeaf
    expect(node).toBeDefined()
    expect(node.name).toBe("New Name")
  })

  test("move relocates leaf between sections", async () => {
    const tree = new BookmarkTree({
      favorites_bar: [leaf("A", "https://a.com")],
    })
    const patches = [
      Patch.Move({ url: "https://a.com", fromPath: "favorites_bar", toPath: "other", date: makeDate("2025-01-01") }),
    ]
    const result = await run(Sync.applyPatches(tree, patches))
    expect(result.favorites_bar).toBeUndefined()
    expect(result.other).toBeDefined()
    const node = result.other!.find(
      (n) => BookmarkLeaf.is(n) && n.url === "https://a.com",
    ) as BookmarkLeaf
    expect(node).toBeDefined()
    expect(node.name).toBe("A")
  })

  test("multiple patches applied in correct order", async () => {
    const tree = new BookmarkTree({
      favorites_bar: [leaf("ToRemove", "https://remove.com"), leaf("ToRename", "https://rename.com")],
    })
    const patches = [
      Patch.Remove({ url: "https://remove.com", path: "favorites_bar", date: makeDate("2025-01-01") }),
      Patch.Rename({ url: "https://rename.com", oldName: "ToRename", newName: "Renamed", date: makeDate("2025-01-01") }),
      Patch.Add({ url: "https://new.com", name: "New", path: "favorites_bar", date: makeDate("2025-01-01") }),
    ]
    const result = await run(Sync.applyPatches(tree, patches))
    expect(result.favorites_bar).toBeDefined()

    const urls = result.favorites_bar!
      .filter((n): n is BookmarkLeaf => BookmarkLeaf.is(n))
      .map((n) => n.url)

    expect(urls).toContain("https://rename.com")
    expect(urls).toContain("https://new.com")
    expect(urls).not.toContain("https://remove.com")

    const renamed = result.favorites_bar!.find(
      (n) => BookmarkLeaf.is(n) && n.url === "https://rename.com",
    ) as BookmarkLeaf
    expect(renamed.name).toBe("Renamed")
  })

  test("empty patches returns tree unchanged", async () => {
    const tree = new BookmarkTree({
      favorites_bar: [leaf("A", "https://a.com")],
    })
    const result = await run(Sync.applyPatches(tree, []))
    expect(result.favorites_bar).toBeDefined()
    expect(result.favorites_bar!.length).toBe(1)
  })

  test("empty patches preserve sibling ordering and empty folders", async () => {
    const tree = new BookmarkTree({
      favorites_bar: [
        leaf("First", "https://first.example"),
        folder("Empty", []),
        folder("Nested", [leaf("Inside", "https://inside.example")]),
        leaf("Last", "https://last.example"),
      ],
      other: [folder("Other Empty", [])],
    })

    const result = await run(Sync.applyPatches(tree, []))

    expect(result).toEqual(tree)
  })

  test("remove preserves folders that become empty", async () => {
    const tree = new BookmarkTree({
      favorites_bar: [
        folder("Projects", [leaf("Only", "https://only.example")]),
      ],
    })

    const result = await run(Sync.applyPatches(tree, [
      Patch.Remove({ url: "https://only.example", path: "favorites_bar/Projects", date: makeDate("2025-01-01") }),
    ]))

    expect(result).toEqual(new BookmarkTree({
      favorites_bar: [folder("Projects", [])],
    }))
  })
})

describe("decomposeResolvedTrees", () => {
  test("extracts common bookmarks into base and profile-specific bookmarks into overlays", () => {
    const targets = {
      safari: {
        default: TargetProfile.make({ path: "/tmp/safari-default.plist" }),
      },
      chrome: {
        work: TargetProfile.make({ path: "/tmp/chrome-work.json" }),
      },
    }

    const safariTree = new BookmarkTree({
      favorites_bar: [
        folder("Shared", [leaf("Common", "https://common.example")]),
        leaf("Safari Only", "https://safari-only.example"),
      ],
    })
    const chromeTree = new BookmarkTree({
      favorites_bar: [
        folder("Shared", [leaf("Common", "https://common.example")]),
        leaf("Chrome Only", "https://chrome-only.example"),
      ],
    })

    const config = Sync.decomposeResolvedTrees(targets, {
      "safari/default": safariTree,
      "chrome/work": chromeTree,
    })

    expect(config.base.favorites_bar).toBeDefined()
    const sharedFolder = config.base.favorites_bar!.find(
      (node): node is BookmarkFolder => BookmarkFolder.is(node) && node.name === "Shared",
    )
    expect(sharedFolder).toBeDefined()
    expect(sharedFolder!.children.length).toBe(1)

    expect(config.profiles?.["safari/default"]?.favorites_bar).toBeDefined()
    expect(config.profiles?.["chrome/work"]?.favorites_bar).toBeDefined()

    const safariOnly = config.profiles?.["safari/default"]?.favorites_bar?.find(
      (node): node is BookmarkLeaf => BookmarkLeaf.is(node),
    )
    const chromeOnly = config.profiles?.["chrome/work"]?.favorites_bar?.find(
      (node): node is BookmarkLeaf => BookmarkLeaf.is(node),
    )
    expect(safariOnly?.url).toBe("https://safari-only.example")
    expect(chromeOnly?.url).toBe("https://chrome-only.example")
  })

  test("omits profile overlays when every resolved tree is identical", () => {
    const targets = {
      safari: {
        default: TargetProfile.make({ path: "/tmp/safari-default.plist" }),
      },
      chrome: {
        default: TargetProfile.make({ path: "/tmp/chrome-default.json" }),
      },
    }

    const sharedTree = new BookmarkTree({
      other: [leaf("Shared", "https://shared.example")],
    })

    const config = Sync.decomposeResolvedTrees(targets, {
      "safari/default": sharedTree,
      "chrome/default": sharedTree,
    })

    expect(config.base.other).toBeDefined()
    expect(config.base.other!.length).toBe(1)
    expect(config.profiles).toBeUndefined()
  })

  test("preserves exact resolved ordering when shared bookmarks diverge after the prefix", async () => {
    const targets = {
      safari: {
        default: TargetProfile.make({ path: "/tmp/safari-default.plist" }),
      },
      chrome: {
        work: TargetProfile.make({ path: "/tmp/chrome-work.json" }),
      },
    }

    const safariTree = new BookmarkTree({
      favorites_bar: [
        leaf("Common A", "https://common-a.example"),
        leaf("Safari Only", "https://safari-only.example"),
        folder("Shared Empty", []),
        leaf("Common B", "https://common-b.example"),
      ],
    })

    const chromeTree = new BookmarkTree({
      favorites_bar: [
        leaf("Common A", "https://common-a.example"),
        leaf("Chrome Only", "https://chrome-only.example"),
        folder("Shared Empty", []),
        leaf("Common B", "https://common-b.example"),
      ],
    })

    const config = Sync.decomposeResolvedTrees(targets, {
      "safari/default": safariTree,
      "chrome/work": chromeTree,
    })

    expect(config.base.favorites_bar?.map((node) => node.name)).toEqual(["Common A"])

    const safariResolved = await run(YamlModule.resolveProfile(config, "safari/default"))
    const chromeResolved = await run(YamlModule.resolveProfile(config, "chrome/work"))

    expect(safariResolved).toEqual(safariTree)
    expect(chromeResolved).toEqual(chromeTree)
  })
})

describe("push", () => {
  test("refuses structural-only YAML changes that cannot be projected exactly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-"))
    const chromePath = join(dir, "Bookmarks")

    try {
      await writeChromeFixture(chromePath, ["First", "Last"])

      const config = BookmarksConfig.make({
        targets: {
          chrome: {
            default: TargetProfile.make({ path: chromePath }),
          },
        },
        base: new BookmarkTree({
          favorites_bar: [
            leaf("First", "https://first.example"),
            folder("Empty", []),
            leaf("Last", "https://last.example"),
          ],
        }),
      })

      await expect(run(Sync.push({
        yamlPath: join(dir, "bookmarks.yaml"),
        yamlOverride: config,
        dryRun: true,
      }))).rejects.toThrow("Cannot safely push structural bookmark changes")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses duplicate URLs in YAML with actionable diagnostics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-duplicates-"))
    const chromePath = join(dir, "Bookmarks")

    try {
      await writeChromeFixture(chromePath, ["First"])

      const config = BookmarksConfig.make({
        targets: {
          chrome: {
            default: TargetProfile.make({ path: chromePath }),
          },
        },
        base: new BookmarkTree({
          favorites_bar: [
            leaf("First Copy", "https://dup.example"),
            leaf("Second Copy", "https://dup.example"),
          ],
        }),
      })

      await expect(run(Sync.push({
        yamlPath: join(dir, "bookmarks.yaml"),
        yamlOverride: config,
        dryRun: true,
      }))).rejects.toThrow('Duplicate URL "https://dup.example"')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("fails clearly for permanently missing configured targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-missing-target-"))

    try {
      const config = BookmarksConfig.make({
        targets: {
          chrome: {
            default: TargetProfile.make({ path: join(dir, "missing-Bookmarks") }),
          },
        },
        base: new BookmarkTree({
          favorites_bar: [leaf("First", "https://first.example")],
        }),
      })

      await expect(run(Sync.push({
        yamlPath: join(dir, "bookmarks.yaml"),
        yamlOverride: config,
      }))).rejects.toThrow("Target unavailable")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("defers when another sync already holds the runtime lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-push-locked-"))
    const chromePath = join(dir, "Bookmarks")
    const runtimeDir = join(dir, "runtime")
    const originalRuntimeDir = process.env["BOOKMARKS_RUNTIME_DIR"]

    try {
      process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir
      await writeChromeFixture(chromePath, ["First"])
      await mkdir(runtimeDir, { recursive: true })
      await Bun.write(join(runtimeDir, "sync.lock.json"), JSON.stringify({
        pid: process.pid,
        operation: "sync",
        yamlPath: join(dir, "bookmarks.yaml"),
        acquiredAt: "2026-01-01T00:00:00.000Z",
      }))

      const config = BookmarksConfig.make({
        targets: {
          chrome: {
            default: TargetProfile.make({ path: chromePath }),
          },
        },
        base: new BookmarkTree({
          favorites_bar: [leaf("First", "https://first.example")],
        }),
      })

      const result = await run(Sync.push({
        yamlPath: join(dir, "bookmarks.yaml"),
        yamlOverride: config,
      }))

      expect(result.applied).toHaveLength(0)
      expect(result.orchestration?.state).toBe("busy")
      expect(result.orchestration?.message).toContain("already running")
    } finally {
      if (originalRuntimeDir === undefined) {
        delete process.env["BOOKMARKS_RUNTIME_DIR"]
      } else {
        process.env["BOOKMARKS_RUNTIME_DIR"] = originalRuntimeDir
      }
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("pull", () => {
  test("refuses unsupported separator constructs before mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-pull-separator-"))
    const chromePath = join(dir, "Bookmarks")

    try {
      await Bun.write(chromePath, JSON.stringify({
        checksum: "",
        version: 1,
        roots: {
          bookmark_bar: {
            type: "folder",
            name: "Bookmarks Bar",
            id: "1",
            guid: "bookmark-bar",
            date_added: "0",
            date_modified: "0",
            children: [
              {
                type: "separator",
                id: "2",
                guid: "separator",
                name: "",
                date_added: "0",
                date_modified: "0",
              },
            ],
          },
          other: {
            type: "folder",
            name: "Other Bookmarks",
            id: "10",
            guid: "other",
            date_added: "0",
            date_modified: "0",
            children: [],
          },
          synced: {
            type: "folder",
            name: "Mobile Bookmarks",
            id: "11",
            guid: "mobile",
            date_added: "0",
            date_modified: "0",
            children: [],
          },
        },
      }, null, 2))

      const config = BookmarksConfig.make({
        targets: {
          chrome: {
            default: TargetProfile.make({ path: chromePath }),
          },
        },
        base: new BookmarkTree({}),
      })

      await expect(run(Sync.pull({
        yamlPath: join(dir, "bookmarks.yaml"),
        yamlOverride: config,
        dryRun: true,
      }))).rejects.toThrow("Bookmark separators are not supported")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
