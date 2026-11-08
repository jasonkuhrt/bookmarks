/**
 * Core sync engine.
 *
 * Each target (Safari, a Chrome profile) is merged three ways: its baseline (the tree it held
 * after its last sync), its tree as bookmarks.yaml resolves it, and its tree in the browser.
 * Targets merge one after another, each absorbing its result into the YAML's layers, so an
 * edit in one browser reaches the YAML before the next target merges. The final YAML is then
 * written to every browser, and each target's baseline becomes what it now holds. Conflict
 * losers go to the graveyard. Git keeps the YAML's history only; it is never the baseline.
 */

import { Array as Arr, DateTime, Duration, Effect, HashSet } from "effect";
import { execFile } from "node:child_process";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Baseline from "./baseline.ts";
import * as ManagedPaths from "./managed-paths.ts";
import * as Paths from "./paths.ts";
import * as Chrome from "./chrome.ts";
import * as ChromeNative from "./chrome-native.ts";
import * as Graveyard from "./graveyard.ts";
import * as Layers from "./layers.ts";
import { stripManagedConfigHeader } from "./managed-config-header.ts";
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
  /** Whether the sync changed bookmarks.yaml (or would, in a dry run). */
  readonly yamlChanged?: boolean;
  /** Targets whose browser was open, so their changes wait until it closes. */
  readonly waiting?: readonly WaitingTarget[];
}

export interface WaitingTarget {
  readonly target: Targets.TargetDescriptor;
  /** The process that must quit before this target can be written. */
  readonly browser: string;
  readonly pending: number;
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

// -- Git history --

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

/** Commit bookmarks.yaml after a sync changes it, so its git log records every sync. */
export const gitAutoCommit = (yamlPath: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const resolvedGitTarget = yield* resolveGitTarget(yamlPath);
    if (!resolvedGitTarget) {
      yield* Effect.log("Skipping auto-commit because bookmarks.yaml is not inside a git repo");
      return;
    }
    const { repoRoot, relPath } = resolvedGitTarget;

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

    yield* Effect.log("Auto-committed bookmarks.yaml");
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

type MutableBookmarkSection = BookmarkNode[];
type MutableBookmarkTree = Record<Layers.SectionKey, MutableBookmarkSection | undefined>;

const sectionKeys = Layers.sectionKeys;

const emptyTree = (): BookmarkTree => BookmarkTree.make({});

const resolvedTargetOf = (
  target: Pick<Targets.TargetDescriptor, "browser" | "profile">,
): { readonly browser: string; readonly profile?: string } =>
  target.profile
    ? { browser: target.browser, profile: target.profile }
    : { browser: target.browser };

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
  sectionKey: Layers.SectionKey,
  nodes: MutableBookmarkSection | undefined,
): void => {
  asMutableTree(tree)[sectionKey] = nodes;
};

const ensureSection = (
  tree: BookmarkTree,
  sectionKey: Layers.SectionKey,
): MutableBookmarkSection => {
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
):
  | { readonly sectionKey: Layers.SectionKey; readonly folderPath: readonly string[] }
  | undefined => {
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
  /** Optional YAML config override, used to plan and run from one loaded config. */
  readonly yamlOverride?: BookmarksConfig;
  /**
   * Target keys whose browser is open and holds its own bookmark file: they are read and
   * merged into the YAML, but not written. Their changes wait until the browser closes.
   */
  readonly readOnlyTargets?: ReadonlyMap<string, string>;
  /** bookmarks.yaml's text, without the managed header, when its config was loaded. */
  readonly yamlTextAtLoad?: string | undefined;
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

/** bookmarks.yaml without the daemon's header line, or undefined when there is no file. */
const readYamlBody = (yamlPath: string): Effect.Effect<string | undefined, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return stripManagedConfigHeader(await Fs.readFile(yamlPath, "utf-8"));
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to read ${yamlPath}: ${messageFromUnknown(error)}`),
  });

/**
 * Refuse to write when bookmarks.yaml changed after the sync loaded it: saving would drop that
 * edit. The edit itself queues the next sync, which merges it.
 */
const ensureYamlUnchanged = (
  yamlPath: string,
  textAtLoad: string | undefined,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if ((yield* readYamlBody(yamlPath)) === textAtLoad) return;
    return yield* Effect.fail(
      new Error(
        "bookmarks.yaml changed while the sync ran, so the sync stopped before writing. The next sync merges the edit.",
      ),
    );
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

/**
 * Selected targets whose browser is running and owns the bookmark file, keyed by target with
 * the browser's process name. Paired Chrome is written through its live API, so it never is.
 */
const runningFileTargets = (
  targets: readonly Targets.TargetDescriptor[],
): Effect.Effect<ReadonlyMap<string, string>, Error> =>
  Effect.gen(function* () {
    const running = new Map<string, string>();
    const checked = new Map<string, boolean>();

    for (const target of targets) {
      if (target.browser === "chrome" && (yield* ChromeNative.isPaired(target.path))) continue;
      const browser = Targets.processNameOf(target.browser);
      const isRunning = checked.get(browser) ?? (yield* Permissions.checkBrowserRunning(browser));
      checked.set(browser, isRunning);
      if (isRunning) running.set(Targets.keyOf(target), browser);
    }

    return running;
  });

const browserRunningNotice = (
  operation: Orchestration.SyncOperation,
  browsers: readonly string[],
): Orchestration.SyncNotice => ({
  state: "busy",
  operation,
  message: [...new Set(browsers)]
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

const writesBrowser = (result: TargetResult): boolean =>
  result.writeMode === "rewrite" || result.applied.length > 0;

const runManagedOperation = (
  requestedOperation: Orchestration.SyncOperation,
  config: SyncConfig,
): Effect.Effect<SyncResult, Error> =>
  Orchestration.withOrchestratedSync(config.yamlPath, requestedOperation, (operation) =>
    Effect.gen(function* () {
      const yamlTextAtLoad = yield* readYamlBody(config.yamlPath);
      const yamlConfig = yield* loadConfig(config);
      const { selectedTargets } = yield* resolveSelectedTargets(
        yamlConfig,
        config.requestedTargets,
      );
      const running = yield* runningFileTargets(selectedTargets);
      // A merge reads an open browser and leaves its writes for later; a one-way write can't.
      if (operation !== "sync" && running.size > 0) {
        return emptySyncResult(browserRunningNotice(operation, [...running.values()]));
      }
      yield* ensurePermanentMutationSafety(yamlConfig, selectedTargets, operation);
      const nextConfig = {
        ...config,
        yamlOverride: yamlConfig,
        readOnlyTargets: running,
        yamlTextAtLoad,
      };
      const previewConfig = { ...nextConfig, dryRun: true };
      const preview =
        operation === "push"
          ? yield* runPush(previewConfig)
          : operation === "gc"
            ? yield* runGc(previewConfig)
            : yield* runSync(previewConfig);

      for (const targetResult of preview.targets) {
        if (
          writesBrowser(targetResult) &&
          !running.has(Targets.keyOf(targetResult.target)) &&
          targetResult.target.browser === "chrome" &&
          !(yield* ChromeNative.isPaired(targetResult.target.path))
        ) {
          yield* Chrome.ensureDirectMutationSafe(targetResult.target.path);
        }
      }

      const mutates =
        preview.yamlChanged === true ||
        preview.targets.some(
          (targetResult) =>
            writesBrowser(targetResult) && !running.has(Targets.keyOf(targetResult.target)),
        );
      // A sync that changes nothing still records baselines, but needs no backup.
      const mutationBackup = mutates ? yield* createMutationBackup(config, yamlConfig) : undefined;
      const withBackup = (result: SyncResult): SyncResult =>
        mutationBackup ? { ...result, backup: mutationBackup } : result;

      switch (operation) {
        case "push":
          return withBackup(yield* runPush(nextConfig));
        case "gc":
          return withBackup(yield* runGc(nextConfig));
        case "sync":
          return withBackup(yield* runSync(nextConfig));
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

const renderConfig = (config: BookmarksConfig): Effect.Effect<string, Error> =>
  YamlModule.render(config);

const saveConfig = (yamlPath: string, config: BookmarksConfig): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* Effect.log("Saving bookmarks.yaml...");
    yield* YamlModule.save(yamlPath, config);
    yield* gitAutoCommit(yamlPath);
  });

const saveBaselines = (
  previous: Baseline.Baselines,
  next: Baseline.Baselines,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if ((yield* Baseline.render(previous)) === (yield* Baseline.render(next))) return;
    yield* Baseline.save(next);
  });

/** The tree a target should hold for a config: Chrome's in the form Chrome stores. */
const desiredTreeFor = (
  config: BookmarksConfig,
  target: Targets.TargetDescriptor,
): Effect.Effect<BookmarkTree, Error> =>
  Effect.gen(function* () {
    const tree = yield* YamlModule.resolveTarget(config, resolvedTargetOf(target));
    return target.browser === "chrome"
      ? yield* ChromeNative.normalizeDesiredTree(target.path, tree)
      : tree;
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

interface TargetMerge {
  readonly target: Targets.TargetDescriptor;
  readonly browserTree: BookmarkTree;
  readonly mergedTree: BookmarkTree;
  readonly graveyarded: readonly Patch.BookmarkPatch[];
}

/** Merge one target three ways: what changed in the YAML and in the browser since its baseline. */
const mergeTarget = (
  target: Targets.TargetDescriptor,
  originalBaselineTree: BookmarkTree,
  originalYamlTree: BookmarkTree,
  maxAge: Duration.Duration,
): Effect.Effect<TargetMerge, Error> =>
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
      "sync baseline",
    );
    const browserPatches = yield* Patch.generatePatches(
      baselineTree,
      browserTree,
      target.browser,
      undefined,
      "sync baseline",
    );
    const resolution = yield* resolveConflicts(yamlPatches, browserPatches);

    const yamlProjection = yield* projectTree(baselineTree, yamlTree, "yaml", "sync baseline");
    const browserProjection = yield* projectTree(
      baselineTree,
      browserTree,
      target.browser,
      "sync baseline",
    );
    const mergedLeafTree = yield* applyPatches(baselineTree, resolution.apply);

    const structuralBase =
      !yamlProjection.exact && !browserProjection.exact
        ? treeEquals(yamlTree, browserTree)
          ? yamlTree
          : yield* Effect.fail(
              new Error(
                `Cannot safely merge divergent structural bookmark changes for ${Targets.displayNameOf(target)}. Align YAML/browser ordering and empty folders before syncing.`,
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
    // The structural side's layout with every resolved bookmark change applied. Falling back to
    // the structural side alone when the projection isn't exact would drop the other side's edits.
    const mergedTree = mergedProjection.projectedTree;

    const withGraveyard =
      resolution.graveyard.length > 0
        ? yield* Graveyard.addGraveyardEntries(
            mergedTree,
            resolution.graveyard,
            Targets.graveyardSourceOf(target),
            "conflict",
          )
        : mergedTree;

    return {
      target,
      browserTree,
      mergedTree: yield* Graveyard.gc(withGraveyard, maxAge),
      graveyarded: resolution.graveyard,
    };
  });

interface PlannedWrite {
  readonly target: Targets.TargetDescriptor;
  readonly browserTree: BookmarkTree;
  readonly desiredTree: BookmarkTree;
  readonly writePatches: readonly Patch.BookmarkPatch[];
  readonly writeMode: "patches" | "rewrite";
}

/** How to bring a browser from what it holds to what it should hold. */
const planWrite = (
  target: Targets.TargetDescriptor,
  browserTree: BookmarkTree,
  desiredTree: BookmarkTree,
): Effect.Effect<PlannedWrite, Error> =>
  Effect.gen(function* () {
    const projection =
      collectAmbiguousPathIssues(browserTree).length > 0
        ? undefined
        : yield* projectTree(browserTree, desiredTree, "yaml", `${target.browser} target`);
    const writePatches = projection?.patches ?? [];
    const adapterRequiresRewrite = projection
      ? yield* Targets.requiresFullRewrite(target, writePatches)
      : true;
    const writeMode =
      projection?.exact && !adapterRequiresRewrite ? ("patches" as const) : ("rewrite" as const);
    return { target, browserTree, desiredTree, writePatches, writeMode };
  });

const plannedWritesBrowser = (plan: PlannedWrite): boolean =>
  plan.writeMode === "rewrite"
    ? !treeEquals(plan.browserTree, plan.desiredTree)
    : plan.writePatches.length > 0;

const executeWrite = (plan: PlannedWrite): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (!plannedWritesBrowser(plan)) return;
    if (plan.writeMode === "rewrite") {
      yield* Targets.writeTree(plan.target, plan.desiredTree, plan.browserTree);
    } else {
      yield* Targets.applyPatches(plan.target, plan.writePatches);
    }
    yield* verifyTargetWrite(plan.target, plan.desiredTree);
  });

const toTargetResult = (
  plan: PlannedWrite,
  graveyarded: readonly Patch.BookmarkPatch[] = [],
): TargetResult => ({
  target: plan.target,
  applied: plan.writePatches,
  graveyarded,
  writeMode: plannedWritesBrowser(plan) ? plan.writeMode : "patches",
});

/**
 * Run a full bidirectional sync.
 *
 * Each selected target merges its YAML and browser edits since its baseline (an empty tree
 * before its first sync, so nothing is deleted), and absorbs the result into the YAML before
 * the next target merges. Then every target is written from the final YAML, except a target
 * whose browser is open: it keeps its writes for later and takes its current tree as its
 * baseline, so its own edits, already in the YAML, are not applied twice.
 */
const runSync = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  Effect.gen(function* () {
    const yamlTextAtLoad =
      "yamlTextAtLoad" in config ? config.yamlTextAtLoad : yield* readYamlBody(config.yamlPath);
    const yamlConfig = yield* loadConfig(config);
    const baselines = yield* Baseline.load();
    const maxAge = config.graveyardMaxAge ?? Duration.days(90);
    const readOnlyTargets = config.readOnlyTargets ?? new Map<string, string>();
    const { selectedTargets } = yield* resolveSelectedTargets(yamlConfig, config.requestedTargets);

    let nextConfig = yamlConfig;
    const merges: TargetMerge[] = [];
    for (const target of selectedTargets) {
      yield* Effect.log(`Merging ${Targets.displayNameOf(target)}...`);
      const yamlTree = yield* YamlModule.resolveTarget(nextConfig, resolvedTargetOf(target));
      const merge = yield* mergeTarget(
        target,
        baselines[Targets.keyOf(target)] ?? emptyTree(),
        yamlTree,
        maxAge,
      );
      nextConfig = Layers.absorbTargetTree(nextConfig, target, merge.mergedTree);
      merges.push(merge);
    }

    const plans: PlannedWrite[] = [];
    for (const merge of merges) {
      const desiredTree = yield* desiredTreeFor(nextConfig, merge.target);
      yield* ensureUnambiguousPaths(
        desiredTree,
        `yaml target ${Targets.displayNameOf(merge.target)}`,
      );
      plans.push(yield* planWrite(merge.target, merge.browserTree, desiredTree));
    }

    const yamlChanged = (yield* renderConfig(nextConfig)) !== (yield* renderConfig(yamlConfig));
    const waiting: WaitingTarget[] = plans.flatMap((plan) => {
      const browser = readOnlyTargets.get(Targets.keyOf(plan.target));
      return browser !== undefined && plannedWritesBrowser(plan)
        ? [{ target: plan.target, browser, pending: plan.writePatches.length || 1 }]
        : [];
    });

    if (!config.dryRun) {
      yield* ensureYamlUnchanged(config.yamlPath, yamlTextAtLoad);
      const nextBaselines: Record<string, BookmarkTree> = { ...baselines };
      for (const plan of plans) {
        const key = Targets.keyOf(plan.target);
        if (readOnlyTargets.has(key)) {
          nextBaselines[key] = plan.browserTree;
          continue;
        }
        yield* Effect.log(`Writing ${Targets.displayNameOf(plan.target)}...`);
        yield* executeWrite(plan);
        nextBaselines[key] = plan.desiredTree;
      }
      if (yamlChanged) {
        yield* ensureYamlUnchanged(config.yamlPath, yamlTextAtLoad);
        yield* saveConfig(config.yamlPath, nextConfig);
      }
      yield* saveBaselines(baselines, nextBaselines);
    }

    const targetResults = plans.map((plan, index) =>
      toTargetResult(plan, merges[index]?.graveyarded ?? []),
    );
    return {
      applied: targetResults.flatMap((result) => result.applied),
      graveyarded: targetResults.flatMap((result) => result.graveyarded),
      targets: targetResults,
      yamlChanged,
      ...(waiting.length > 0 ? { waiting } : {}),
    };
  });

/** Write the YAML to each selected browser as is, and record what each now holds. */
const pushTrees = (
  config: SyncConfig,
  yamlConfig: BookmarksConfig,
  selectedTargets: readonly Targets.TargetDescriptor[],
): Effect.Effect<readonly TargetResult[], Error> =>
  Effect.gen(function* () {
    const baselines = yield* Baseline.load();
    const nextBaselines: Record<string, BookmarkTree> = { ...baselines };
    const results: TargetResult[] = [];

    for (const target of selectedTargets) {
      yield* Effect.log(`Pushing ${Targets.displayNameOf(target)}...`);
      const desiredTree = yield* desiredTreeFor(yamlConfig, target);
      yield* ensureUnambiguousPaths(desiredTree, `yaml target ${Targets.displayNameOf(target)}`);
      const browserTree = yield* Targets.readTree(target);
      const plan = yield* planWrite(target, browserTree, desiredTree);
      if (!config.dryRun) {
        yield* executeWrite(plan);
        nextBaselines[Targets.keyOf(target)] = desiredTree;
      }
      results.push(toTargetResult(plan));
    }

    if (!config.dryRun) yield* saveBaselines(baselines, nextBaselines);
    return results;
  });

const runPush = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  Effect.gen(function* () {
    const yamlConfig = yield* loadConfig(config);
    const { selectedTargets } = yield* resolveSelectedTargets(yamlConfig, config.requestedTargets);
    const targetResults = yield* pushTrees(config, yamlConfig, selectedTargets);

    return {
      applied: targetResults.flatMap((result) => result.applied),
      graveyarded: [],
      targets: targetResults,
      yamlChanged: false,
    };
  });

export const sync = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  config.dryRun ? runSync(config) : runManagedOperation("sync", config);

export const push = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  config.dryRun ? runPush(config) : runManagedOperation("push", config);

export const status = (config: SyncConfig): Effect.Effect<StatusResult, Error> =>
  Effect.gen(function* () {
    const yamlConfig = yield* loadConfig(config);
    const targetStatuses: StatusTargetResult[] = [];
    const { selectedTargets } = yield* resolveSelectedTargets(yamlConfig, config.requestedTargets);

    for (const target of selectedTargets) {
      const yamlTree = yield* desiredTreeFor(yamlConfig, target);
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
      {
        label: "sync baselines",
        path: Paths.defaultSyncBaselinePath(),
        filename: `${timestamp}--${Path.basename(Paths.defaultSyncBaselinePath())}`,
      },
      ...selectedTargets.map((target) => ({
        label: Targets.displayNameOf(target),
        path: target.path,
        filename: `${timestamp}--${Targets.displayNameOf(target).replaceAll("/", "--")}--${Path.basename(target.path)}`,
      })),
    ];

    for (const candidate of candidates) {
      const destination = Path.join(backupDir, candidate.filename);
      const exists = yield* fileExists(candidate.path);

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

/** The graveyard is a menu folder, so an overlay's menu is the only place it can be. */
const gcMenu = (
  menu: BookmarkSection | undefined,
  maxAge: Duration.Duration,
): Effect.Effect<BookmarkSection | undefined, Error> =>
  menu === undefined
    ? Effect.succeed(undefined)
    : Graveyard.gc(BookmarkTree.make({ menu }), maxAge).pipe(Effect.map((tree) => tree.menu));

/** Remove expired graveyard entries from every layer of the YAML. */
const gcConfig = (
  config: BookmarksConfig,
  maxAge: Duration.Duration,
): Effect.Effect<BookmarksConfig, Error> =>
  Effect.gen(function* () {
    const all = yield* Graveyard.gc(config.all, maxAge);
    const safari = config.safari
      ? SafariBookmarks.make({
          enabled: config.safari.enabled,
          bar: config.safari.bar,
          menu: normalizeSection(yield* gcMenu(config.safari.menu, maxAge)),
          reading_list: config.safari.reading_list,
        })
      : undefined;
    const profiles: Record<string, ChromeProfileBookmarks> = {};
    for (const [profile, profileConfig] of Object.entries(config.chrome?.profiles ?? {})) {
      profiles[profile] = ChromeProfileBookmarks.make({
        enabled: profileConfig.enabled,
        bar: profileConfig.bar,
        menu: normalizeSection(yield* gcMenu(profileConfig.menu, maxAge)),
        mobile: profileConfig.mobile,
      });
    }
    const chrome = config.chrome
      ? ChromeBookmarks.make({
          enabled: config.chrome.enabled,
          bar: config.chrome.bar,
          menu: normalizeSection(yield* gcMenu(config.chrome.menu, maxAge)),
          mobile: config.chrome.mobile,
          profiles: config.chrome.profiles ? profiles : undefined,
        })
      : undefined;
    return BookmarksConfig.make({
      version: config.version,
      all: withoutEmptySections(all),
      safari,
      chrome,
    });
  });

/** A section a graveyard sweep emptied is gone, as it would be after a browser read. */
const withoutEmptySections = (tree: BookmarkTree): BookmarkTree =>
  BookmarkTree.make({
    bar: normalizeSection(tree.bar),
    menu: normalizeSection(tree.menu),
    reading_list: normalizeSection(tree.reading_list),
    mobile: normalizeSection(tree.mobile),
  });

const runGc = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  Effect.gen(function* () {
    const yamlConfig = yield* loadConfig(config);
    const cleanedConfig = yield* gcConfig(yamlConfig, config.graveyardMaxAge ?? Duration.days(90));
    const { selectedTargets } = yield* resolveSelectedTargets(
      cleanedConfig,
      config.requestedTargets,
    );
    const targetResults = yield* pushTrees(config, cleanedConfig, selectedTargets);
    const yamlChanged = (yield* renderConfig(cleanedConfig)) !== (yield* renderConfig(yamlConfig));
    if (!config.dryRun && yamlChanged) yield* saveConfig(config.yamlPath, cleanedConfig);

    return {
      applied: targetResults.flatMap((result) => result.applied),
      graveyarded: [],
      targets: targetResults,
      yamlChanged,
    };
  });

export const gc = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  config.dryRun ? runGc(config) : runManagedOperation("gc", config);
