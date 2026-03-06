import { Database } from "bun:sqlite"
import { parse } from "@plist/binary.parse"
import { Effect } from "effect"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import * as Chrome from "./chrome.js"
import * as Patch from "./patch.js"
import * as Paths from "./paths.js"
import * as Safari from "./safari.js"
import { BookmarksConfig, BookmarkTree } from "./schema/__.js"

export interface TargetDescriptor {
  readonly browser: string
  readonly profile: string
  readonly path: string
  readonly enabled: boolean
  readonly bookmarkScope?: string
}

type ChromeLocalState = {
  profile?: {
    info_cache?: Record<string, unknown>
  }
}

type SafariProfileRow = {
  readonly title: string | null
  readonly external_uuid: string
  readonly extra_attributes: Uint8Array | ArrayBuffer | null
}

const DEFAULT_SAFARI_BOOKMARK_SCOPE = "Favorites Bar"

export const keyOf = (target: Pick<TargetDescriptor, "browser" | "profile">): string =>
  `${target.browser}/${target.profile}`

export const displayNameOf = (target: Pick<TargetDescriptor, "browser" | "profile">): string =>
  `${target.browser}/${target.profile}`

const exists = async (path: string): Promise<boolean> => {
  try {
    await Fs.access(path)
    return true
  } catch {
    return false
  }
}

const normalizeChromeProfileSelector = (directoryName: string): string =>
  directoryName
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")

const normalizeSafariProfileSelector = (
  title: string | null,
  externalUuid: string,
): string =>
  externalUuid === "DefaultProfile"
    ? "default"
    : normalizeChromeProfileSelector(title ?? externalUuid)

const toArrayBuffer = (value: Uint8Array | ArrayBuffer): ArrayBuffer =>
  value instanceof ArrayBuffer
    ? value
    : Uint8Array.from(value).buffer

const bookmarkScopeOf = (extraAttributes: Uint8Array | ArrayBuffer | null): string => {
  if (!extraAttributes) return DEFAULT_SAFARI_BOOKMARK_SCOPE

  try {
    const parsed = parse(toArrayBuffer(extraAttributes)) as Record<string, unknown>
    const scope = parsed["CustomFavoritesFolderServerID"]
    return typeof scope === "string" && scope.length > 0 ? scope : DEFAULT_SAFARI_BOOKMARK_SCOPE
  } catch {
    return DEFAULT_SAFARI_BOOKMARK_SCOPE
  }
}

const readChromeProfileDirectories = async (chromeDataDir: string): Promise<string[]> => {
  const localStatePath = Path.join(chromeDataDir, "Local State")
  if (await exists(localStatePath)) {
    const parsed = JSON.parse(await Fs.readFile(localStatePath, "utf-8")) as ChromeLocalState
    const infoCache = parsed.profile?.info_cache
    if (infoCache) {
      return Object.keys(infoCache)
        .filter((directoryName) => directoryName !== "System Profile")
    }
  }

  return (await Fs.readdir(chromeDataDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "System Profile")
    .map((entry) => entry.name)
}

export const discoverChromeTargets = (
  chromeDataDir = Paths.defaultChromeDataDir(),
): Effect.Effect<readonly TargetDescriptor[], Error> =>
  Effect.tryPromise({
    try: async () => {
      if (!(await exists(chromeDataDir))) return []

      const directories = await readChromeProfileDirectories(chromeDataDir)
      const targets: TargetDescriptor[] = []

      for (const directoryName of directories) {
        const bookmarksPath = Path.join(chromeDataDir, directoryName, "Bookmarks")
        if (!(await exists(bookmarksPath))) continue

        targets.push({
          browser: "chrome",
          profile: normalizeChromeProfileSelector(directoryName),
          path: bookmarksPath,
          enabled: true,
        })
      }

      return targets
    },
    catch: (e) => new Error(`Failed to discover Chrome targets in ${chromeDataDir}: ${e}`),
  })

export const discoverSafariTargets = (
  plistPath = Paths.defaultSafariPlistPath(),
  tabsDbPath = Paths.defaultSafariTabsDbPath(),
): Effect.Effect<readonly TargetDescriptor[], Error> =>
  Effect.tryPromise({
    try: async () => {
      if (!(await exists(plistPath))) return []
      if (!(await exists(tabsDbPath))) {
        return [{
          browser: "safari",
          profile: "default",
          path: plistPath,
          enabled: true,
          bookmarkScope: DEFAULT_SAFARI_BOOKMARK_SCOPE,
        } satisfies TargetDescriptor]
      }

      const db = new Database(tabsDbPath)
      try {
        const rows = db
          .query<SafariProfileRow, []>(
            "select title, external_uuid, extra_attributes from bookmarks where parent = 0 and type = 1 and subtype = 2 order by id",
          )
          .all()

        if (rows.length === 0) {
          return [{
            browser: "safari",
            profile: "default",
            path: plistPath,
            enabled: true,
            bookmarkScope: DEFAULT_SAFARI_BOOKMARK_SCOPE,
          } satisfies TargetDescriptor]
        }

        return rows.map((row) => ({
          browser: "safari",
          profile: normalizeSafariProfileSelector(row.title, row.external_uuid),
          path: plistPath,
          enabled: true,
          bookmarkScope: bookmarkScopeOf(row.extra_attributes),
        } satisfies TargetDescriptor))
      } finally {
        db.close()
      }
    },
    catch: (e) => new Error(`Failed to discover Safari targets at ${plistPath}: ${e}`),
  })

export const discoverTargets = (): Effect.Effect<readonly TargetDescriptor[], Error> =>
  Effect.all([discoverSafariTargets(), discoverChromeTargets()]).pipe(
    Effect.map(([safariTargets, chromeTargets]) => [...safariTargets, ...chromeTargets]),
  )

export const resolveTargetSelectors = (
  availableTargets: readonly TargetDescriptor[],
  selectors: readonly string[],
): Effect.Effect<readonly TargetDescriptor[], Error> =>
  Effect.gen(function* () {
    const byId = new Map(availableTargets.map((target) => [keyOf(target), target]))
    const resolved: TargetDescriptor[] = []
    const seen = new Set<string>()
    const resolveTarget = (target: TargetDescriptor) => {
      const id = keyOf(target)
      if (seen.has(id)) return
      seen.add(id)
      resolved.push(target)
    }

    if (selectors.length === 0) {
      for (const target of availableTargets) resolveTarget(target)
    }

    for (const selector of selectors) {
      if (selector.includes("/")) {
        const exact = byId.get(selector)
        if (!exact) {
          return yield* Effect.fail(new Error(
            `Unknown target selector "${selector}". Available targets: ${availableTargets.map(keyOf).join(", ") || "(none)"}.`,
          ))
        }

        resolveTarget(exact)
        continue
      }

      const matches = availableTargets.filter((target) => target.browser === selector)
      if (matches.length === 0) {
        return yield* Effect.fail(new Error(
          `Unknown browser selector "${selector}". Available targets: ${availableTargets.map(keyOf).join(", ") || "(none)"}.`,
        ))
      }

      for (const match of matches) {
        resolveTarget(match)
      }
    }

    const safariScopeGroups = new Map<string, TargetDescriptor[]>()
    for (const target of resolved) {
      if (target.browser !== "safari" || !target.bookmarkScope) continue
      const group = safariScopeGroups.get(target.bookmarkScope) ?? []
      group.push(target)
      safariScopeGroups.set(target.bookmarkScope, group)
    }

    for (const [bookmarkScope, group] of safariScopeGroups) {
      if (group.length < 2) continue
      return yield* Effect.fail(new Error(
        `Safari profiles share the same bookmarks scope "${bookmarkScope}": ${group.map(keyOf).join(", ")}. Safari bookmarks are shared across these profiles. Choose distinct Favorites folders in Safari Settings > Profiles before selecting them together.`,
      ))
    }

    return resolved
  })

export const processNameOf = (browser: string): string => {
  switch (browser) {
    case "safari":
      return "Safari"
    case "chrome":
      return "Google Chrome"
    default:
      return browser
  }
}

export const requiresFullDiskAccess = (target: Pick<TargetDescriptor, "browser" | "path">): boolean =>
  target.browser === "safari" && target.path === Paths.defaultSafariPlistPath()

export const graveyardSourceOf = (target: Pick<TargetDescriptor, "browser" | "profile">): string =>
  target.browser === "safari" && target.profile === "default"
    ? "safari"
    : `${target.browser}-${target.profile}`

export const listTargets = (config: BookmarksConfig): readonly TargetDescriptor[] =>
  Object.entries(config.targets).flatMap(([browser, profiles]) =>
    Object.entries(profiles).map(([profile, target]) => ({
      browser,
      profile,
      path: target.path,
      enabled: target.enabled ?? true,
      ...("bookmarkScope" in target && typeof target.bookmarkScope === "string"
        ? { bookmarkScope: target.bookmarkScope }
        : {}),
    })),
  )

export const listEnabledTargets = (config: BookmarksConfig): readonly TargetDescriptor[] =>
  listTargets(config).filter((target) => target.enabled)

export const listConfiguredProfileKeys = (config: BookmarksConfig): readonly string[] => {
  const keys = new Set<string>()

  for (const target of listTargets(config)) {
    keys.add(keyOf(target))
  }

  for (const profileKey of Object.keys(config.profiles ?? {})) {
    keys.add(profileKey)
  }

  return [...keys]
}

export const findTarget = (
  config: BookmarksConfig,
  profileKey: string,
): TargetDescriptor | undefined =>
  listTargets(config).find((target) => keyOf(target) === profileKey)

export const readTree = (target: TargetDescriptor): Effect.Effect<BookmarkTree, Error> => {
  switch (target.browser) {
    case "safari":
      return Safari.readBookmarks(target.path)
    case "chrome":
      return Chrome.readBookmarks(target.path)
    default:
      return Effect.fail(
        new Error(`Unsupported bookmarks target '${displayNameOf(target)}' at ${target.path}`),
      )
  }
}

export const applyPatches = (
  target: TargetDescriptor,
  patches: readonly Patch.BookmarkPatch[],
): Effect.Effect<void, Error> => {
  if (patches.length === 0) return Effect.void

  switch (target.browser) {
    case "safari":
      return Safari.applyPatches(target.path, patches)
    case "chrome":
      return Chrome.applyPatches(target.path, patches)
    default:
      return Effect.fail(
        new Error(`Unsupported bookmarks target '${displayNameOf(target)}' at ${target.path}`),
      )
  }
}

export const writeTree = (
  target: TargetDescriptor,
  tree: BookmarkTree,
): Effect.Effect<void, Error> => {
  switch (target.browser) {
    case "safari":
      return Safari.writeTree(target.path, tree)
    case "chrome":
      return Chrome.writeTree(target.path, tree)
    default:
      return Effect.fail(
        new Error(`Unsupported bookmarks target '${displayNameOf(target)}' at ${target.path}`),
      )
  }
}
