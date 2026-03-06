import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { serialize } from "@plist/binary.serialize"
import { Effect } from "effect"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Targets from "./targets.js"

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)

describe("targets", () => {
  test("discoverSafariTargets reads Safari profiles from SafariTabs.db", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-safari-targets-"))
    const plistPath = join(dir, "Bookmarks.plist")
    const tabsDbPath = join(dir, "SafariTabs.db")

    try {
      await Bun.write(plistPath, serialize({ Children: [] }))

      const db = new Database(tabsDbPath)
      try {
        db.run(
          "create table bookmarks (id integer primary key, parent integer, type integer, subtype integer, title text, external_uuid text, extra_attributes blob)",
        )
        db.run(
          "insert into bookmarks (id, parent, type, subtype, title, external_uuid, extra_attributes) values (?, ?, ?, ?, ?, ?, ?)",
          [
            35,
            0,
            1,
            2,
            null,
            "DefaultProfile",
            Buffer.from(serialize({
              "com.apple.Bookmark": { DateAdded: new Date("2026-03-06T00:00:00.000Z") },
              SymbolImageName: "bicycle",
            })),
          ],
        )
        db.run(
          "insert into bookmarks (id, parent, type, subtype, title, external_uuid, extra_attributes) values (?, ?, ?, ?, ?, ?, ?)",
          [
            201,
            0,
            1,
            2,
            "Heartbeat",
            "FB6E52DB-8796-4D8F-88E2-7EB82D9D0FD5",
            Buffer.from(serialize({
              CustomFavoritesFolderServerID: "Favorites Bar",
              "com.apple.Bookmark": { DateAdded: new Date("2026-03-06T00:00:00.000Z") },
              SymbolImageName: "hammer.fill",
            })),
          ],
        )
      } finally {
        db.close()
      }

      const targets = await run(Targets.discoverSafariTargets(plistPath, tabsDbPath))
      expect(targets.map(Targets.keyOf)).toEqual([
        "safari/default",
        "safari/heartbeat",
      ])
      expect(targets.map((target) => target.bookmarkScope)).toEqual([
        "Favorites Bar",
        "Favorites Bar",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("discoverChromeTargets reads profile directories from Local State", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-targets-"))

    try {
      await mkdir(join(dir, "Default"), { recursive: true })
      await mkdir(join(dir, "Profile 1"), { recursive: true })
      await mkdir(join(dir, "System Profile"), { recursive: true })
      await Bun.write(join(dir, "Default", "Bookmarks"), "{}")
      await Bun.write(join(dir, "Profile 1", "Bookmarks"), "{}")
      await Bun.write(join(dir, "Local State"), JSON.stringify({
        profile: {
          info_cache: {
            Default: {},
            "Profile 1": {},
            "System Profile": {},
          },
        },
      }))

      const targets = await run(Targets.discoverChromeTargets(dir))
      expect(targets.map(Targets.keyOf)).toEqual([
        "chrome/default",
        "chrome/profile-1",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("resolveTargetSelectors treats bare browser selectors as all profiles", async () => {
    const targets = [
      { browser: "chrome", profile: "default", path: "/tmp/default", enabled: true },
      { browser: "chrome", profile: "profile-1", path: "/tmp/profile-1", enabled: true },
      { browser: "safari", profile: "default", path: "/tmp/safari", enabled: true },
    ] as const

    const resolved = await run(Targets.resolveTargetSelectors(targets, ["chrome"]))
    expect(resolved.map(Targets.keyOf)).toEqual([
      "chrome/default",
      "chrome/profile-1",
    ])
  })

  test("resolveTargetSelectors fails clearly for unknown exact profile selectors", async () => {
    const targets = [
      { browser: "chrome", profile: "default", path: "/tmp/default", enabled: true },
    ] as const

    await expect(run(Targets.resolveTargetSelectors(targets, ["chrome/defualt"]))).rejects.toThrow(
      'Unknown target selector "chrome/defualt"',
    )
  })

  test("resolveTargetSelectors fails clearly when Safari profiles share one bookmark scope", async () => {
    const targets = [
      { browser: "safari", profile: "default", path: "/tmp/Bookmarks.plist", enabled: true, bookmarkScope: "Favorites Bar" },
      { browser: "safari", profile: "heartbeat", path: "/tmp/Bookmarks.plist", enabled: true, bookmarkScope: "Favorites Bar" },
    ] as const

    await expect(run(Targets.resolveTargetSelectors(targets, ["safari"]))).rejects.toThrow(
      'Safari profiles share the same bookmarks scope "Favorites Bar": safari/default, safari/heartbeat.',
    )
  })
})
