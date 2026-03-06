import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Chrome from "./chrome.js"
import { BookmarkLeaf, BookmarksConfig, BookmarkTree, TargetProfile } from "./schema/__.js"
import * as Workspace from "./workspace.js"
import * as YamlModule from "./yaml.js"

const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "BOOKMARKS_CONFIG_DIR",
  "BOOKMARKS_STATE_DIR",
  "BOOKMARKS_YAML_PATH",
  "BOOKMARKS_WORKSPACE_PATH",
  "BOOKMARKS_IMPORT_LOCK_PATH",
  "BOOKMARKS_PUBLISH_PLAN_PATH",
  "BOOKMARKS_BACKUP_DIR",
  "BOOKMARKS_RUNTIME_DIR",
] as const

const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)

const writeChromeBookmarks = async (path: string): Promise<void> => {
  await Bun.write(path, JSON.stringify({
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
            name: "Top Link",
            url: "https://top.example",
            id: "2",
            guid: "top-link",
            date_added: "0",
            date_last_used: "0",
          },
        ],
      },
      other: {
        type: "folder",
        name: "Other Bookmarks",
        id: "3",
        guid: "root-other",
        date_added: "0",
        date_modified: "0",
        children: [],
      },
      synced: {
        type: "folder",
        name: "Mobile Bookmarks",
        id: "4",
        guid: "root-synced",
        date_added: "0",
        date_modified: "0",
        children: [],
      },
    },
  }, null, 2))
}

const setupWorkspaceEnv = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bookmarks-workspace-"))
  const yamlPath = join(dir, "bookmarks.yaml")
  const workspacePath = join(dir, "workspace.yaml")
  const importLockPath = join(dir, "import.lock.json")
  const publishPlanPath = join(dir, "publish.plan.json")
  const backupDir = join(dir, "backups")
  const runtimeDir = join(dir, "runtime")
  const chromePath = join(dir, "Chrome-Bookmarks.json")

  process.env["BOOKMARKS_YAML_PATH"] = yamlPath
  process.env["BOOKMARKS_WORKSPACE_PATH"] = workspacePath
  process.env["BOOKMARKS_IMPORT_LOCK_PATH"] = importLockPath
  process.env["BOOKMARKS_PUBLISH_PLAN_PATH"] = publishPlanPath
  process.env["BOOKMARKS_BACKUP_DIR"] = backupDir
  process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir

  await writeChromeBookmarks(chromePath)

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

  return {
    dir,
    yamlPath,
    workspacePath,
    importLockPath,
    publishPlanPath,
    backupDir,
    runtimeDir,
    chromePath,
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe("workspace workflow", () => {
  test("next routes to import when no workspace exists", async () => {
    const env = await setupWorkspaceEnv()

    try {
      const result = await run(Workspace.next())
      expect(result.state).toBe("needs_import")
      expect(result.nextAction.kind).toBe("run_command")
      if (result.nextAction.kind === "run_command") {
        expect(result.nextAction.command).toBe("bookmarks import")
      }
    } finally {
      await rm(env.dir, { recursive: true, force: true })
    }
  })

  test("import creates a review workspace with immutable source occurrences", async () => {
    const env = await setupWorkspaceEnv()

    try {
      const imported = await run(Workspace.importState(["chrome/default"]))
      expect(imported.workspacePath).toBe(env.workspacePath)
      expect(imported.importLockPath).toBe(env.importLockPath)
      expect(imported.targets).toEqual(["chrome/default"])
      expect(imported.backup).toBeNull()

      const workspace = await run(Workspace.load(env.workspacePath))
      expect(workspace.inbox["chrome/default"]?.favorites_bar?.[0]?.kind).toBe("bookmark")
      expect(workspace.canonical.favorites_bar).toBeUndefined()

      const validation = await run(Workspace.validate())
      expect(validation.valid).toBe(true)
      expect(validation.errors).toEqual([])

      const next = await run(Workspace.next())
      expect(next.state).toBe("needs_review")
      expect(next.summary.inboxItems).toBeGreaterThan(0)
      expect(next.nextAction.kind).toBe("edit_file")
    } finally {
      await rm(env.dir, { recursive: true, force: true })
    }
  })

  test("plan and publish rewrite a curated workspace and then report done", async () => {
    const env = await setupWorkspaceEnv()

    try {
      await run(Workspace.importState(["chrome/default"]))

      const workspace = await run(Workspace.load(env.workspacePath))
      const importedNode = workspace.inbox["chrome/default"]?.favorites_bar?.[0]
      expect(importedNode?.kind).toBe("bookmark")
      if (!importedNode || importedNode.kind !== "bookmark") {
        throw new Error("Expected imported bookmark in favorites_bar")
      }

      workspace.inbox = {}
      workspace.canonical = {
        favorites_bar: [
          {
            ...importedNode,
            title: "Curated Link",
          },
        ],
      }

      await run(Workspace.save(env.workspacePath, workspace))

      const plan = await run(Workspace.plan())
      expect(plan.blockers).toEqual([])
      expect(plan.targets).toHaveLength(1)
      expect(plan.targets[0]?.status).toBe("ready")

      const published = await run(Workspace.publish())
      expect(published.publishedTargets).toEqual(["chrome/default"])
      expect(published.plan.publishedAt).not.toBeNull()
      expect(published.backup.files).toHaveLength(4)

      const tree = await run(Chrome.readBookmarks(env.chromePath))
      const first = tree.favorites_bar?.[0]
      expect(first?.name).toBe("Curated Link")

      const next = await run(Workspace.next())
      expect(next.state).toBe("done")
      expect(next.nextAction.kind).toBe("done")
    } finally {
      await rm(env.dir, { recursive: true, force: true })
    }
  })
})
