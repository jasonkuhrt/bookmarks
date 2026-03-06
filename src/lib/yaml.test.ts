import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BookmarkFolder, BookmarkLeaf, BookmarksConfig, BookmarkTree, TargetProfile } from "./schema/__.js"
import * as YamlModule from "./yaml.js"

const leaf = (name: string, url: string) => new BookmarkLeaf({ name, url })
const folder = (name: string, children: Array<BookmarkLeaf | BookmarkFolder>) =>
  new BookmarkFolder({ name, children })

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)

describe("yaml", () => {
  test("save/load preserves sibling ordering and empty folders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-yaml-"))
    const yamlPath = join(dir, "bookmarks.yaml")

    try {
      const config = BookmarksConfig.make({
        targets: {
          safari: {
            default: TargetProfile.make({ path: "/tmp/safari-default.plist" }),
          },
        },
        base: new BookmarkTree({
          favorites_bar: [
            leaf("First", "https://first.example"),
            folder("Empty", []),
            folder("Nested", [leaf("Inside", "https://inside.example")]),
            leaf("Last", "https://last.example"),
          ],
        }),
        profiles: {
          "safari/default": new BookmarkTree({
            other: [
              folder("Profile Empty", []),
              leaf("Profile Bookmark", "https://profile.example"),
            ],
          }),
        },
      })

      await run(YamlModule.save(yamlPath, config))
      const loaded = await run(YamlModule.load(yamlPath))

      expect(loaded).toEqual(config)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
