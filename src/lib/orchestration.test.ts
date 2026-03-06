import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Paths from "./paths.js"
import * as Orchestration from "./orchestration.js"

const ORIGINAL_RUNTIME_DIR = process.env["BOOKMARKS_RUNTIME_DIR"]

const run = <A>(effect: Effect.Effect<A, Error>) =>
  Effect.runPromise(effect)

afterEach(async () => {
  const runtimeDir = process.env["BOOKMARKS_RUNTIME_DIR"]

  if (ORIGINAL_RUNTIME_DIR === undefined) {
    delete process.env["BOOKMARKS_RUNTIME_DIR"]
  } else {
    process.env["BOOKMARKS_RUNTIME_DIR"] = ORIGINAL_RUNTIME_DIR
  }

  if (runtimeDir) {
    await rm(runtimeDir, { recursive: true, force: true })
  }
})

describe("withOrchestratedSync", () => {
  test("replays queued work on the next successful run", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "bookmarks-runtime-"))
    process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir

    await writeFile(Paths.defaultSyncQueuePath(), JSON.stringify({
      operation: "push",
      yamlPath: "/tmp/bookmarks.yaml",
      blockers: ["Safari"],
      queuedAt: "2026-01-01T00:00:00.000Z",
    }))

    let executedOperation: Orchestration.SyncOperation | undefined

    const result = await run(Orchestration.withOrchestratedSync(
      "/tmp/bookmarks.yaml",
      "pull",
      (operation) => {
        executedOperation = operation
        return Effect.succeed("done")
      },
    ))

    expect(result).toEqual({ _tag: "completed", value: "done" })
    expect(executedOperation).toBe("sync")
    await expect(access(Paths.defaultSyncQueuePath())).rejects.toThrow()
  })

  test("queues work when a temporary browser blocker is encountered", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "bookmarks-runtime-"))
    process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir

    const result = await run(Orchestration.withOrchestratedSync(
      "/tmp/bookmarks.yaml",
      "sync",
      () => Effect.fail(new Orchestration.TemporarySyncBlocker({ blockers: ["Safari"] })),
    ))

    expect(result._tag).toBe("deferred")
    if (result._tag === "deferred") {
      expect(result.notice.state).toBe("queued")
      expect(result.notice.operation).toBe("sync")
      expect(result.notice.message).toContain("queued")
      expect(result.notice.blockers).toEqual(["Safari"])
    }

    const queued = JSON.parse(await readFile(Paths.defaultSyncQueuePath(), "utf-8")) as {
      readonly operation: string
      readonly blockers: readonly string[]
    }
    expect(queued.operation).toBe("sync")
    expect(queued.blockers).toEqual(["Safari"])
  })

  test("returns a busy notice when another sync holds the lock", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "bookmarks-runtime-"))
    process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir

    await writeFile(Paths.defaultSyncLockPath(), JSON.stringify({
      pid: process.pid,
      operation: "sync",
      yamlPath: "/tmp/bookmarks.yaml",
      acquiredAt: "2026-01-01T00:00:00.000Z",
    }))

    let invoked = false

    const result = await run(Orchestration.withOrchestratedSync(
      "/tmp/bookmarks.yaml",
      "sync",
      () => {
        invoked = true
        return Effect.succeed("done")
      },
    ))

    expect(invoked).toBe(false)
    expect(result._tag).toBe("deferred")
    if (result._tag === "deferred") {
      expect(result.notice.state).toBe("busy")
      expect(result.notice.message).toContain("already running")
    }
  })

  test("removes stale locks before executing", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "bookmarks-runtime-"))
    process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir

    await writeFile(Paths.defaultSyncLockPath(), JSON.stringify({
      pid: 999_999,
      operation: "sync",
      yamlPath: "/tmp/bookmarks.yaml",
      acquiredAt: "2026-01-01T00:00:00.000Z",
    }))

    const result = await run(Orchestration.withOrchestratedSync(
      "/tmp/bookmarks.yaml",
      "pull",
      () => Effect.succeed("done"),
    ))

    expect(result).toEqual({ _tag: "completed", value: "done" })
    await expect(access(Paths.defaultSyncLockPath())).rejects.toThrow()
  })
})
