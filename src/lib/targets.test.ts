import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Targets from "./targets.js"

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)

describe("targets", () => {
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
})
