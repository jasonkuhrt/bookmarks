/* oxlint-disable no-unnecessary-condition, restrict-template-expressions */
/**
 * Load and save bookmarks.yaml.
 *
 * Reads the YAML source of truth, validates against the schema,
 * and writes back after sync operations.
 */

import { Effect, Schema } from "effect";
import * as Yaml from "yaml";
import * as Fs from "node:fs/promises";
import * as ManagedPaths from "./managed-paths.ts";
import type { BookmarkSection } from "./schema/__.ts";
import {
  BookmarkTree,
  BookmarksConfig,
  ChromeBookmarks,
  ChromeProfileBookmarks,
  SafariBookmarks,
} from "./schema/__.ts";

interface ResolvedTarget {
  readonly browser: string;
  readonly profile?: string;
}

const sectionKeys = ["bar", "menu", "reading_list", "mobile"] as const;
type SectionKey = (typeof sectionKeys)[number];

const supportedSectionsByBrowser: Record<string, readonly SectionKey[]> = {
  safari: ["bar", "menu", "reading_list"],
  chrome: ["bar", "menu", "mobile"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeTreeDocument = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return undefined;

  const tree: Record<string, unknown> = {};

  if ("bar" in value) tree["bar"] = value["bar"];
  else if ("favorites_bar" in value) tree["bar"] = value["favorites_bar"];

  if ("menu" in value) tree["menu"] = value["menu"];
  else if ("other" in value) tree["menu"] = value["other"];

  if ("reading_list" in value) tree["reading_list"] = value["reading_list"];
  if ("mobile" in value) tree["mobile"] = value["mobile"];

  return tree;
};

const normalizeSafariDocument = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return undefined;
  const tree = normalizeTreeDocument(value) ?? {};
  return {
    ...("enabled" in value ? { enabled: value["enabled"] } : {}),
    ...tree,
  };
};

const normalizeChromeProfileDocument = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return undefined;
  const tree = normalizeTreeDocument(value) ?? {};
  return {
    ...("enabled" in value ? { enabled: value["enabled"] } : {}),
    ...tree,
  };
};

const normalizeChromeDocument = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return undefined;
  const tree = normalizeTreeDocument(value) ?? {};
  const profiles = isRecord(value["profiles"])
    ? Object.fromEntries(
        Object.entries(value["profiles"])
          .map(
            ([profile, profileValue]) =>
              [profile, normalizeChromeProfileDocument(profileValue)] as const,
          )
          .filter(([, profileValue]) => profileValue !== null),
      )
    : undefined;

  return {
    ...("enabled" in value ? { enabled: value["enabled"] } : {}),
    ...tree,
    ...(profiles && Object.keys(profiles).length > 0 ? { profiles } : {}),
  };
};

const ensureChromeTreeDoesNotUseReadingList = (
  tree: Record<string, unknown> | undefined,
  label: string,
): void => {
  if (tree?.["reading_list"] !== undefined) {
    throw new Error(
      `${label} cannot define reading_list. Use top-level all.reading_list or safari.reading_list instead.`,
    );
  }
};

const deriveBrowserEnabled = (
  profiles: Record<string, unknown> | undefined,
): boolean | undefined => {
  if (!profiles || Object.keys(profiles).length === 0) return undefined;
  const enabledStates = Object.values(profiles).map((value) =>
    isRecord(value) && typeof value["enabled"] === "boolean" ? value["enabled"] : true,
  );
  return enabledStates.some(Boolean);
};

const normalizeLegacyDocument = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  if (!("targets" in value) && !("base" in value) && !("profiles" in value)) return value;

  const legacyTargets = isRecord(value["targets"]) ? value["targets"] : {};
  const legacyBase = normalizeTreeDocument(value["base"]) ?? {};
  const legacyProfiles = isRecord(value["profiles"]) ? value["profiles"] : {};
  const safariTargets = isRecord(legacyTargets["safari"]) ? legacyTargets["safari"] : undefined;
  const chromeTargets = isRecord(legacyTargets["chrome"]) ? legacyTargets["chrome"] : undefined;
  const chromeProfiles: Record<string, unknown> = {};

  if (chromeTargets) {
    for (const [profile, targetValue] of Object.entries(chromeTargets)) {
      if (!isRecord(targetValue)) continue;
      chromeProfiles[profile] = "enabled" in targetValue ? { enabled: targetValue["enabled"] } : {};
    }
  }

  for (const [profileKey, treeValue] of Object.entries(legacyProfiles)) {
    const slashIndex = profileKey.indexOf("/");
    if (slashIndex === -1) {
      throw new Error(
        `Legacy profile overlay "${profileKey}" is invalid. Move Chrome overlays under chrome.profiles.<name>.`,
      );
    }

    const browser = profileKey.slice(0, slashIndex);
    const profile = profileKey.slice(slashIndex + 1);
    if (browser === "safari") {
      throw new Error(
        `Legacy Safari profile overlay "${profileKey}" is no longer supported. Move shared Safari bookmarks under the top-level safari key.`,
      );
    }
    if (browser !== "chrome") {
      throw new Error(`Legacy profile overlay "${profileKey}" is not supported.`);
    }

    const normalizedTree = normalizeTreeDocument(treeValue) ?? {};
    ensureChromeTreeDoesNotUseReadingList(normalizedTree, `chrome.profiles.${profile}`);
    chromeProfiles[profile] = {
      ...(isRecord(chromeProfiles[profile]) ? chromeProfiles[profile] : {}),
      ...normalizedTree,
    };
  }

  const safariEnabled = deriveBrowserEnabled(safariTargets);
  const chromeEnabled = deriveBrowserEnabled(chromeTargets);

  return {
    version: 2,
    all: legacyBase,
    ...(safariEnabled !== undefined ? { safari: { enabled: safariEnabled } } : {}),
    ...(chromeEnabled !== undefined || Object.keys(chromeProfiles).length > 0
      ? {
          chrome: {
            ...(chromeEnabled !== undefined ? { enabled: chromeEnabled } : {}),
            ...(Object.keys(chromeProfiles).length > 0 ? { profiles: chromeProfiles } : {}),
          },
        }
      : {}),
  };
};

const normalizeDocument = (value: unknown): unknown => {
  const legacy = normalizeLegacyDocument(value);
  if (!isRecord(legacy)) return legacy;

  const normalized = {
    ...legacy,
    version: 2,
    all: normalizeTreeDocument(legacy["all"]) ?? {},
    ...(legacy["safari"] !== undefined
      ? { safari: normalizeSafariDocument(legacy["safari"]) }
      : {}),
    ...(legacy["chrome"] !== undefined
      ? { chrome: normalizeChromeDocument(legacy["chrome"]) }
      : {}),
  };

  const chrome = normalized["chrome"];
  if (chrome && isRecord(chrome)) {
    ensureChromeTreeDoesNotUseReadingList(chrome, "chrome");
    const profiles = isRecord(chrome["profiles"]) ? chrome["profiles"] : undefined;
    if (profiles) {
      for (const [profile, profileValue] of Object.entries(profiles)) {
        ensureChromeTreeDoesNotUseReadingList(
          isRecord(profileValue) ? profileValue : undefined,
          `chrome.profiles.${profile}`,
        );
      }
    }
  }

  return normalized;
};

const treeFrom = (
  value: Pick<BookmarkTree, "bar" | "menu" | "reading_list" | "mobile"> | undefined,
): BookmarkTree =>
  BookmarkTree.make({
    bar: value?.bar,
    menu: value?.menu,
    reading_list: value?.reading_list,
    mobile: value?.mobile,
  });

const projectTreeForBrowser = (tree: BookmarkTree, browser: string): BookmarkTree => {
  const supportedSections = new Set(supportedSectionsByBrowser[browser] ?? sectionKeys);
  return BookmarkTree.make({
    bar: supportedSections.has("bar") ? tree.bar : undefined,
    menu: supportedSections.has("menu") ? tree.menu : undefined,
    reading_list: supportedSections.has("reading_list") ? tree.reading_list : undefined,
    mobile: supportedSections.has("mobile") ? tree.mobile : undefined,
  });
};

const mergeTrees = (base: BookmarkTree, overlay: BookmarkTree): BookmarkTree =>
  BookmarkTree.make({
    bar: mergeSection(base.bar, overlay.bar),
    menu: mergeSection(base.menu, overlay.menu),
    reading_list: mergeSection(base.reading_list, overlay.reading_list),
    mobile: mergeSection(base.mobile, overlay.mobile),
  });

export const decodeDocument = (
  value: unknown,
  source: string,
): Effect.Effect<BookmarksConfig, Error> =>
  Effect.gen(function* () {
    const normalized = yield* Effect.try({
      try: () => normalizeDocument(value),
      catch: (e) => new Error(`Failed to normalize ${source}: ${e}`),
    });
    return yield* Schema.decodeUnknown(BookmarksConfig)(normalized).pipe(
      Effect.mapError((e) => new Error(`Schema validation failed for ${source}: ${e.message}`)),
    );
  });

/** Load and validate bookmarks.yaml from the given path. */
export const load = (path: string): Effect.Effect<BookmarksConfig, Error> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => Fs.readFile(path, "utf-8"),
      catch: (e) => new Error(`Failed to read ${path}: ${e}`),
    });
    const parsed = yield* Effect.try({
      try: () => Yaml.parse(raw) as unknown,
      catch: (e) => new Error(`Failed to parse ${path}: ${e}`),
    });
    return yield* decodeDocument(parsed, path);
  });

const SCHEMA_MODELINE = "# yaml-language-server: $schema=./bookmarks.schema.json\n";

/** Write a BookmarksConfig back to bookmarks.yaml. */
export const save = (path: string, config: BookmarksConfig): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encode(BookmarksConfig)(
      BookmarksConfig.make({
        version: 2,
        all: config.all,
        safari: config.safari ? SafariBookmarks.make(config.safari) : undefined,
        chrome: config.chrome
          ? ChromeBookmarks.make({
              enabled: config.chrome.enabled,
              bar: config.chrome.bar,
              menu: config.chrome.menu,
              mobile: config.chrome.mobile,
              profiles: config.chrome.profiles
                ? Object.fromEntries(
                    Object.entries(config.chrome.profiles).map(([profile, profileConfig]) => [
                      profile,
                      ChromeProfileBookmarks.make(profileConfig),
                    ]),
                  )
                : undefined,
            })
          : undefined,
      }),
    ).pipe(Effect.mapError((e) => new Error(`Schema encoding failed: ${e.message}`)));
    const yamlStr = SCHEMA_MODELINE + Yaml.stringify(encoded, { indent: 2 });
    yield* ManagedPaths.ensureParentDir(path);
    yield* Effect.tryPromise({
      try: () => Fs.writeFile(path, yamlStr, "utf-8"),
      catch: (e) => new Error(`Failed to write ${path}: ${e}`),
    });
  });

export const configuredChromeProfiles = (config: BookmarksConfig): readonly string[] =>
  Object.keys(config.chrome?.profiles ?? {});

export const isTargetEnabled = (config: BookmarksConfig, target: ResolvedTarget): boolean => {
  switch (target.browser) {
    case "safari":
      return config.safari?.enabled ?? true;
    case "chrome":
      return (
        (config.chrome?.enabled ?? true) &&
        (target.profile ? (config.chrome?.profiles?.[target.profile]?.enabled ?? true) : true)
      );
    default:
      return true;
  }
};

export const resolveTarget = (
  config: BookmarksConfig,
  target: ResolvedTarget,
): Effect.Effect<BookmarkTree, Error> => {
  const shared = projectTreeForBrowser(config.all, target.browser);

  switch (target.browser) {
    case "safari":
      return Effect.succeed(
        mergeTrees(shared, projectTreeForBrowser(treeFrom(config.safari), "safari")),
      );
    case "chrome":
      return Effect.succeed(
        mergeTrees(
          mergeTrees(shared, projectTreeForBrowser(treeFrom(config.chrome), "chrome")),
          projectTreeForBrowser(
            treeFrom(target.profile ? config.chrome?.profiles?.[target.profile] : undefined),
            "chrome",
          ),
        ),
      );
    default:
      return Effect.succeed(shared);
  }
};

/** Append profile-specific items after base items in a section. */
const mergeSection = (
  base: BookmarkSection | undefined,
  overlay: BookmarkSection | undefined,
): BookmarkSection | undefined => {
  if (!base && !overlay) return undefined;
  if (!overlay) return base;
  if (!base) return overlay;
  return [...base, ...overlay];
};
