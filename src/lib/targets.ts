import { Database } from "bun:sqlite";
import { parse } from "@plist/binary.parse";
import { Effect } from "effect";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Canonical from "./canonical.ts";
import * as Chrome from "./chrome.ts";
import * as ChromeNative from "./chrome-native.ts";
import type * as Patch from "./patch.ts";
import * as Paths from "./paths.ts";
import * as Safari from "./safari.ts";
import { TargetState, type BookmarkTree } from "./schema/__.ts";
import type { BookmarksConfig } from "./schema/__.ts";

export interface TargetDescriptor {
  readonly browser: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly profile?: string | undefined;
}

export interface SafariProfileMetadata {
  readonly profile: string;
  readonly bookmarkScope: string;
}

type ChromeLocalState = {
  profile?: {
    info_cache?: Record<string, unknown>;
  };
};

type SafariProfileRow = {
  readonly title: string | null;
  readonly external_uuid: string;
  readonly extra_attributes: Uint8Array | ArrayBuffer | null;
};

const DEFAULT_SAFARI_BOOKMARK_SCOPE = "Favorites Bar";

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isChromeLocalState = (value: unknown): value is ChromeLocalState =>
  !isRecord(value) ||
  value["profile"] === undefined ||
  (isRecord(value["profile"]) &&
    (value["profile"]["info_cache"] === undefined || isRecord(value["profile"]["info_cache"])));

export const keyOf = (target: Pick<TargetDescriptor, "browser" | "profile">): string =>
  target.profile ? `${target.browser}/${target.profile}` : target.browser;

export const displayNameOf = (target: Pick<TargetDescriptor, "browser" | "profile">): string =>
  keyOf(target);

const exists = async (path: string): Promise<boolean> => {
  try {
    await Fs.access(path);
    return true;
  } catch {
    return false;
  }
};

const normalizeChromeProfileSelector = (directoryName: string): string =>
  directoryName
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

const normalizeSafariProfileSelector = (title: string | null, externalUuid: string): string =>
  externalUuid === "DefaultProfile"
    ? "default"
    : normalizeChromeProfileSelector(title ?? externalUuid);

const toArrayBuffer = (value: Uint8Array | ArrayBuffer): ArrayBuffer =>
  value instanceof ArrayBuffer ? value : Uint8Array.from(value).buffer;

const bookmarkScopeOf = (extraAttributes: Uint8Array | ArrayBuffer | null): string => {
  if (!extraAttributes) return DEFAULT_SAFARI_BOOKMARK_SCOPE;

  try {
    const parsed = parse(toArrayBuffer(extraAttributes));
    if (!isRecord(parsed)) return DEFAULT_SAFARI_BOOKMARK_SCOPE;
    const scope = parsed["CustomFavoritesFolderServerID"];
    return typeof scope === "string" && scope.length > 0 ? scope : DEFAULT_SAFARI_BOOKMARK_SCOPE;
  } catch {
    return DEFAULT_SAFARI_BOOKMARK_SCOPE;
  }
};

const readChromeProfileDirectories = async (chromeDataDir: string): Promise<string[]> => {
  const localStatePath = Path.join(chromeDataDir, "Local State");
  if (await exists(localStatePath)) {
    const parsed: unknown = JSON.parse(await Fs.readFile(localStatePath, "utf-8"));
    const infoCache = isChromeLocalState(parsed) ? parsed.profile?.info_cache : undefined;
    if (infoCache) {
      return Object.keys(infoCache).filter((directoryName) => directoryName !== "System Profile");
    }
  }

  return (await Fs.readdir(chromeDataDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "System Profile")
    .map((entry) => entry.name);
};

export const discoverChromeTargets = (
  chromeDataDir = Paths.defaultChromeDataDir(),
): Effect.Effect<readonly TargetDescriptor[], Error> =>
  Effect.tryPromise({
    try: async () => {
      if (!(await exists(chromeDataDir))) return [];

      const directories = (await readChromeProfileDirectories(chromeDataDir)).sort();
      const targets = await Promise.all(
        directories.map(async (directoryName) => {
          const bookmarksPath = Path.join(chromeDataDir, directoryName, "Bookmarks");
          if (!(await exists(bookmarksPath))) return undefined;

          return {
            browser: "chrome",
            profile: normalizeChromeProfileSelector(directoryName),
            path: bookmarksPath,
            enabled: true,
          } satisfies TargetDescriptor;
        }),
      );

      return targets.filter((target) => target !== undefined);
    },
    catch: (error) =>
      new Error(
        `Failed to discover Chrome targets in ${chromeDataDir}: ${messageFromUnknown(error)}`,
      ),
  });

export const discoverSafariProfiles = (
  tabsDbPath = Paths.defaultSafariTabsDbPath(),
): Effect.Effect<readonly SafariProfileMetadata[], Error> =>
  Effect.tryPromise({
    try: async () => {
      if (!(await exists(tabsDbPath))) return [];

      const db = new Database(tabsDbPath);
      try {
        const rows = db
          .query<SafariProfileRow, []>(
            "select title, external_uuid, extra_attributes from bookmarks where parent = 0 and type = 1 and subtype = 2 order by id",
          )
          .all();

        if (rows.length === 0) return [];

        return rows.map(
          (row) =>
            ({
              profile: normalizeSafariProfileSelector(row.title, row.external_uuid),
              bookmarkScope: bookmarkScopeOf(row.extra_attributes),
            }) satisfies SafariProfileMetadata,
        );
      } finally {
        db.close();
      }
    },
    catch: (error) =>
      new Error(
        `Failed to discover Safari profiles at ${tabsDbPath}: ${messageFromUnknown(error)}`,
      ),
  });

export const discoverSafariTargets = (
  plistPath = Paths.defaultSafariPlistPath(),
): Effect.Effect<readonly TargetDescriptor[], Error> =>
  Effect.tryPromise({
    try: async () => {
      if (!(await exists(plistPath))) return [];
      return [
        {
          browser: "safari",
          path: plistPath,
          enabled: true,
        } satisfies TargetDescriptor,
      ];
    },
    catch: (error) =>
      new Error(`Failed to discover Safari targets at ${plistPath}: ${messageFromUnknown(error)}`),
  });

export const discoverTargets = (): Effect.Effect<readonly TargetDescriptor[], Error> =>
  Effect.all([discoverSafariTargets(), discoverChromeTargets()]).pipe(
    Effect.map(([safariTargets, chromeTargets]) => [...safariTargets, ...chromeTargets]),
  );

export const resolveTargetSelectors = (
  availableTargets: readonly TargetDescriptor[],
  selectors: readonly string[],
): Effect.Effect<readonly TargetDescriptor[], Error> =>
  Effect.gen(function* () {
    const byId = new Map(availableTargets.map((target) => [keyOf(target), target]));
    const resolved: TargetDescriptor[] = [];
    const seen = new Set<string>();
    const resolveTarget = (target: TargetDescriptor) => {
      const id = keyOf(target);
      if (seen.has(id)) return;
      seen.add(id);
      resolved.push(target);
    };

    if (selectors.length === 0) {
      for (const target of availableTargets) resolveTarget(target);
    }

    for (const selector of selectors) {
      if (selector.includes("/")) {
        if (selector.startsWith("safari/")) {
          return yield* Effect.fail(
            new Error(`Safari bookmarks are shared; use "safari" instead of "${selector}".`),
          );
        }

        const exact = byId.get(selector);
        if (!exact) {
          return yield* Effect.fail(
            new Error(
              `Unknown target selector "${selector}". Available targets: ${availableTargets.map(keyOf).join(", ") || "(none)"}.`,
            ),
          );
        }

        resolveTarget(exact);
        continue;
      }

      const matches = availableTargets.filter((target) => target.browser === selector);
      if (matches.length === 0) {
        return yield* Effect.fail(
          new Error(
            `Unknown browser selector "${selector}". Available targets: ${availableTargets.map(keyOf).join(", ") || "(none)"}.`,
          ),
        );
      }

      for (const match of matches) {
        resolveTarget(match);
      }
    }

    return resolved;
  });

export const processNameOf = (browser: string): string => {
  switch (browser) {
    case "safari":
      return "Safari";
    case "chrome":
      return "Google Chrome";
    default:
      return browser;
  }
};

export const requiresFullDiskAccess = (
  target: Pick<TargetDescriptor, "browser" | "path">,
): boolean => target.browser === "safari" && target.path === Paths.defaultSafariPlistPath();

export const graveyardSourceOf = (target: Pick<TargetDescriptor, "browser" | "profile">): string =>
  target.browser === "safari" ? "safari" : `${target.browser}-${target.profile ?? "default"}`;

export const listConfiguredChromeProfileKeys = (config: BookmarksConfig): readonly string[] =>
  Object.keys(config.chrome?.profiles ?? {}).map((profile) => `chrome/${profile}`);

/** Only Safari and paired Chrome participate in the shared Reading List. */
export const hasReadingList = (target: TargetDescriptor): Effect.Effect<boolean, Error> =>
  target.browser === "safari"
    ? Effect.succeed(true)
    : target.browser === "chrome"
      ? ChromeNative.isPaired(target.path)
      : Effect.succeed(false);

export const readState = (target: TargetDescriptor): Effect.Effect<TargetState, Error> => {
  if (target.browser === "safari") return Safari.readState(target.path);
  if (target.browser === "chrome")
    return ChromeNative.isPaired(target.path).pipe(
      Effect.flatMap((paired) =>
        paired
          ? ChromeNative.readState(target.path)
          : readFileTree(target).pipe(
              Effect.map((tree) => TargetState.make({ tree, readingList: [] })),
            ),
      ),
    );
  return Effect.fail(new Error(`Unsupported bookmarks target ${displayNameOf(target)}`));
};

export const writeState = (
  target: TargetDescriptor,
  desired: TargetState,
  expected: TargetState,
): Effect.Effect<void, Error> => {
  if (target.browser === "safari") return Safari.writeState(target.path, desired);
  if (target.browser === "chrome")
    return ChromeNative.isPaired(target.path).pipe(
      Effect.flatMap((paired) =>
        paired
          ? ChromeNative.writeState(target.path, expected, desired)
          : Chrome.writeTree(target.path, desired.tree),
      ),
    );
  return Effect.fail(new Error(`Unsupported bookmarks target ${displayNameOf(target)}`));
};

const readChromeNative = (target: TargetDescriptor): Effect.Effect<BookmarkTree, Error> =>
  ChromeNative.isPaired(target.path).pipe(
    Effect.flatMap((paired) =>
      paired ? ChromeNative.readTree(target.path) : Chrome.readBookmarks(target.path),
    ),
  );

/** A target's bookmarks in the engine's layout and canonical form. */
export const readTree = (target: TargetDescriptor): Effect.Effect<BookmarkTree, Error> => {
  switch (target.browser) {
    case "safari":
      return readFileTree(target);
    case "chrome":
      return readChromeNative(target).pipe(Effect.map((native) => Canonical.canonicalTree(native)));
    default:
      return Effect.fail(
        new Error(`Unsupported bookmarks target '${displayNameOf(target)}' at ${target.path}`),
      );
  }
};

/**
 * What a target's bookmark file holds, in the engine's layout and canonical form, read from
 * the file itself even for paired Chrome, whose file trails its live bookmarks.
 */
export const readFileTree = (
  target: Pick<TargetDescriptor, "browser" | "profile" | "path">,
): Effect.Effect<BookmarkTree, Error> => {
  switch (target.browser) {
    case "safari":
      return Safari.readBookmarks(target.path).pipe(Effect.map(Canonical.canonicalTree));
    case "chrome":
      return Chrome.readBookmarks(target.path).pipe(
        Effect.map((native) => Canonical.canonicalTree(native)),
      );
    default:
      return Effect.fail(
        new Error(`Unsupported bookmarks target '${displayNameOf(target)}' at ${target.path}`),
      );
  }
};

export const applyPatches = (
  target: TargetDescriptor,
  patches: readonly Patch.BookmarkPatch[],
): Effect.Effect<void, Error> => {
  if (patches.length === 0) return Effect.void;

  switch (target.browser) {
    case "safari":
      return Safari.applyPatches(target.path, patches);
    case "chrome":
      return ChromeNative.isPaired(target.path).pipe(
        Effect.flatMap((paired) =>
          paired
            ? Effect.fail(
                new Error(
                  "Paired Chrome writes require a complete planned tree and its original snapshot. Use bookmarks sync.",
                ),
              )
            : Chrome.applyPatches(target.path, patches),
        ),
      );
    default:
      return Effect.fail(
        new Error(`Unsupported bookmarks target '${displayNameOf(target)}' at ${target.path}`),
      );
  }
};

export const requiresFullRewrite = (
  target: TargetDescriptor,
  patches: readonly Patch.BookmarkPatch[],
): Effect.Effect<boolean, Error> => {
  switch (target.browser) {
    case "safari":
      return Safari.requiresFullRewrite(target.path, patches);
    case "chrome":
      return patches.length === 0 ? Effect.succeed(false) : ChromeNative.isPaired(target.path);
    default:
      return Effect.fail(
        new Error(`Unsupported bookmarks target '${displayNameOf(target)}' at ${target.path}`),
      );
  }
};

export const writeTree = (
  target: TargetDescriptor,
  tree: BookmarkTree,
  expectedTree?: BookmarkTree,
): Effect.Effect<void, Error> => {
  switch (target.browser) {
    case "safari":
      return Safari.writeTree(target.path, tree);
    case "chrome":
      return Effect.gen(function* () {
        const paired = yield* ChromeNative.isPaired(target.path);
        const observed = yield* readState(target);
        if (expectedTree !== undefined && !ChromeNative.treesEqual(observed.tree, expectedTree))
          return yield* Effect.fail(
            new Error(
              `${displayNameOf(target)} bookmarks changed after the sync planned its write. The next sync retries.`,
            ),
          );
        if (!paired) return yield* Chrome.writeTree(target.path, tree);
        yield* ChromeNative.writeState(
          target.path,
          observed,
          TargetState.make({ tree, readingList: observed.readingList }),
        );
      });
    default:
      return Effect.fail(
        new Error(`Unsupported bookmarks target '${displayNameOf(target)}' at ${target.path}`),
      );
  }
};
