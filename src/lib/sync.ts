/**
 * Core sync engine.
 *
 * Pipeline: sync baseline -> three-way diff -> resolve conflicts -> apply -> save -> baseline advance.
 * When bookmarks.yaml is tracked by git, HEAD is the sync baseline. Otherwise we keep
 * a managed sync baseline in state storage so sync remains incremental outside git.
 * Produces graveyard entries for conflict losers.
 */

import { Array as Arr, DateTime, Duration, Effect, HashSet } from "effect";
import { execFile } from "node:child_process";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Yaml from "yaml";
import * as ManagedPaths from "./managed-paths.ts";
import * as Paths from "./paths.ts";
import * as Chrome from "./chrome.ts";
import * as ChromeNative from "./chrome-native.ts";
import * as Graveyard from "./graveyard.ts";
import * as Orchestration from "./orchestration.ts";
import * as Patch from "./patch.ts";
import * as Permissions from "./permissions.ts";
import * as Targets from "./targets.ts";
import type { BookmarkNode, BookmarkSection } from "./schema/__.ts";
import {
  BookmarkFolder,
  BookmarkLeaf,
  BookmarkTree,
  BookmarksConfig,
  ChromeBookmarks,
  ChromeProfileBookmarks,
  SafariBookmarks,
} from "./schema/__.ts";
import { collectAmbiguousPathIssues, ensureUnambiguousPaths } from "./unsupported.ts";
import * as YamlModule from "./yaml.ts";

export interface SyncResult {
  readonly applied: readonly Patch.BookmarkPatch[];
  readonly graveyarded: readonly Patch.BookmarkPatch[];
  readonly targets: readonly TargetResult[];
  readonly orchestration?: Orchestration.SyncNotice;
  readonly backup?: BackupResult;
}

export interface ConflictResolution {
  readonly apply: readonly Patch.BookmarkPatch[];
  readonly graveyard: readonly Patch.BookmarkPatch[];
}

export interface TargetResult {
  readonly target: Targets.TargetDescriptor;
  readonly applied: readonly Patch.BookmarkPatch[];
  readonly graveyarded: readonly Patch.BookmarkPatch[];
  readonly writeMode?: "patches" | "rewrite";
}

export interface StatusTargetResult {
  readonly target: Targets.TargetDescriptor;
  readonly yamlPatches: readonly Patch.BookmarkPatch[];
  readonly browserPatches: readonly Patch.BookmarkPatch[];
  readonly yamlDuplicates: Patch.DuplicateCounts;
  readonly browserDuplicates: Patch.DuplicateCounts;
}

export interface StatusResult {
  readonly yamlPath: string;
  readonly targets: readonly StatusTargetResult[];
}

export interface BackupResult {
  readonly backupDir: string;
  readonly files: readonly string[];
  readonly skipped: readonly string[];
}

interface ResolvedGitTarget {
  readonly repoRoot: string;
  readonly relPath: string;
}

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const expectDefined = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
};

const fileExists = (path: string): Effect.Effect<boolean, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await Fs.access(path);
        return true;
      } catch {
        return false;
      }
    },
    catch: (error) => new Error(`Failed to inspect ${path}: ${messageFromUnknown(error)}`),
  });

const hasChromeProfile = (
  target: Pick<Targets.TargetDescriptor, "browser" | "profile">,
): target is Pick<Targets.TargetDescriptor, "browser"> & { readonly profile: string } =>
  target.browser === "chrome" && typeof target.profile === "string";

const recordFromEntries = <K extends string, V>(
  entries: Iterable<readonly [K, V]>,
): Record<K, V> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries preserves the supplied entry pairs but widens their key/value types.
  return Object.fromEntries(entries) as Record<K, V>;
};

const targetTree = <V>(trees: Readonly<Record<string, V>>, targetId: string): V =>
  expectDefined(trees[targetId], `Missing resolved tree for ${targetId}`);

// -- Git baseline --

/**
 * Read the last-committed version of bookmarks.yaml from git.
 * Returns empty BookmarkTree if the file has never been committed.
 */
const readGitBaselineConfigAt = (
  resolvedGitTarget: ResolvedGitTarget,
): Effect.Effect<BookmarksConfig | null, Error> =>
  Effect.gen(function* () {
    const { repoRoot, relPath } = resolvedGitTarget;

    const raw = yield* Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          execFile("git", ["show", `HEAD:${relPath}`], { cwd: repoRoot }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
        }),
      catch: () => new Error(`git show HEAD:${relPath} failed — treating as fresh sync`),
    }).pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));

    if (raw === null) {
      yield* Effect.log("No committed bookmarks.yaml found — using empty baseline (fresh sync)");
      return null;
    }

    // Parse and validate the committed YAML
    const parsed = yield* Effect.try({
      try: () => Yaml.parse(raw) as unknown,
      catch: (error) =>
        new Error(`Failed to parse committed bookmarks.yaml: ${messageFromUnknown(error)}`),
    });
    const config = yield* YamlModule.decodeDocument(parsed, "committed bookmarks.yaml");
    return config;
  });

export const readGitBaselineConfig = (
  yamlPath: string,
): Effect.Effect<BookmarksConfig | null, Error> =>
  Effect.gen(function* () {
    const resolvedGitTarget = yield* resolveGitTarget(yamlPath);
    if (!resolvedGitTarget) {
      yield* Effect.log("bookmarks.yaml is not inside a git repo — using empty baseline");
      return null;
    }

    return yield* readGitBaselineConfigAt(resolvedGitTarget);
  });

export const readGitBaseline = (yamlPath: string): Effect.Effect<BookmarkTree, Error> =>
  readGitBaselineConfig(yamlPath).pipe(
    Effect.map((config) => config?.all ?? BookmarkTree.make({})),
  );

/** Resolve the git repo root for a given file path. */
const gitRepoRoot = (filePath: string): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          "git",
          ["rev-parse", "--show-toplevel"],
          { cwd: Path.dirname(filePath) },
          (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout.trim());
          },
        );
      }),
    catch: (error) => new Error(`Failed to find git repo root: ${messageFromUnknown(error)}`),
  });

/** Resolve a possibly symlinked home path to the repo-relative file path git expects. */
const resolveGitTarget = (filePath: string): Effect.Effect<ResolvedGitTarget | undefined, Error> =>
  Effect.gen(function* () {
    const realDir = yield* Effect.tryPromise({
      try: () => Fs.realpath(Path.dirname(filePath)),
      catch: (error) =>
        new Error(`Failed to resolve real path for ${filePath}: ${messageFromUnknown(error)}`),
    }).pipe(Effect.catchAll(() => Effect.succeed(Path.dirname(filePath))));
    const canonicalPath = Path.join(realDir, Path.basename(filePath));
    const repoRoot = yield* gitRepoRoot(canonicalPath).pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
    if (!repoRoot) return undefined;
    return {
      repoRoot,
      relPath: Path.relative(repoRoot, canonicalPath),
    };
  });

const readManagedBaselineConfig = (): Effect.Effect<BookmarksConfig | null, Error> =>
  Effect.gen(function* () {
    const baselinePath = Paths.defaultSyncBaselinePath();
    const exists = yield* fileExists(baselinePath);

    if (!exists) {
      yield* Effect.log(`No managed sync baseline found at ${baselinePath} — using empty baseline`);
      return null;
    }

    yield* Effect.log(`Using managed sync baseline from ${baselinePath}`);
    return yield* YamlModule.load(baselinePath);
  });

const readSyncBaselineConfig = (yamlPath: string): Effect.Effect<BookmarksConfig | null, Error> =>
  Effect.gen(function* () {
    const resolvedGitTarget = yield* resolveGitTarget(yamlPath);
    if (resolvedGitTarget) {
      return yield* readGitBaselineConfigAt(resolvedGitTarget);
    }

    return yield* readManagedBaselineConfig();
  });

const advanceSyncBaseline = (
  yamlPath: string,
  config: BookmarksConfig,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const resolvedGitTarget = yield* resolveGitTarget(yamlPath);
    if (resolvedGitTarget) return;

    const baselinePath = Paths.defaultSyncBaselinePath();
    yield* Effect.log(`Saving managed sync baseline to ${baselinePath}...`);
    yield* YamlModule.saveStateFile(baselinePath, config);
  });

/** Auto-commit bookmarks.yaml so the committed version becomes the new baseline. */
export const gitAutoCommit = (yamlPath: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const resolvedGitTarget = yield* resolveGitTarget(yamlPath);
    if (!resolvedGitTarget) {
      yield* Effect.log("Skipping auto-commit because bookmarks.yaml is not inside a git repo");
      return;
    }
    const { repoRoot, relPath } = resolvedGitTarget;

    // Stage the file
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          execFile("git", ["add", relPath], { cwd: repoRoot }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
      catch: (error) => new Error(`git add failed: ${messageFromUnknown(error)}`),
    });

    // Check if there are staged changes to commit
    const hasStagedChanges = yield* Effect.tryPromise({
      try: () =>
        new Promise<boolean>((resolve, reject) => {
          execFile(
            "git",
            ["diff", "--cached", "--quiet", "--", relPath],
            { cwd: repoRoot },
            (err) => {
              if (err && "code" in err && err.code === 1)
                resolve(true); // exit code 1 = differences
              else if (err) reject(err);
              else resolve(false); // exit code 0 = no differences
            },
          );
        }),
      catch: (error) => new Error(`git diff --cached failed: ${messageFromUnknown(error)}`),
    });

    if (!hasStagedChanges) {
      yield* Effect.log("No changes to commit (bookmarks.yaml unchanged)");
      return;
    }

    // Commit with auto-sync message
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          execFile(
            "git",
            ["commit", "-m", "chore(bookmarks): auto-sync bookmarks.yaml", "--", relPath],
            { cwd: repoRoot },
            (err) => {
              if (err) reject(err);
              else resolve();
            },
          );
        }),
      catch: (error) => new Error(`git commit failed: ${messageFromUnknown(error)}`),
    });

    yield* Effect.log("Auto-committed bookmarks.yaml (new baseline)");
  });

// -- resolveConflicts --

const conflictKey = (patch: Patch.BookmarkPatch): string =>
  Patch.$match(patch, {
    Add: ({ url, name, path }) => JSON.stringify(["target", url, name, path]),
    Remove: ({ url, name, path }) => JSON.stringify(["source", url, name, path]),
    Update: ({ url, oldName, fromPath }) => JSON.stringify(["source", url, oldName, fromPath]),
  });

const patchContentKey = (patch: Patch.BookmarkPatch): string =>
  Patch.$match(patch, {
    Add: ({ url, name, path }) => JSON.stringify(["Add", url, name, path]),
    Remove: ({ url, name, path }) => JSON.stringify(["Remove", url, name, path]),
    Update: ({ url, oldName, newName, fromPath, toPath }) =>
      JSON.stringify(["Update", url, oldName, newName, fromPath, toPath]),
  });

/** Resolve conflicts between patches for the same bookmark occurrence. Newest wins. */
export const resolveConflicts = (
  yamlPatches: readonly Patch.BookmarkPatch[],
  browserPatches: readonly Patch.BookmarkPatch[],
): Effect.Effect<ConflictResolution, Error> => {
  const yamlByOccurrence = Arr.groupBy(yamlPatches, conflictKey);
  const browserByOccurrence = Arr.groupBy(browserPatches, conflictKey);

  const apply: Patch.BookmarkPatch[] = [];
  const graveyard: Patch.BookmarkPatch[] = [];

  let allOccurrences = HashSet.empty<string>();
  for (const occurrence of Object.keys(yamlByOccurrence)) {
    allOccurrences = HashSet.add(allOccurrences, occurrence);
  }
  for (const occurrence of Object.keys(browserByOccurrence)) {
    allOccurrences = HashSet.add(allOccurrences, occurrence);
  }

  for (const occurrence of [...allOccurrences].sort()) {
    const yamlGroup = yamlByOccurrence[occurrence];
    const browserGroup = browserByOccurrence[occurrence];

    if (yamlGroup && !browserGroup) {
      apply.push(...yamlGroup);
    } else if (browserGroup && !yamlGroup) {
      apply.push(...browserGroup);
    } else if (yamlGroup && browserGroup) {
      const pairCount = Math.max(yamlGroup.length, browserGroup.length);
      for (let index = 0; index < pairCount; index++) {
        const yamlPatch = yamlGroup[index];
        const browserPatch = browserGroup[index];
        if (!yamlPatch && browserPatch) {
          apply.push(browserPatch);
          continue;
        }
        if (yamlPatch && !browserPatch) {
          apply.push(yamlPatch);
          continue;
        }
        if (!yamlPatch || !browserPatch) continue;

        if (patchContentKey(yamlPatch) === patchContentKey(browserPatch)) {
          apply.push(yamlPatch);
        } else if (DateTime.greaterThan(browserPatch.date, yamlPatch.date)) {
          apply.push(browserPatch);
          graveyard.push(yamlPatch);
        } else {
          // YAML wins (tie-break: YAML wins when equal)
          apply.push(yamlPatch);
          graveyard.push(browserPatch);
        }
      }
    }
  }

  return Effect.succeed({ apply, graveyard });
};

// -- applyPatches --

/** Apply a set of patches to a bookmark tree, producing the updated tree. */
export const applyPatches = (
  tree: BookmarkTree,
  patches: readonly Patch.BookmarkPatch[],
): Effect.Effect<BookmarkTree, Error> =>
  Effect.try({
    try: () => {
      const nextTree = Patch.toTrie(tree);

      for (const patch of patches) {
        Patch.$match(patch, {
          Add: ({ path }) => {
            requireBookmarkPath(path);
          },
          Remove: ({ path }) => {
            requireBookmarkPath(path);
          },
          Update: ({ fromPath, toPath }) => {
            requireBookmarkPath(fromPath);
            requireBookmarkPath(toPath);
          },
        });
      }

      // Claim every source occurrence before mutation so swaps cannot retarget a
      // node changed by an earlier patch.
      const claimedSources: BookmarkLeaf[] = [];
      const claimed = patches.map((patch) => {
        const source = Patch.$match(patch, {
          Add: () => undefined,
          Remove: ({ url, name, path }) => claimLeaf(nextTree, url, name, path, claimedSources),
          Update: ({ url, oldName, fromPath }) =>
            claimLeaf(nextTree, url, oldName, fromPath, claimedSources),
        });

        if (!Patch.$is("Add")(patch) && !source) {
          throw new Error(`Missing bookmark source for ${patch._tag} "${patch.url}".`);
        }
        if (source) claimedSources.push(source);
        return { patch, source };
      });
      const sorted = Patch.sortForApplyBy(claimed, (item) => item.patch);

      for (const item of sorted) {
        applyOne(nextTree, item.patch, item.source);
      }

      return Patch.fromTrie(nextTree);
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Failed to apply bookmark patches.", { cause }),
  });

const sectionKeys = ["bar", "menu", "reading_list", "mobile"] as const;

type SectionKey = (typeof sectionKeys)[number];
type MutableBookmarkSection = BookmarkNode[];
type MutableBookmarkTree = Record<SectionKey, MutableBookmarkSection | undefined>;

const supportedSectionsByBrowser: Record<string, readonly SectionKey[]> = {
  safari: ["bar", "menu", "reading_list"],
  chrome: ["bar", "menu", "mobile"],
};

const emptyTree = (): BookmarkTree => BookmarkTree.make({});

const sectionKeysForBrowser = (browser: string): readonly SectionKey[] =>
  supportedSectionsByBrowser[browser] ?? sectionKeys;

const resolvedTargetOf = (
  target: Pick<Targets.TargetDescriptor, "browser" | "profile">,
): { readonly browser: string; readonly profile?: string } =>
  target.profile
    ? { browser: target.browser, profile: target.profile }
    : { browser: target.browser };

const browserOfTargetId = (targetId: string): string =>
  targetId === "safari" ? "safari" : (targetId.split("/")[0] ?? targetId);

const profileOfTargetId = (targetId: string): string | undefined => {
  const slashIndex = targetId.indexOf("/");
  return slashIndex === -1 ? undefined : targetId.slice(slashIndex + 1);
};

const resolvedTargetOfId = (
  targetId: string,
): { readonly browser: string; readonly profile?: string } => {
  const profile = profileOfTargetId(targetId);
  return profile
    ? { browser: browserOfTargetId(targetId), profile }
    : { browser: browserOfTargetId(targetId) };
};

const asMutableTree = (tree: BookmarkTree): MutableBookmarkTree =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Patch application mutates an internal working copy before re-materializing an immutable tree.
  tree as unknown as MutableBookmarkTree;

const asMutableSection = (nodes: BookmarkSection): MutableBookmarkSection =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Folder children arrays are mutated only while assembling a new tree instance.
  nodes as MutableBookmarkSection;

const cloneNode = (node: BookmarkNode): BookmarkNode =>
  BookmarkLeaf.is(node)
    ? BookmarkLeaf.make({ name: node.name, url: node.url })
    : BookmarkFolder.make({
        name: node.name,
        children: cloneSection(node.children) ?? [],
      });

const cloneSection = (nodes: BookmarkSection | undefined): BookmarkSection | undefined =>
  nodes?.map((node) => cloneNode(node));

const normalizeSection = (nodes: BookmarkSection | undefined): BookmarkSection | undefined =>
  nodes && nodes.length > 0 ? nodes : undefined;

const setSection = (
  tree: BookmarkTree,
  sectionKey: SectionKey,
  nodes: MutableBookmarkSection | undefined,
): void => {
  asMutableTree(tree)[sectionKey] = nodes;
};

const ensureSection = (tree: BookmarkTree, sectionKey: SectionKey): MutableBookmarkSection => {
  const existing = asMutableTree(tree)[sectionKey];
  if (existing) return existing;

  const created: MutableBookmarkSection = [];
  setSection(tree, sectionKey, created);
  return created;
};

const ensureFolderPath = (
  nodes: MutableBookmarkSection,
  folderPath: readonly string[],
): MutableBookmarkSection => {
  let current = nodes;

  for (const folderName of folderPath) {
    const existing = current.find(
      (node): node is BookmarkFolder => BookmarkFolder.is(node) && node.name === folderName,
    );

    if (existing) {
      current = asMutableSection(existing.children);
      continue;
    }

    const created = BookmarkFolder.make({ name: folderName, children: [] });
    current.push(created);
    current = asMutableSection(created.children);
  }

  return current;
};

const parseBookmarkPath = (
  path: string,
): { readonly sectionKey: SectionKey; readonly folderPath: readonly string[] } | undefined => {
  const [rawSectionKey, ...folderPath] = path.split("/");
  const sectionKey = sectionKeys.find((key) => key === rawSectionKey);
  return sectionKey ? { sectionKey, folderPath } : undefined;
};

const requireBookmarkPath = (path: string): void => {
  if (!parseBookmarkPath(path)) throw new Error(`Invalid bookmark path "${path}".`);
};

const cleanupEmptyRootSections = (tree: BookmarkTree): void => {
  for (const sectionKey of sectionKeys) {
    if ((tree[sectionKey]?.length ?? 0) === 0) {
      setSection(tree, sectionKey, undefined);
    }
  }
};

const findParentAtPath = (tree: BookmarkTree, path: string): MutableBookmarkSection | undefined => {
  const parsed = parseBookmarkPath(path);
  if (!parsed) return undefined;

  let current = asMutableTree(tree)[parsed.sectionKey];
  if (!current) return undefined;

  for (const folderName of parsed.folderPath) {
    const folder = current.find(
      (node): node is BookmarkFolder => BookmarkFolder.is(node) && node.name === folderName,
    );
    if (!folder) return undefined;
    current = asMutableSection(folder.children);
  }

  return current;
};

const claimLeaf = (
  tree: BookmarkTree,
  url: string,
  name: string,
  path: string,
  claimed: readonly BookmarkLeaf[],
): BookmarkLeaf | undefined => {
  const children = findParentAtPath(tree, path);
  return children?.find(
    (node): node is BookmarkLeaf =>
      BookmarkLeaf.is(node) && node.url === url && node.name === name && !claimed.includes(node),
  );
};

const findLeafReferenceLocationInSection = (
  nodes: MutableBookmarkSection,
  target: BookmarkLeaf,
): { readonly children: MutableBookmarkSection; readonly index: number } | undefined => {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node === target) return { children: nodes, index };
    if (node && BookmarkFolder.is(node)) {
      const nested = findLeafReferenceLocationInSection(asMutableSection(node.children), target);
      if (nested) return nested;
    }
  }
  return undefined;
};

const findLeafReferenceLocation = (
  tree: BookmarkTree,
  target: BookmarkLeaf,
): { readonly children: MutableBookmarkSection; readonly index: number } | undefined => {
  for (const sectionKey of sectionKeys) {
    const section = asMutableTree(tree)[sectionKey];
    if (!section) continue;
    const location = findLeafReferenceLocationInSection(section, target);
    if (location) return location;
  }
  return undefined;
};

const extractLeafReference = (
  tree: BookmarkTree,
  target: BookmarkLeaf,
): BookmarkLeaf | undefined => {
  const location = findLeafReferenceLocation(tree, target);
  if (!location) return undefined;
  const [removed] = location.children.splice(location.index, 1);
  cleanupEmptyRootSections(tree);
  return removed && BookmarkLeaf.is(removed) ? removed : undefined;
};

/** Apply a single patch to the structural working tree via exhaustive Patch.$match. */
const applyOne = (
  tree: BookmarkTree,
  patch: Patch.BookmarkPatch,
  source: BookmarkLeaf | undefined,
): BookmarkTree =>
  Patch.$match(patch, {
    Add: ({ url, name, path }) => {
      const parsed = parseBookmarkPath(path);
      if (!parsed) return tree;

      const parent = ensureFolderPath(ensureSection(tree, parsed.sectionKey), parsed.folderPath);
      parent.push(BookmarkLeaf.make({ name, url }));

      return tree;
    },

    Remove: () => {
      if (source) extractLeafReference(tree, source);
      return tree;
    },

    Update: ({ url, newName, fromPath, toPath }) => {
      if (!source) return tree;
      if (fromPath === toPath) {
        const location = findLeafReferenceLocation(tree, source);
        if (location) {
          location.children[location.index] = BookmarkLeaf.make({ name: newName, url });
        }
        return tree;
      }

      const removed = extractLeafReference(tree, source);
      if (!removed) return tree;

      const parsed = parseBookmarkPath(toPath);
      if (!parsed) return tree;

      const parent = ensureFolderPath(ensureSection(tree, parsed.sectionKey), parsed.folderPath);
      parent.push(BookmarkLeaf.make({ name: newName, url }));

      return tree;
    },
  });

export interface SyncConfig {
  readonly yamlPath: string;
  readonly dryRun?: boolean;
  readonly requestedTargets?: readonly string[];
  /** Max age for graveyard entries before GC removes them. Default: 90 days. */
  readonly graveyardMaxAge?: Duration.Duration;
  /** Optional YAML config override for one-way workflows such as `pull`. */
  readonly yamlOverride?: BookmarksConfig;
}

export interface BackupConfig {
  readonly yamlPath: string;
  readonly backupDir: string;
  readonly yamlOverride?: BookmarksConfig;
}

const emptyConfig = (): BookmarksConfig =>
  BookmarksConfig.make({
    all: BookmarkTree.make({}),
  });

const loadConfig = (config: SyncConfig): Effect.Effect<BookmarksConfig, Error> =>
  config.yamlOverride
    ? Effect.succeed(config.yamlOverride)
    : Effect.gen(function* () {
        const exists = yield* fileExists(config.yamlPath);
        if (!exists) return emptyConfig();

        return yield* YamlModule.load(config.yamlPath);
      });

const validateConfiguredChromeProfiles = (
  config: BookmarksConfig,
  discoveredTargets: readonly Targets.TargetDescriptor[],
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const discoveredChromeProfiles = new Set(
      discoveredTargets.filter(hasChromeProfile).map((target) => `chrome/${target.profile}`),
    );

    for (const configuredProfile of YamlModule.configuredChromeProfiles(config)) {
      if (discoveredChromeProfiles.has(`chrome/${configuredProfile}`)) continue;
      return yield* Effect.fail(
        new Error(
          `Configured Chrome profile "${configuredProfile}" was not discovered on this machine.`,
        ),
      );
    }
  });

interface TargetResolution {
  readonly discoveredTargets: readonly Targets.TargetDescriptor[];
  readonly selectedTargets: readonly Targets.TargetDescriptor[];
}

const resolveSelectedTargets = (
  config: BookmarksConfig,
  requestedTargets: readonly string[] = [],
): Effect.Effect<TargetResolution, Error> =>
  Effect.gen(function* () {
    const discoveredTargets = yield* Targets.discoverTargets();
    yield* validateConfiguredChromeProfiles(config, discoveredTargets);
    const resolvedTargets = yield* Targets.resolveTargetSelectors(
      discoveredTargets,
      requestedTargets,
    );
    const explicitlyRequestedDisabled = resolvedTargets.filter(
      (target) =>
        requestedTargets.length > 0 &&
        !YamlModule.isTargetEnabled(config, resolvedTargetOf(target)),
    );
    if (explicitlyRequestedDisabled.length > 0) {
      return yield* Effect.fail(
        new Error(
          `Requested target(s) are disabled: ${explicitlyRequestedDisabled.map(Targets.keyOf).join(", ")}.`,
        ),
      );
    }
    return {
      discoveredTargets,
      selectedTargets: resolvedTargets.filter((target) =>
        YamlModule.isTargetEnabled(config, resolvedTargetOf(target)),
      ),
    };
  });

const emptySyncResult = (orchestration?: Orchestration.SyncNotice): SyncResult =>
  orchestration
    ? {
        applied: [],
        graveyarded: [],
        targets: [],
        orchestration,
      }
    : {
        applied: [],
        graveyarded: [],
        targets: [],
      };

const runningTargetBrowsers = (
  targets: readonly Targets.TargetDescriptor[],
): Effect.Effect<readonly string[], Error> =>
  Effect.gen(function* () {
    let checkedBrowsers = HashSet.empty<string>();
    const runningBrowsers: string[] = [];

    for (const target of targets) {
      if (target.browser === "chrome" && (yield* ChromeNative.isPaired(target.path))) continue;
      const browser = Targets.processNameOf(target.browser);
      if (HashSet.has(checkedBrowsers, browser)) continue;
      checkedBrowsers = HashSet.add(checkedBrowsers, browser);

      if (yield* Permissions.checkBrowserRunning(browser)) {
        runningBrowsers.push(browser);
      }
    }

    return runningBrowsers;
  });

const browserRunningNotice = (
  operation: Orchestration.SyncOperation,
  browsers: readonly string[],
): Orchestration.SyncNotice => ({
  state: "busy",
  operation,
  message: browsers
    .map((browser) => new Permissions.BrowserRunning({ browser }).message)
    .join("\n\n"),
});

const ensurePermanentMutationSafety = (
  yamlConfig: BookmarksConfig,
  targets: readonly Targets.TargetDescriptor[],
  operation: Orchestration.SyncOperation,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (targets.some((target) => Targets.requiresFullDiskAccess(target))) {
      yield* Permissions.requireFullDiskAccess();
    }

    for (const target of targets) {
      yield* Permissions.requireTargetAvailable(Targets.displayNameOf(target), target.path);
    }

    for (const target of targets) {
      const yamlTree = yield* YamlModule.resolveTarget(yamlConfig, resolvedTargetOf(target));
      yield* ensureUnambiguousPaths(yamlTree, `yaml target ${Targets.displayNameOf(target)}`);
      const browserTree = yield* Targets.readTree(target);
      if (operation !== "push") {
        yield* ensureUnambiguousPaths(browserTree, `${Targets.displayNameOf(target)} target`);
      }
    }
  });

const createMutationBackup = (
  config: SyncConfig,
  yamlConfig: BookmarksConfig,
): Effect.Effect<BackupResult, Error> =>
  backup({
    yamlPath: config.yamlPath,
    backupDir: Paths.defaultBackupDir(),
    yamlOverride: yamlConfig,
  });

const runManagedOperation = (
  requestedOperation: Orchestration.SyncOperation,
  config: SyncConfig,
): Effect.Effect<SyncResult, Error> =>
  Orchestration.withOrchestratedSync(config.yamlPath, requestedOperation, (operation) =>
    Effect.gen(function* () {
      const yamlConfig = yield* loadConfig(config);
      const { selectedTargets } = yield* resolveSelectedTargets(
        yamlConfig,
        config.requestedTargets,
      );
      if (operation !== "pull") {
        const runningBrowsers = yield* runningTargetBrowsers(selectedTargets);
        if (runningBrowsers.length > 0) {
          return emptySyncResult(browserRunningNotice(operation, runningBrowsers));
        }
      }
      yield* ensurePermanentMutationSafety(yamlConfig, selectedTargets, operation);
      const nextConfig = { ...config, yamlOverride: yamlConfig };
      if (operation !== "pull") {
        const previewConfig = { ...nextConfig, dryRun: true };
        const preview =
          operation === "push"
            ? yield* runPush(previewConfig)
            : operation === "gc"
              ? yield* runGc(previewConfig)
              : yield* runSync(previewConfig);

        for (const targetResult of preview.targets) {
          const wouldMutate =
            targetResult.writeMode === "rewrite" || targetResult.applied.length > 0;
          if (
            wouldMutate &&
            targetResult.target.browser === "chrome" &&
            !(yield* ChromeNative.isPaired(targetResult.target.path))
          ) {
            yield* Chrome.ensureDirectMutationSafe(targetResult.target.path);
          }
        }
      }
      const mutationBackup = yield* createMutationBackup(config, yamlConfig);

      switch (operation) {
        case "pull":
          return {
            ...(yield* runPull(nextConfig)),
            backup: mutationBackup,
          };
        case "push":
          return {
            ...(yield* runPush(nextConfig)),
            backup: mutationBackup,
          };
        case "gc":
          return {
            ...(yield* runGc(nextConfig)),
            backup: mutationBackup,
          };
        case "sync":
          return {
            ...(yield* runSync(nextConfig)),
            backup: mutationBackup,
          };
      }
    }),
  ).pipe(
    Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))),
    Effect.map((outcome) =>
      outcome._tag === "completed" ? outcome.value : emptySyncResult(outcome.notice),
    ),
  );

const nodesEqual = (left: BookmarkNode, right: BookmarkNode): boolean => {
  if (BookmarkLeaf.is(left) && BookmarkLeaf.is(right)) {
    return left.name === right.name && left.url === right.url;
  }

  if (BookmarkFolder.is(left) && BookmarkFolder.is(right)) {
    return left.name === right.name && sectionsEqual(left.children, right.children);
  }

  return false;
};

const sectionsEqual = (
  left: BookmarkSection | undefined,
  right: BookmarkSection | undefined,
): boolean => {
  const normalizedLeft = normalizeSection(left) ?? [];
  const normalizedRight = normalizeSection(right) ?? [];

  if (normalizedLeft.length !== normalizedRight.length) return false;

  for (let index = 0; index < normalizedLeft.length; index++) {
    const leftNode = normalizedLeft[index];
    const rightNode = normalizedRight[index];
    if (!leftNode || !rightNode || !nodesEqual(leftNode, rightNode)) return false;
  }

  return true;
};

const longestCommonPrefix = (
  sections: readonly (BookmarkSection | undefined)[],
): BookmarkSection | undefined => {
  const normalizedSections = sections.map((section) => normalizeSection(section) ?? []);
  const firstSection = normalizedSections[0] ?? [];
  const prefixLength = Math.min(...normalizedSections.map((section) => section.length));
  const prefix: BookmarkNode[] = [];

  for (let index = 0; index < prefixLength; index++) {
    const candidate = firstSection[index];
    if (!candidate) break;
    if (
      !normalizedSections.every((section) => {
        const sectionNode = section[index];
        return sectionNode !== undefined && nodesEqual(sectionNode, candidate);
      })
    )
      break;
    prefix.push(cloneNode(candidate));
  }

  return prefix.length > 0 ? prefix : undefined;
};

const sectionSuffix = (
  section: BookmarkSection | undefined,
  prefixLength: number,
): BookmarkSection | undefined => {
  const normalized = normalizeSection(section) ?? [];
  const suffix = normalized.slice(prefixLength).map((node) => cloneNode(node));
  return suffix.length > 0 ? suffix : undefined;
};

const isTreeEmpty = (tree: BookmarkTree): boolean =>
  (tree.bar?.length ?? 0) === 0 &&
  (tree.menu?.length ?? 0) === 0 &&
  (tree.reading_list?.length ?? 0) === 0 &&
  (tree.mobile?.length ?? 0) === 0;

const treeEquals = (left: BookmarkTree, right: BookmarkTree): boolean =>
  sectionKeys.every((sectionKey) => sectionsEqual(left[sectionKey], right[sectionKey]));

const verifyTargetWrite = (
  target: Targets.TargetDescriptor,
  expectedTree: BookmarkTree,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const readBack = yield* Targets.readTree(target);
    if (!treeEquals(readBack, expectedTree)) {
      return yield* Effect.fail(
        new Error(`Post-write verification failed for ${Targets.displayNameOf(target)}`),
      );
    }
  });

const treeFromSections = (
  sections: Partial<Record<SectionKey, BookmarkSection | undefined>>,
): BookmarkTree =>
  BookmarkTree.make({
    bar: sections.bar,
    menu: sections.menu,
    reading_list: sections.reading_list,
    mobile: sections.mobile,
  });

const supportedTargetIdsForSection = (
  targetIds: readonly string[],
  sectionKey: SectionKey,
): readonly string[] =>
  targetIds.filter((targetId) =>
    sectionKeysForBrowser(browserOfTargetId(targetId)).includes(sectionKey),
  );

export const decomposeResolvedTrees = (
  currentConfig: BookmarksConfig,
  resolvedTrees: Readonly<Record<string, BookmarkTree>>,
): BookmarksConfig => {
  const targetIds = Object.keys(resolvedTrees);
  if (targetIds.length === 0) return emptyConfig();

  const allSections = recordFromEntries(
    sectionKeys.map((sectionKey) => {
      const supportedTargetIds = supportedTargetIdsForSection(targetIds, sectionKey);
      const prefix =
        supportedTargetIds.length === 0
          ? undefined
          : longestCommonPrefix(
              supportedTargetIds.map((targetId) => targetTree(resolvedTrees, targetId)[sectionKey]),
            );
      return [sectionKey, prefix];
    }),
  );

  const afterAll = recordFromEntries(
    targetIds.map((targetId) => [
      targetId,
      treeFromSections(
        recordFromEntries(
          sectionKeys.map((sectionKey) => {
            const supported = sectionKeysForBrowser(browserOfTargetId(targetId)).includes(
              sectionKey,
            );
            return [
              sectionKey,
              supported
                ? sectionSuffix(
                    targetTree(resolvedTrees, targetId)[sectionKey],
                    allSections[sectionKey]?.length ?? 0,
                  )
                : undefined,
            ];
          }),
        ),
      ),
    ]),
  );

  const chromeTargetIds = targetIds.filter((targetId) => browserOfTargetId(targetId) === "chrome");
  const chromeSections = recordFromEntries(
    sectionKeys.map((sectionKey) => {
      const supported = sectionKeysForBrowser("chrome").includes(sectionKey);
      const prefix =
        !supported || chromeTargetIds.length === 0
          ? undefined
          : longestCommonPrefix(
              chromeTargetIds.map((targetId) => targetTree(afterAll, targetId)[sectionKey]),
            );
      return [sectionKey, prefix];
    }),
  );

  const safariOverlay = afterAll["safari"]
    ? treeFromSections({
        bar: afterAll["safari"].bar,
        menu: afterAll["safari"].menu,
        reading_list: afterAll["safari"].reading_list,
      })
    : emptyTree();

  const chromeOverlay = treeFromSections({
    bar: chromeSections.bar,
    menu: chromeSections.menu,
    mobile: chromeSections.mobile,
  });

  const profileNames = new Set([
    ...chromeTargetIds
      .filter((targetId) => profileOfTargetId(targetId) !== undefined)
      .map((targetId) =>
        expectDefined(profileOfTargetId(targetId), `Missing Chrome profile for ${targetId}`),
      ),
    ...Object.keys(currentConfig.chrome?.profiles ?? {}),
  ]);

  const chromeProfiles = Object.fromEntries(
    [...profileNames].sort().flatMap((profile): readonly [string, ChromeProfileBookmarks][] => {
      const targetId = `chrome/${profile}`;
      const overlayTree =
        targetId in afterAll
          ? treeFromSections({
              bar: sectionSuffix(
                targetTree(afterAll, targetId).bar,
                chromeSections.bar?.length ?? 0,
              ),
              menu: sectionSuffix(
                targetTree(afterAll, targetId).menu,
                chromeSections.menu?.length ?? 0,
              ),
              mobile: sectionSuffix(
                targetTree(afterAll, targetId).mobile,
                chromeSections.mobile?.length ?? 0,
              ),
            })
          : emptyTree();
      const existingProfile = currentConfig.chrome?.profiles?.[profile];
      if (!existingProfile && isTreeEmpty(overlayTree)) return [];
      return [
        [
          profile,
          ChromeProfileBookmarks.make({
            ...(existingProfile?.enabled !== undefined ? { enabled: existingProfile.enabled } : {}),
            bar: overlayTree.bar,
            menu: overlayTree.menu,
            mobile: overlayTree.mobile,
          }),
        ],
      ];
    }),
  );

  const nextConfig = BookmarksConfig.make({
    version: 2,
    all: treeFromSections(allSections),
    ...(currentConfig.safari || !isTreeEmpty(safariOverlay)
      ? {
          safari: SafariBookmarks.make({
            ...(currentConfig.safari?.enabled !== undefined
              ? { enabled: currentConfig.safari.enabled }
              : {}),
            bar: safariOverlay.bar,
            menu: safariOverlay.menu,
            reading_list: safariOverlay.reading_list,
          }),
        }
      : {}),
    ...(currentConfig.chrome ||
    !isTreeEmpty(chromeOverlay) ||
    Object.keys(chromeProfiles).length > 0
      ? {
          chrome: ChromeBookmarks.make({
            ...(currentConfig.chrome?.enabled !== undefined
              ? { enabled: currentConfig.chrome.enabled }
              : {}),
            bar: chromeOverlay.bar,
            menu: chromeOverlay.menu,
            mobile: chromeOverlay.mobile,
            ...(Object.keys(chromeProfiles).length > 0 ? { profiles: chromeProfiles } : {}),
          }),
        }
      : {}),
  });

  return nextConfig;
};

const saveConfig = (yamlPath: string, config: BookmarksConfig): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* Effect.log("Saving bookmarks.yaml...");
    yield* YamlModule.save(yamlPath, config);
    yield* Effect.log("Auto-committing bookmarks.yaml...");
    yield* gitAutoCommit(yamlPath);
    yield* advanceSyncBaseline(yamlPath, config);
  });

const resolveTargetTrees = (
  config: BookmarksConfig,
  targetIds: readonly string[],
): Effect.Effect<Record<string, BookmarkTree>, Error> =>
  Effect.gen(function* () {
    const trees: Record<string, BookmarkTree> = {};
    for (const targetId of targetIds) {
      trees[targetId] = yield* YamlModule.resolveTarget(config, resolvedTargetOfId(targetId));
    }
    return trees;
  });

const projectTree = (
  fromTree: BookmarkTree,
  toTree: BookmarkTree,
  toSource: string,
  fromSource = "existing state",
): Effect.Effect<
  {
    readonly exact: boolean;
    readonly patches: readonly Patch.BookmarkPatch[];
    readonly projectedTree: BookmarkTree;
  },
  Error
> =>
  Effect.gen(function* () {
    const patches = yield* Patch.generatePatches(fromTree, toTree, toSource, undefined, fromSource);
    const projectedTree = yield* applyPatches(fromTree, patches);
    return {
      exact: treeEquals(projectedTree, toTree),
      patches,
      projectedTree,
    };
  });

interface PlannedTargetSync {
  readonly target: Targets.TargetDescriptor;
  readonly tree: BookmarkTree;
  readonly expectedTree: BookmarkTree;
  readonly result: TargetResult;
  readonly writePatches: readonly Patch.BookmarkPatch[];
}

const planSyncTarget = (
  target: Targets.TargetDescriptor,
  originalBaselineTree: BookmarkTree,
  originalYamlTree: BookmarkTree,
  maxAge: Duration.Duration,
): Effect.Effect<PlannedTargetSync, Error> =>
  Effect.gen(function* () {
    const baselineTree =
      target.browser === "chrome"
        ? yield* ChromeNative.normalizeDesiredTree(target.path, originalBaselineTree)
        : originalBaselineTree;
    const yamlTree =
      target.browser === "chrome"
        ? yield* ChromeNative.normalizeDesiredTree(target.path, originalYamlTree)
        : originalYamlTree;
    const browserTree = yield* Targets.readTree(target);
    yield* ensureUnambiguousPaths(yamlTree, `yaml target ${Targets.displayNameOf(target)}`);
    yield* ensureUnambiguousPaths(browserTree, `${Targets.displayNameOf(target)} target`);
    const yamlPatches = yield* Patch.generatePatches(
      baselineTree,
      yamlTree,
      "yaml",
      undefined,
      "git baseline",
    );
    const browserPatches = yield* Patch.generatePatches(
      baselineTree,
      browserTree,
      target.browser,
      undefined,
      "git baseline",
    );
    const resolution = yield* resolveConflicts(yamlPatches, browserPatches);

    const yamlProjection = yield* projectTree(baselineTree, yamlTree, "yaml", "git baseline");
    const browserProjection = yield* projectTree(
      baselineTree,
      browserTree,
      target.browser,
      "git baseline",
    );
    const mergedLeafTree = yield* applyPatches(baselineTree, resolution.apply);

    const structuralBase =
      !yamlProjection.exact && !browserProjection.exact
        ? treeEquals(yamlTree, browserTree)
          ? yamlTree
          : yield* Effect.fail(
              new Error(
                `Cannot safely merge divergent structural bookmark changes for ${Targets.displayNameOf(target)}. Run pull or align YAML/browser ordering and empty folders before syncing.`,
              ),
            )
        : !yamlProjection.exact
          ? yamlTree
          : !browserProjection.exact
            ? browserTree
            : mergedLeafTree;

    const mergedProjection = yield* projectTree(
      structuralBase,
      mergedLeafTree,
      "merged",
      "resolved structural state",
    );
    const mergedTree = mergedProjection.exact ? mergedProjection.projectedTree : structuralBase;

    const withGraveyard =
      resolution.graveyard.length > 0
        ? yield* Graveyard.addGraveyardEntries(
            mergedTree,
            resolution.graveyard,
            Targets.graveyardSourceOf(target),
            "conflict",
          )
        : mergedTree;
    const finalTree = yield* Graveyard.gc(withGraveyard, maxAge);
    const finalProjection = yield* projectTree(
      browserTree,
      finalTree,
      `${target.browser} target`,
      `${target.browser} target`,
    );
    const adapterRequiresRewrite = yield* Targets.requiresFullRewrite(
      target,
      finalProjection.patches,
    );
    const writeMode =
      finalProjection.exact && !adapterRequiresRewrite
        ? ("patches" as const)
        : ("rewrite" as const);

    return {
      target,
      tree: finalTree,
      expectedTree: browserTree,
      result: {
        target,
        applied: finalProjection.patches,
        graveyarded: resolution.graveyard,
        writeMode,
      },
      writePatches: finalProjection.patches,
    };
  });

const pullTarget = (
  target: Targets.TargetDescriptor,
  currentTree: BookmarkTree,
): Effect.Effect<
  {
    readonly target: Targets.TargetDescriptor;
    readonly tree: BookmarkTree;
    readonly result: TargetResult;
  },
  Error
> =>
  Effect.gen(function* () {
    const browserTree = yield* Targets.readTree(target);
    const pulledPatches = yield* Patch.generatePatches(
      currentTree,
      browserTree,
      target.browser,
      undefined,
      "yaml",
    );
    return {
      target,
      tree: browserTree,
      result: {
        target,
        applied: pulledPatches,
        graveyarded: [],
      },
    };
  });

const pushTarget = (
  target: Targets.TargetDescriptor,
  originalYamlTree: BookmarkTree,
  dryRun: boolean,
): Effect.Effect<TargetResult, Error> =>
  Effect.gen(function* () {
    const yamlTree =
      target.browser === "chrome"
        ? yield* ChromeNative.normalizeDesiredTree(target.path, originalYamlTree)
        : originalYamlTree;
    const browserTree = yield* Targets.readTree(target);
    yield* ensureUnambiguousPaths(yamlTree, `yaml target ${Targets.displayNameOf(target)}`);
    const sourceIsAmbiguous = collectAmbiguousPathIssues(browserTree).length > 0;
    const finalProjection = sourceIsAmbiguous
      ? undefined
      : yield* projectTree(browserTree, yamlTree, "yaml", `${target.browser} target`);
    const writePatches = finalProjection?.patches ?? [];
    const adapterRequiresRewrite = finalProjection
      ? yield* Targets.requiresFullRewrite(target, writePatches)
      : true;
    const writeMode =
      finalProjection?.exact && !adapterRequiresRewrite
        ? ("patches" as const)
        : ("rewrite" as const);

    if (!dryRun) {
      if (writeMode === "rewrite") {
        yield* Targets.writeTree(target, yamlTree, browserTree);
      } else {
        yield* Targets.applyPatches(target, writePatches);
      }
      yield* verifyTargetWrite(target, yamlTree);
    }

    return {
      target,
      applied: writePatches,
      graveyarded: [],
      writeMode,
    };
  });

const gcTree = (
  currentTree: BookmarkTree,
  maxAge: Duration.Duration,
): Effect.Effect<BookmarkTree, Error> => Graveyard.gc(currentTree, maxAge);

/**
 * Run a full bidirectional sync.
 *
 * The sync baseline comes from git when bookmarks.yaml is tracked. Outside git
 * we persist a managed baseline in state storage so three-way sync remains
 * incremental across runs.
 *
 * Fresh sync (no baseline yet): baseline is empty tree,
 * every Safari bookmark becomes an Add patch, YAML is populated from scratch.
 *
 * Incremental sync: three-way diff between committed YAML (baseline),
 * current YAML on disk (user edits), and current Safari (browser changes).
 * Newest-wins conflict resolution, YAML tie-break.
 */
const runSync = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  Effect.gen(function* () {
    const yamlConfig = yield* loadConfig(config);
    const baselineConfig = (yield* readSyncBaselineConfig(config.yamlPath)) ?? emptyConfig();
    const maxAge = config.graveyardMaxAge ?? Duration.days(90);
    const targetResults: TargetResult[] = [];
    const { discoveredTargets, selectedTargets } = yield* resolveSelectedTargets(
      yamlConfig,
      config.requestedTargets,
    );
    const resolvedTrees = yield* resolveTargetTrees(
      yamlConfig,
      discoveredTargets.map(Targets.keyOf),
    );
    const plannedTargetSyncs: PlannedTargetSync[] = [];

    for (const target of selectedTargets) {
      yield* Effect.log(`Syncing ${Targets.displayNameOf(target)}...`);
      const baselineTree = yield* YamlModule.resolveTarget(
        baselineConfig,
        resolvedTargetOf(target),
      );
      const yamlTree = resolvedTrees[Targets.keyOf(target)] ?? emptyTree();
      const targetSync = yield* planSyncTarget(target, baselineTree, yamlTree, maxAge);
      resolvedTrees[Targets.keyOf(target)] = targetSync.tree;
      plannedTargetSyncs.push(targetSync);
      targetResults.push(targetSync.result);
    }

    const nextConfig = decomposeResolvedTrees(yamlConfig, resolvedTrees);
    if (!config.dryRun) {
      for (const targetSync of plannedTargetSyncs) {
        if ((targetSync.result.writeMode ?? "patches") === "rewrite") {
          yield* Targets.writeTree(targetSync.target, targetSync.tree, targetSync.expectedTree);
        } else {
          yield* Targets.applyPatches(targetSync.target, targetSync.writePatches);
        }
        yield* verifyTargetWrite(targetSync.target, targetSync.tree);
      }
      yield* saveConfig(config.yamlPath, nextConfig);
    }

    return {
      applied: targetResults.flatMap((result) => result.applied),
      graveyarded: targetResults.flatMap((result) => result.graveyarded),
      targets: targetResults,
    };
  });

const runPull = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  Effect.gen(function* () {
    const yamlConfig = yield* loadConfig(config);
    const targetResults: TargetResult[] = [];
    const { discoveredTargets, selectedTargets } = yield* resolveSelectedTargets(
      yamlConfig,
      config.requestedTargets,
    );
    const resolvedTrees = yield* resolveTargetTrees(
      yamlConfig,
      discoveredTargets.map(Targets.keyOf),
    );

    for (const target of selectedTargets) {
      yield* Effect.log(`Pulling ${Targets.displayNameOf(target)}...`);
      const targetPull = yield* pullTarget(
        target,
        resolvedTrees[Targets.keyOf(target)] ?? emptyTree(),
      );
      resolvedTrees[Targets.keyOf(target)] = targetPull.tree;
      targetResults.push(targetPull.result);
    }

    const nextConfig = decomposeResolvedTrees(yamlConfig, resolvedTrees);
    if (!config.dryRun) {
      yield* saveConfig(config.yamlPath, nextConfig);
    }

    return {
      applied: targetResults.flatMap((result) => result.applied),
      graveyarded: [],
      targets: targetResults,
    };
  });

const runPush = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  Effect.gen(function* () {
    const yamlConfig = yield* loadConfig(config);
    const targetResults: TargetResult[] = [];
    const { selectedTargets } = yield* resolveSelectedTargets(yamlConfig, config.requestedTargets);

    for (const target of selectedTargets) {
      yield* Effect.log(`Pushing ${Targets.displayNameOf(target)}...`);
      const yamlTree = yield* YamlModule.resolveTarget(yamlConfig, resolvedTargetOf(target));
      targetResults.push(yield* pushTarget(target, yamlTree, config.dryRun ?? false));
    }

    if (!config.dryRun) {
      yield* advanceSyncBaseline(config.yamlPath, yamlConfig);
    }

    return {
      applied: targetResults.flatMap((result) => result.applied),
      graveyarded: [],
      targets: targetResults,
    };
  });

export const sync = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  config.dryRun ? runSync(config) : runManagedOperation("sync", config);

export const pull = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  config.dryRun ? runPull(config) : runManagedOperation("pull", config);

export const push = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  config.dryRun ? runPush(config) : runManagedOperation("push", config);

export const status = (config: SyncConfig): Effect.Effect<StatusResult, Error> =>
  Effect.gen(function* () {
    const yamlConfig = yield* loadConfig(config);
    const targetStatuses: StatusTargetResult[] = [];
    const { selectedTargets } = yield* resolveSelectedTargets(yamlConfig, config.requestedTargets);

    for (const target of selectedTargets) {
      const resolvedTree = yield* YamlModule.resolveTarget(yamlConfig, resolvedTargetOf(target));
      const yamlTree =
        target.browser === "chrome"
          ? yield* ChromeNative.normalizeDesiredTree(target.path, resolvedTree)
          : resolvedTree;
      const browserTree = yield* Targets.readTree(target);
      targetStatuses.push({
        target,
        yamlDuplicates: Patch.countDuplicates(yamlTree),
        browserDuplicates: Patch.countDuplicates(browserTree),
        yamlPatches: yield* Patch.generatePatches(
          browserTree,
          yamlTree,
          "yaml",
          undefined,
          `${target.browser} target`,
        ),
        browserPatches: yield* Patch.generatePatches(
          yamlTree,
          browserTree,
          target.browser,
          undefined,
          "yaml",
        ),
      });
    }

    return {
      yamlPath: config.yamlPath,
      targets: targetStatuses,
    };
  });

export const backup = (config: BackupConfig): Effect.Effect<BackupResult, Error> =>
  Effect.gen(function* () {
    const yamlConfig = yield* loadConfig(
      config.yamlOverride
        ? { yamlPath: config.yamlPath, yamlOverride: config.yamlOverride }
        : { yamlPath: config.yamlPath },
    );
    const { selectedTargets } = yield* resolveSelectedTargets(yamlConfig, []);
    const backupDir = config.backupDir;
    const timestamp = DateTime.formatIso(DateTime.unsafeNow())
      .replaceAll(":", "-")
      .replaceAll(".", "-");
    const files: string[] = [];
    const skipped: string[] = [];

    yield* ManagedPaths.ensureDir(backupDir);

    const candidates = [
      { label: "yaml", path: config.yamlPath, filename: `${timestamp}--bookmarks.yaml` },
      ...selectedTargets.map((target) => ({
        label: Targets.displayNameOf(target),
        path: target.path,
        filename: `${timestamp}--${Targets.displayNameOf(target).replaceAll("/", "--")}--${Path.basename(target.path)}`,
      })),
    ];

    for (const candidate of candidates) {
      const destination = Path.join(backupDir, candidate.filename);
      const exists = yield* Effect.tryPromise({
        try: async () => {
          try {
            await Fs.access(candidate.path);
            return true;
          } catch {
            return false;
          }
        },
        catch: (error) =>
          new Error(
            `Failed to inspect backup candidate ${candidate.path}: ${messageFromUnknown(error)}`,
          ),
      });

      if (!exists) {
        skipped.push(candidate.label);
        continue;
      }

      yield* Effect.tryPromise({
        try: () => Fs.copyFile(candidate.path, destination),
        catch: (error) =>
          new Error(`Failed to back up ${candidate.path}: ${messageFromUnknown(error)}`),
      });
      files.push(destination);
    }

    // Chrome may not yet have flushed its live model to the disk file above.
    for (const target of selectedTargets) {
      if (target.browser !== "chrome" || !(yield* ChromeNative.isPaired(target.path))) continue;
      const tree = yield* ChromeNative.readTree(target.path);
      const destination = Path.join(
        backupDir,
        `${timestamp}--${Targets.displayNameOf(target).replaceAll("/", "--")}--live-tree.json`,
      );
      yield* Effect.tryPromise({
        try: () => Fs.writeFile(destination, JSON.stringify(tree, null, 2), { mode: 0o600 }),
        catch: (error) =>
          new Error(`Failed to back up live Chrome bookmarks: ${messageFromUnknown(error)}`),
      });
      files.push(destination);
    }

    return { backupDir, files, skipped };
  });

const runGc = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  Effect.gen(function* () {
    const yamlConfig = yield* loadConfig(config);
    const maxAge = config.graveyardMaxAge ?? Duration.days(90);
    const targetResults: TargetResult[] = [];
    const { discoveredTargets, selectedTargets } = yield* resolveSelectedTargets(
      yamlConfig,
      config.requestedTargets,
    );
    const currentResolvedTrees = yield* resolveTargetTrees(
      yamlConfig,
      discoveredTargets.map(Targets.keyOf),
    );
    const cleanedResolvedTrees: Record<string, BookmarkTree> = {};

    for (const targetId of Object.keys(currentResolvedTrees)) {
      cleanedResolvedTrees[targetId] = yield* gcTree(
        targetTree(currentResolvedTrees, targetId),
        maxAge,
      );
    }

    for (const target of selectedTargets) {
      const cleanedTree = cleanedResolvedTrees[Targets.keyOf(target)] ?? emptyTree();
      targetResults.push(yield* pushTarget(target, cleanedTree, config.dryRun ?? false));
    }

    const nextConfig = decomposeResolvedTrees(yamlConfig, cleanedResolvedTrees);
    if (!config.dryRun) {
      yield* saveConfig(config.yamlPath, nextConfig);
    }

    return {
      applied: targetResults.flatMap((result) => result.applied),
      graveyarded: [],
      targets: targetResults,
    };
  });

export const gc = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  config.dryRun ? runGc(config) : runManagedOperation("gc", config);
