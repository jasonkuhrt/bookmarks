import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyChromeBookmarksFixture } from "../lib/test-fixtures.js"
import { BookmarkLeaf, BookmarksConfig, BookmarkTree, TargetProfile } from "../lib/schema/__.js"
import * as YamlModule from "../lib/yaml.js"

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)

const runCommand = async (
  cwd: string,
  command: readonly string[],
  env?: Record<string, string>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn([...command], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { exitCode, stdout, stderr }
}

const runGit = async (cwd: string, ...args: string[]) => {
  const result = await runCommand(cwd, ["git", ...args])
  expect(result.exitCode).toBe(0)
  return result
}

describe("bookmarks CLI", () => {
  test("status and sync --dry-run work against temp git repos and fixture browser files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-"))
    const yamlPath = join(dir, "bookmarks.yaml")
    const chromePath = join(dir, "Chrome-Bookmarks.json")

    try {
      await copyChromeBookmarksFixture(chromePath)

      const config = BookmarksConfig.make({
        targets: {
          chrome: {
            default: TargetProfile.make({ path: chromePath }),
          },
        },
        base: new BookmarkTree({
          favorites_bar: [
            new BookmarkLeaf({ name: "Docs", url: "https://docs.example" }),
          ],
        }),
      })

      await run(YamlModule.save(yamlPath, config))

      await runGit(dir, "init", "-b", "main")
      await runGit(dir, "config", "user.name", "Bookmarks Test")
      await runGit(dir, "config", "user.email", "bookmarks-test@example.com")
      await runGit(dir, "add", "bookmarks.yaml")
      await runGit(dir, "commit", "-m", "baseline")

      const cliEnv = { BOOKMARKS_YAML_PATH: yamlPath }
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts")

      const status = await runCommand(dir, [process.execPath, cliPath, "status"], cliEnv)
      expect(status.exitCode).toBe(0)
      expect(status.stdout).toContain("chrome/default")
      expect(status.stdout).toContain("pending -> browser:")
      expect(status.stdout).toContain("pending -> yaml:")

      const sync = await runCommand(dir, [process.execPath, cliPath, "sync", "--dry-run"], cliEnv)
      expect(sync.exitCode).toBe(0)
      expect(sync.stdout).toContain("Sync complete")
      expect(sync.stdout).toContain("chrome/default")

      const yamlAfter = await readFile(yamlPath, "utf-8")
      expect(yamlAfter).toContain("https://docs.example")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
