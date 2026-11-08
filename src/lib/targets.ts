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
import { BookmarkFolder, type BookmarkNode, BookmarkTree } from "./schema/__.ts";
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

/**
 * Chrome has no reading list an extension can write, so the shared reading list lives in this
 * folder of Other Bookmarks. The engine sees it as Chrome's `reading_list` section.
 */
export const CHROME_READING_LIST_FOLDER = "Read Later";

const isReadingListFolder = (node: BookmarkNode): node is BookmarkFolder =>
  BookmarkFolder.is(node) && node.name === CHROME_READING_LIST_FOLDER;

/**
 * Refuse a tree a target can't hold, before any browser is written. In Chrome, a regular
 * folder named Read Later at the top of Other Bookmarks would read back as the reading list.
 */
export const ensureWritable = (
  target: Pick<TargetDescriptor, "browser" | "profile">,
  tree: BookmarkTree,
): Effect.Effect<void, Error> =>
  target.browser === "chrome" && (tree.menu ?? []).some(isReadingListFolder)
    ? Effect.fail(
        new Error(
          `${displayNameOf(target)} keeps the reading list in Other Bookmarks' "${CHROME_READING_LIST_FOLDER}" folder, so its Other Bookmarks can't hold another top-level folder named "${CHROME_READING_LIST_FOLDER}". Rename that folder in bookmarks.yaml or in the browser it came from.`,
        ),
      )
    : Effect.void;

/** Chrome's own layout to the engine's: the first Read Later folder of Other Bookmarks is the reading list. */
export const fromChromeLayout = (native: BookmarkTree): BookmarkTree => {
  const menu = native.menu ?? [];
  const index = menu.findIndex(isReadingListFolder);
  const folder = menu[index];
  if (folder === undefined || !BookmarkFolder.is(folder)) return native;
  const rest = [...menu.slice(0, index), ...menu.slice(index + 1)];
  return BookmarkTree.make({
    ...(native.bar ? { bar: native.bar } : {}),
    ...(rest.length > 0 ? { menu: rest } : {}),
    ...(folder.children.length > 0 ? { reading_list: folder.children } : {}),
    ...(native.mobile ? { mobile: native.mobile } : {}),
  });
};

/**
 * The engine's layout to Chrome's. The Read Later folder keeps its place in `current`, Chrome's
 * tree before the write, and is appended to Other Bookmarks when Chrome has none.
 */
export const toChromeLayout = (tree: BookmarkTree, current?: BookmarkTree): BookmarkTree => {
  const menu = [...(tree.menu ?? [])];
  const readingList = tree.reading_list ?? [];
  const currentIndex = (current?.menu ?? []).findIndex(isReadingListFolder);
  if (readingList.length > 0 || currentIndex !== -1) {
    const index = currentIndex === -1 ? menu.length : Math.min(currentIndex, menu.length);
    menu.splice(
      index,
      0,
      BookmarkFolder.make({ name: CHROME_READING_LIST_FOLDER, children: readingList }),
    );
  }
  return BookmarkTree.make({
    ...(tree.bar ? { bar: tree.bar } : {}),
    ...(tree.menu || menu.length > 0 ? { menu } : {}),
    ...(tree.mobile ? { mobile: tree.mobile } : {}),
  });
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
      return readChromeNative(target).pipe(
        Effect.map((native) => Canonical.canonicalTree(fromChromeLayout(native))),
      );
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
        Effect.map((native) => Canonical.canonicalTree(fromChromeLayout(native))),
      );
    default:
      return Effect.fail(
        new Error(`Unsupported bookmarks target '${displayNameOf(target)}' at ${target.path}`),
      );
  }
};

const touchesReadingList = (patch: Patch.BookmarkPatch): boolean =>
  "path" in patch
    ? patch.path.startsWith("reading_list")
    : patch.fromPath.startsWith("reading_list") || patch.toPath.startsWith("reading_list");

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
            : patches.some(touchesReadingList)
              ? Effect.fail(new Error("Chrome reading list changes are written as a whole tree."))
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
      return patches.length === 0
        ? Effect.succeed(false)
        : patches.some(touchesReadingList)
          ? Effect.succeed(true)
          : ChromeNative.isPaired(target.path);
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
        const native = yield* readChromeNative(target);
        if (
          expectedTree !== undefined &&
          !ChromeNative.treesEqual(
            toChromeLayout(Canonical.canonicalTree(fromChromeLayout(native)), native),
            toChromeLayout(expectedTree, native),
          )
        ) {
          return yield* Effect.fail(
            new Error(
              `${displayNameOf(target)} bookmarks changed after the sync planned its write. The next sync retries.`,
            ),
          );
        }
        const desired = toChromeLayout(tree, native);
        if (!(yield* ChromeNative.isPaired(target.path)))
          return yield* Chrome.writeTree(target.path, desired);
        yield* ChromeNative.writeTree(target.path, native, desired);
      });
    default:
      return Effect.fail(
        new Error(`Unsupported bookmarks target '${displayNameOf(target)}' at ${target.path}`),
      );
  }
};
