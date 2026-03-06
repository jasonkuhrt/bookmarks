import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { serialize } from "@plist/binary.serialize"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyChromeBookmarksFixture } from "../lib/test-fixtures.js"
import { BookmarkLeaf, BookmarksConfig, BookmarkTree, ChromeBookmarks, ChromeProfileBookmarks } from "../lib/schema/__.js"
import * as Workspace from "../lib/workspace.js"
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

const writeChromeBookmarks = async (path: string, title = "Top Link", url = "https://top.example"): Promise<void> => {
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
            name: title,
            url,
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

const writeChromeDataDir = async (
  chromeDataDir: string,
  profiles: readonly { readonly directory: string; readonly title: string; readonly url: string }[],
): Promise<void> => {
  await mkdir(chromeDataDir, { recursive: true })
  await Bun.write(join(chromeDataDir, "Local State"), JSON.stringify({
    profile: {
      info_cache: Object.fromEntries(profiles.map((profile) => [profile.directory, {}])),
    },
  }))

  for (const profile of profiles) {
    const bookmarksPath = join(chromeDataDir, profile.directory, "Bookmarks")
    await mkdir(join(chromeDataDir, profile.directory), { recursive: true })
    await writeChromeBookmarks(bookmarksPath, profile.title, profile.url)
  }
}

describe("bookmarks CLI", () => {
  test("status and sync --dry-run work against temp git repos and fixture browser files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-"))
    const yamlPath = join(dir, "bookmarks.yaml")
    const schemaPath = join(dir, "bookmarks.schema.json")
    const chromeDataDir = join(dir, "Chrome")
    const chromePath = join(chromeDataDir, "Default", "Bookmarks")
    const safariPath = join(dir, "Safari", "Bookmarks.plist")
    const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db")

    try {
      await mkdir(join(chromeDataDir, "Default"), { recursive: true })
      await copyChromeBookmarksFixture(chromePath)
      await Bun.write(join(chromeDataDir, "Local State"), JSON.stringify({
        profile: {
          info_cache: {
            Default: {},
          },
        },
      }))

      const config = BookmarksConfig.make({
        all: new BookmarkTree({
          bar: [
            new BookmarkLeaf({ name: "Docs", url: "https://docs.example" }),
          ],
        }),
        chrome: ChromeBookmarks.make({
          profiles: {
            default: ChromeProfileBookmarks.make({}),
          },
        }),
      })

      await run(YamlModule.save(yamlPath, config))

      await runGit(dir, "init", "-b", "main")
      await runGit(dir, "config", "user.name", "Bookmarks Test")
      await runGit(dir, "config", "user.email", "bookmarks-test@example.com")
      await runGit(dir, "add", "bookmarks.yaml")
      await runGit(dir, "commit", "-m", "baseline")

      const cliEnv = {
        BOOKMARKS_YAML_PATH: yamlPath,
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
        BOOKMARKS_SAFARI_TABS_DB_PATH: safariTabsDbPath,
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
      }
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts")

      const status = await runCommand(dir, [process.execPath, cliPath, "status"], cliEnv)
      expect(status.exitCode).toBe(0)
      expect(status.stdout).toContain("chrome/default")
      expect(status.stdout).toContain("pending -> browser:")
      expect(status.stdout).toContain("pending -> yaml:")
      expect(status.stdout).toContain('Add "Top Link"')

      const statusJson = await runCommand(dir, [process.execPath, cliPath, "status", "--json"], cliEnv)
      expect(statusJson.exitCode).toBe(0)
      const parsedStatus = JSON.parse(statusJson.stdout) as {
        readonly yamlPath: string
        readonly targets: Array<{
          readonly target: { readonly browser: string; readonly profile: string }
          readonly pendingToYaml: readonly unknown[]
        }>
      }
      expect(parsedStatus.yamlPath).toBe(yamlPath)
      expect(parsedStatus.targets[0]?.target.browser).toBe("chrome")
      expect(parsedStatus.targets[0]?.pendingToYaml.length).toBeGreaterThan(0)

      const sync = await runCommand(dir, [process.execPath, cliPath, "sync", "--dry-run"], cliEnv)
      expect(sync.exitCode).toBe(0)
      expect(sync.stdout).toContain("Sync complete")
      expect(sync.stdout).toContain("chrome/default")
      expect(sync.stdout).toContain('Add "Top Link"')

      const syncJson = await runCommand(dir, [process.execPath, cliPath, "sync", "--dry-run", "--json"], cliEnv)
      expect(syncJson.exitCode).toBe(0)
      const parsedSync = JSON.parse(syncJson.stdout) as {
        readonly command: string
        readonly dryRun: boolean
        readonly preview: {
          readonly targets: Array<{
            readonly pendingToYaml: readonly unknown[]
          }>
        } | null
      }
      expect(parsedSync.command).toBe("sync")
      expect(parsedSync.dryRun).toBe(true)
      expect(parsedSync.preview?.targets[0]?.pendingToYaml.length).toBeGreaterThan(0)

      const schema = await readFile(schemaPath, "utf-8")
      expect(schema).toContain('"$schema"')

      const yamlAfter = await readFile(yamlPath, "utf-8")
      expect(yamlAfter).toContain("https://docs.example")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("sync --json reports automatic backups for managed mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-sync-"))
    const yamlPath = join(dir, "bookmarks.yaml")
    const chromeDataDir = join(dir, "Chrome")
    const chromePath = join(chromeDataDir, "Default", "Bookmarks")
    const backupDir = join(dir, "backups")
    const runtimeDir = join(dir, "runtime")
    const safariPath = join(dir, "Safari", "Bookmarks.plist")
    const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db")

    try {
      await mkdir(join(chromeDataDir, "Default"), { recursive: true })
      await copyChromeBookmarksFixture(chromePath)
      await Bun.write(join(chromeDataDir, "Local State"), JSON.stringify({
        profile: {
          info_cache: {
            Default: {},
          },
        },
      }))

      const config = BookmarksConfig.make({
        all: new BookmarkTree({}),
        chrome: ChromeBookmarks.make({
          profiles: {
            default: ChromeProfileBookmarks.make({}),
          },
        }),
      })

      await run(YamlModule.save(yamlPath, config))

      await runGit(dir, "init", "-b", "main")
      await runGit(dir, "config", "user.name", "Bookmarks Test")
      await runGit(dir, "config", "user.email", "bookmarks-test@example.com")
      await runGit(dir, "add", "bookmarks.yaml")
      await runGit(dir, "commit", "-m", "baseline")

      const cliEnv = {
        BOOKMARKS_YAML_PATH: yamlPath,
        BOOKMARKS_BACKUP_DIR: backupDir,
        BOOKMARKS_RUNTIME_DIR: runtimeDir,
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
        BOOKMARKS_SAFARI_TABS_DB_PATH: safariTabsDbPath,
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
      }
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts")

      const syncJson = await runCommand(dir, [process.execPath, cliPath, "sync", "--json"], cliEnv)
      expect(syncJson.exitCode).toBe(0)

      const parsedSync = JSON.parse(syncJson.stdout) as {
        readonly orchestration?: {
          readonly state: string
          readonly blockers?: readonly string[]
        } | null
        readonly backup: {
          readonly backupDir: string
          readonly files: readonly string[]
          readonly skipped: readonly string[]
        } | null
      }

      const queued = parsedSync.orchestration?.state === "queued"

      if (queued) {
        expect(parsedSync.orchestration.blockers).toContain("Google Chrome")
        expect(parsedSync.backup).toBeNull()
      } else {
        expect(parsedSync.backup?.backupDir).toBe(backupDir)
        expect(parsedSync.backup?.files).toHaveLength(2)
        expect(parsedSync.backup?.skipped).toHaveLength(0)
      }

      const yamlAfter = await readFile(yamlPath, "utf-8")
      if (queued) {
        expect(yamlAfter).not.toContain("Top Link")
      } else {
        expect(yamlAfter).toContain("Top Link")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("import, next, plan, publish, and validate drive the workspace workflow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-workspace-"))
    const yamlPath = join(dir, "bookmarks.yaml")
    const workspacePath = join(dir, "workspace.yaml")
    const importLockPath = join(dir, "import.lock.json")
    const publishPlanPath = join(dir, "publish.plan.json")
    const chromeDataDir = join(dir, "Chrome")
    const backupDir = join(dir, "backups")
    const runtimeDir = join(dir, "runtime")
    const safariPath = join(dir, "Safari", "Bookmarks.plist")
    const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db")

    try {
      await writeChromeDataDir(chromeDataDir, [
        { directory: "Default", title: "Top Link", url: "https://top.example" },
      ])

      const config = BookmarksConfig.make({
        all: new BookmarkTree({}),
        chrome: ChromeBookmarks.make({
          profiles: {
            default: ChromeProfileBookmarks.make({}),
          },
        }),
      })

      await run(YamlModule.save(yamlPath, config))

      const cliEnv = {
        BOOKMARKS_YAML_PATH: yamlPath,
        BOOKMARKS_WORKSPACE_PATH: workspacePath,
        BOOKMARKS_IMPORT_LOCK_PATH: importLockPath,
        BOOKMARKS_PUBLISH_PLAN_PATH: publishPlanPath,
        BOOKMARKS_BACKUP_DIR: backupDir,
        BOOKMARKS_RUNTIME_DIR: runtimeDir,
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
        BOOKMARKS_SAFARI_TABS_DB_PATH: safariTabsDbPath,
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
      }
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts")

      const imported = await runCommand(dir, [process.execPath, cliPath, "import", "chrome/default", "--json"], cliEnv)
      expect(imported.exitCode).toBe(0)
      const parsedImport = JSON.parse(imported.stdout) as {
        readonly targets: readonly string[]
      }
      expect(parsedImport.targets).toEqual(["chrome/default"])

      const nextNeedsReview = await runCommand(dir, [process.execPath, cliPath, "next", "--json"], cliEnv)
      expect(nextNeedsReview.exitCode).toBe(0)
      const parsedNextNeedsReview = JSON.parse(nextNeedsReview.stdout) as {
        readonly state: string
      }
      expect(parsedNextNeedsReview.state).toBe("needs_review")

      const workspace = await run(Workspace.load(workspacePath))
      const importedNode = workspace.inbox["chrome/default"]?.bar?.[0]
      expect(importedNode?.kind).toBe("bookmark")
      if (!importedNode || importedNode.kind !== "bookmark") {
        throw new Error("Expected imported bookmark in bar")
      }
      workspace.inbox = {}
      workspace.publish.profiles["chrome/default"] = {
        bar: [{ ...importedNode, title: "CLI Curated Link" }],
      }
      await run(Workspace.save(workspacePath, workspace))

      const validated = await runCommand(dir, [process.execPath, cliPath, "validate", "--json"], cliEnv)
      expect(validated.exitCode).toBe(0)
      const parsedValidation = JSON.parse(validated.stdout) as { readonly valid: boolean }
      expect(parsedValidation.valid).toBe(true)

      const planned = await runCommand(dir, [process.execPath, cliPath, "plan", "--json"], cliEnv)
      const parsedPlan = JSON.parse(planned.stdout) as {
        readonly summary: { readonly blockerCount: number }
        readonly blockers?: ReadonlyArray<{ readonly code: string; readonly targetId?: string }>
      }

      if (planned.exitCode === 0) {
        expect(parsedPlan.summary.blockerCount).toBe(0)

        const published = await runCommand(dir, [process.execPath, cliPath, "publish", "--json"], cliEnv)
        expect(published.exitCode).toBe(0)
        const parsedPublish = JSON.parse(published.stdout) as {
          readonly publishedTargets: readonly string[]
        }
        expect(parsedPublish.publishedTargets).toEqual(["chrome/default"])

        const nextDone = await runCommand(dir, [process.execPath, cliPath, "next", "--json"], cliEnv)
        expect(nextDone.exitCode).toBe(0)
        const parsedNextDone = JSON.parse(nextDone.stdout) as {
          readonly state: string
        }
        expect(parsedNextDone.state).toBe("done")
      } else {
        expect(parsedPlan.summary.blockerCount).toBeGreaterThan(0)
        expect(parsedPlan.blockers?.some((blocker) => blocker.code === "browser-running")).toBe(true)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("import defaults to all discovered profiles and exact profile typos fail clearly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-targets-"))
    const yamlPath = join(dir, "bookmarks.yaml")
    const workspacePath = join(dir, "workspace.yaml")
    const importLockPath = join(dir, "import.lock.json")
    const publishPlanPath = join(dir, "publish.plan.json")
    const chromeDataDir = join(dir, "Chrome")
    const safariPath = join(dir, "Safari", "Bookmarks.plist")
    const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db")

    try {
      await writeChromeDataDir(chromeDataDir, [
        { directory: "Default", title: "Top Link", url: "https://top.example" },
        { directory: "Profile 1", title: "Work Link", url: "https://work.example" },
      ])

      const config = BookmarksConfig.make({
        all: new BookmarkTree({}),
        chrome: ChromeBookmarks.make({
          profiles: {
            default: ChromeProfileBookmarks.make({}),
          },
        }),
      })

      await run(YamlModule.save(yamlPath, config))

      const cliEnv = {
        BOOKMARKS_YAML_PATH: yamlPath,
        BOOKMARKS_WORKSPACE_PATH: workspacePath,
        BOOKMARKS_IMPORT_LOCK_PATH: importLockPath,
        BOOKMARKS_PUBLISH_PLAN_PATH: publishPlanPath,
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
        BOOKMARKS_SAFARI_TABS_DB_PATH: safariTabsDbPath,
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
      }
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts")

      const imported = await runCommand(dir, [process.execPath, cliPath, "import", "--json"], cliEnv)
      expect(imported.exitCode).toBe(0)
      const parsedImport = JSON.parse(imported.stdout) as {
        readonly targets: readonly string[]
      }
      expect(parsedImport.targets).toEqual(["chrome/default", "chrome/profile-1"])

      const typo = await runCommand(dir, [process.execPath, cliPath, "import", "chrome/defualt", "--json"], cliEnv)
      expect(typo.exitCode).toBe(1)
      const parsedTypo = JSON.parse(typo.stderr) as { readonly error: string }
      expect(parsedTypo.error).toContain('Unknown target selector "chrome/defualt"')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("import succeeds when Safari profiles share one favorites scope because Safari bookmarks are shared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-cli-safari-targets-"))
    const workspacePath = join(dir, "workspace.yaml")
    const importLockPath = join(dir, "import.lock.json")
    const publishPlanPath = join(dir, "publish.plan.json")
    const safariPath = join(dir, "Safari", "Bookmarks.plist")
    const safariTabsDbPath = join(dir, "Safari", "SafariTabs.db")

    try {
      await mkdir(join(dir, "Safari"), { recursive: true })
      await Bun.write(safariPath, serialize({ Children: [] }))

      const db = new Database(safariTabsDbPath)
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
            })),
          ],
        )
      } finally {
        db.close()
      }

      const cliEnv = {
        BOOKMARKS_WORKSPACE_PATH: workspacePath,
        BOOKMARKS_IMPORT_LOCK_PATH: importLockPath,
        BOOKMARKS_PUBLISH_PLAN_PATH: publishPlanPath,
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
        BOOKMARKS_SAFARI_TABS_DB_PATH: safariTabsDbPath,
        BOOKMARKS_CHROME_DATA_DIR: join(dir, "Chrome"),
      }
      const cliPath = join(process.cwd(), "src", "bin", "bookmarks.ts")

      const imported = await runCommand(dir, [process.execPath, cliPath, "import", "--json"], cliEnv)
      expect(imported.exitCode).toBe(0)
      const parsedImport = JSON.parse(imported.stdout) as { readonly targets: readonly string[] }
      expect(parsedImport.targets).toEqual(["safari"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
