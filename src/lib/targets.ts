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
}

type ChromeLocalState = {
  profile?: {
    info_cache?: Record<string, unknown>
  }
}

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
): Effect.Effect<readonly TargetDescriptor[], Error> =>
  Effect.tryPromise({
    try: async () =>
      await exists(plistPath)
        ? [{ browser: "safari", profile: "default", path: plistPath, enabled: true } satisfies TargetDescriptor]
        : [],
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
    if (selectors.length === 0) return availableTargets

    const byId = new Map(availableTargets.map((target) => [keyOf(target), target]))
    const resolved: TargetDescriptor[] = []
    const seen = new Set<string>()

    for (const selector of selectors) {
      if (selector.includes("/")) {
        const exact = byId.get(selector)
        if (!exact) {
          return yield* Effect.fail(new Error(
            `Unknown target selector "${selector}". Available targets: ${availableTargets.map(keyOf).join(", ") || "(none)"}.`,
          ))
        }

        const id = keyOf(exact)
        if (!seen.has(id)) {
          seen.add(id)
          resolved.push(exact)
        }
        continue
      }

      const matches = availableTargets.filter((target) => target.browser === selector)
      if (matches.length === 0) {
        return yield* Effect.fail(new Error(
          `Unknown browser selector "${selector}". Available targets: ${availableTargets.map(keyOf).join(", ") || "(none)"}.`,
        ))
      }

      for (const match of matches) {
        const id = keyOf(match)
        if (seen.has(id)) continue
        seen.add(id)
        resolved.push(match)
      }
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
