import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ManagedPaths from "./managed-paths.js"

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)

describe("managed paths", () => {
  test("ensureDir materializes a broken symlink ancestor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-managed-paths-"))
    const symlinkPath = join(dir, "managed")
    const targetPath = join(dir, "missing", "target")
    const backupsPath = join(symlinkPath, "backups")

    try {
      await symlink(targetPath, symlinkPath)

      await run(ManagedPaths.ensureDir(backupsPath))

      const targetStat = await lstat(targetPath)
      expect(targetStat.isDirectory()).toBe(true)

      const backupsStat = await lstat(backupsPath)
      expect(backupsStat.isDirectory()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("ensureParentDir materializes a broken symlink ancestor for file writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-managed-paths-"))
    const symlinkPath = join(dir, "managed")
    const targetPath = join(dir, "missing", "target")
    const filePath = join(symlinkPath, "workspace.yaml")

    try {
      await symlink(targetPath, symlinkPath)

      await run(ManagedPaths.ensureParentDir(filePath))
      await Bun.write(filePath, "version: 1\n")

      const targetStat = await lstat(targetPath)
      expect(targetStat.isDirectory()).toBe(true)
      expect(await Bun.file(filePath).text()).toBe("version: 1\n")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
