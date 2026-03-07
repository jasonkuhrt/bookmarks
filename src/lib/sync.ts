/* oxlint-disable no-non-null-assertion, no-unsafe-type-assertion, restrict-template-expressions */
/**
 * Core sync engine.
 *
 * Pipeline: git baseline -> three-way diff -> resolve conflicts -> apply -> save -> auto-commit.
 * Git is the state store: the committed bookmarks.yaml IS the baseline for both sides.
 * Produces graveyard entries for conflict losers.
 */

import { Array as Arr, DateTime, Duration, Effect, Order } from "effect";
import { execFile } from "node:child_process";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Yaml from "yaml";
import * as ManagedPaths from "./managed-paths.ts";
import * as Paths from "./paths.ts";
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
import { ensureMutationSupported } from "./unsupported.ts";
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

// -- Git baseline --

/**
 * Read the last-committed version of bookmarks.yaml from git.
 * Returns empty BookmarkTree if the file has never been committed.
 */
export const readGitBaselineConfig = (
  yamlPath: string,
): Effect.Effect<BookmarksConfig | null, Error> =>
  Effect.gen(function* () {
    const resolvedGitTarget = yield* resolveGitTarget(yamlPath);
    if (!resolvedGitTarget) {
      yield* Effect.log("bookmarks.yaml is not inside a git repo — using empty baseline");
      return null;
    }
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
      catch: (e) => new Error(`Failed to parse committed bookmarks.yaml: ${e}`),
    });
    const config = yield* YamlModule.decodeDocument(parsed, "committed bookmarks.yaml");
    return config;
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
    catch: (e) => new Error(`Failed to find git repo root: ${e}`),
  });

/** Resolve a possibly symlinked home path to the repo-relative file path git expects. */
const resolveGitTarget = (
  filePath: string,
): Effect.Effect<{ repoRoot: string; relPath: string } | undefined, Error> =>
  Effect.gen(function* () {
    const realDir = yield* Effect.tryPromise({
      try: () => Fs.realpath(Path.dirname(filePath)),
      catch: (e) => new Error(`Failed to resolve real path for ${filePath}: ${e}`),
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
      catch: (e) => new Error(`git add failed: ${e}`),
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
      catch: (e) => new Error(`git diff --cached failed: ${e}`),
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
      catch: (e) => new Error(`git commit failed: ${e}`),
    });

    yield* Effect.log("Auto-committed bookmarks.yaml (new baseline)");
  });

// -- resolveConflicts --

/** Resolve conflicts between YAML-side and browser-side patches. Newest wins. */
export const resolveConflicts = (
  yamlPatches: readonly Patch.BookmarkPatch[],
  browserPatches: readonly Patch.BookmarkPatch[],
): Effect.Effect<ConflictResolution, Error> => {
  const yamlByUrl = Arr.groupBy(yamlPatches, (p) => p.url);
  const browserByUrl = Arr.groupBy(browserPatches, (p) => p.url);

  const apply: Patch.BookmarkPatch[] = [];
  const graveyard: Patch.BookmarkPatch[] = [];

  // Collect all unique URLs from both sides
  const allUrls = new Set([...Object.keys(yamlByUrl), ...Object.keys(browserByUrl)]);

  for (const url of allUrls) {
    const yamlGroup = yamlByUrl[url];
    const browserGroup = browserByUrl[url];

    if (yamlGroup && !browserGroup) {
      apply.push(...yamlGroup);
    } else if (browserGroup && !yamlGroup) {
      apply.push(...browserGroup);
    } else if (yamlGroup && browserGroup) {
      const yamlMax = maxDate(yamlGroup);
      const browserMax = maxDate(browserGroup);

      if (DateTime.greaterThan(browserMax, yamlMax)) {
        apply.push(...browserGroup);
        graveyard.push(...yamlGroup);
      } else {
        // YAML wins (tie-break: YAML wins when equal)
        apply.push(...yamlGroup);
        graveyard.push(...browserGroup);
      }
    }
  }

  return Effect.succeed({ apply, graveyard });
};

/** Find the maximum date among a group of patches. */
const maxDate = (patches: readonly Patch.BookmarkPatch[]): DateTime.Utc =>
  patches.reduce<DateTime.Utc>(
    (max, p) => (DateTime.greaterThan(p.date, max) ? p.date : max),
    patches[0]!.date,
  );

// -- applyPatches --

/** Apply a set of patches to a bookmark tree, producing the updated tree. */
export const applyPatches = (
  tree: BookmarkTree,
  patches: readonly Patch.BookmarkPatch[],
): Effect.Effect<BookmarkTree, Error> => {
  let nextTree = Patch.toTrie(tree);

  // Sort patches: Remove -> Move -> Rename -> Add
  const opPriority: Record<Patch.BookmarkPatch["_tag"], number> = {
    Remove: 0,
    Move: 1,
    Rename: 2,
    Add: 3,
  };
  const byOpOrder = Order.mapInput(Order.number, (p: Patch.BookmarkPatch) => opPriority[p._tag]);
  const sorted = Arr.sort(patches, byOpOrder);

  for (const patch of sorted) {
    nextTree = applyOne(nextTree, patch);
  }

  return Effect.succeed(Patch.fromTrie(nextTree));
};

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
  targetId === "safari" ? "safari" : targetId.split("/", 1)[0]!;

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
  tree as unknown as MutableBookmarkTree;

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
  nodes: BookmarkSection | undefined,
): void => {
  asMutableTree(tree)[sectionKey] = nodes as MutableBookmarkSection | undefined;
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
      current = existing.children as MutableBookmarkSection;
      continue;
    }

    const created = BookmarkFolder.make({ name: folderName, children: [] });
    current.push(created);
    current = created.children as MutableBookmarkSection;
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

const cleanupEmptyRootSections = (tree: BookmarkTree): void => {
  for (const sectionKey of sectionKeys) {
    if ((tree[sectionKey]?.length ?? 0) === 0) {
      setSection(tree, sectionKey, undefined);
    }
  }
};

const findLeafLocationInSection = (
  nodes: MutableBookmarkSection,
  url: string,
): { readonly children: MutableBookmarkSection; readonly index: number } | undefined => {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;

    if (BookmarkLeaf.is(node) && node.url === url) {
      return { children: nodes, index };
    }

    if (BookmarkFolder.is(node)) {
      const found = findLeafLocationInSection(node.children as MutableBookmarkSection, url);
      if (found) return found;
    }
  }

  return undefined;
};

const findLeafLocation = (
  tree: BookmarkTree,
  url: string,
): { readonly children: MutableBookmarkSection; readonly index: number } | undefined => {
  for (const sectionKey of sectionKeys) {
    const section = asMutableTree(tree)[sectionKey];
    if (!section) continue;

    const found = findLeafLocationInSection(section, url);
    if (found) return found;
  }

  return undefined;
};

const removeLeaf = (tree: BookmarkTree, url: string): BookmarkLeaf | undefined => {
  const location = findLeafLocation(tree, url);
  if (!location) return undefined;

  const [removed] = location.children.splice(location.index, 1);
  cleanupEmptyRootSections(tree);

  return removed && BookmarkLeaf.is(removed)
    ? BookmarkLeaf.make({ name: removed.name, url: removed.url })
    : undefined;
};

/** Apply a single patch to the structural working tree via exhaustive Patch.$match. */
const applyOne = (tree: BookmarkTree, patch: Patch.BookmarkPatch): BookmarkTree =>
  Patch.$match(patch, {
    Add: ({ url, name, path }) => {
      const parsed = parseBookmarkPath(path);
      if (!parsed) return tree;

      const parent = ensureFolderPath(ensureSection(tree, parsed.sectionKey), parsed.folderPath);
      parent.push(BookmarkLeaf.make({ name, url }));

      return tree;
    },

    Remove: ({ url }) => {
      removeLeaf(tree, url);
      return tree;
    },

    Rename: ({ url, newName }) => {
      const location = findLeafLocation(tree, url);
      if (!location) return tree;

      location.children[location.index] = BookmarkLeaf.make({ name: newName, url });
      return tree;
    },

    Move: ({ url, toPath }) => {
      const removed = removeLeaf(tree, url);
      if (!removed) return tree;

      const parsed = parseBookmarkPath(toPath);
      if (!parsed) return tree;

      const parent = ensureFolderPath(ensureSection(tree, parsed.sectionKey), parsed.folderPath);
      parent.push(removed);

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
        const exists = yield* Effect.tryPromise({
          try: () =>
            Fs.access(config.yamlPath).then(
              () => true,
              () => false,
            ),
          catch: (e) => new Error(`Failed to inspect ${config.yamlPath}: ${e}`),
        });
        if (!exists) return emptyConfig();

        return yield* YamlModule.load(config.yamlPath);
      });

const validateConfiguredChromeProfiles = (
  config: BookmarksConfig,
  discoveredTargets: readonly Targets.TargetDescriptor[],
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const discoveredChromeProfiles = new Set(
      discoveredTargets
        .filter((target) => target.browser === "chrome" && target.profile)
        .map((target) => `chrome/${target.profile!}`),
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

const ensurePermanentMutationSafety = (
  yamlConfig: BookmarksConfig,
  targets: readonly Targets.TargetDescriptor[],
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
      yield* ensureMutationSupported(yamlTree, `yaml target ${Targets.displayNameOf(target)}`);
      const browserTree = yield* Targets.readTree(target);
      yield* ensureMutationSupported(browserTree, `${Targets.displayNameOf(target)} target`);
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
      yield* ensurePermanentMutationSafety(yamlConfig, selectedTargets);
      const mutationBackup = yield* createMutationBackup(config, yamlConfig);

      const nextConfig = { ...config, yamlOverride: yamlConfig };

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
    if (!nodesEqual(normalizedLeft[index]!, normalizedRight[index]!)) return false;
  }

  return true;
};

const longestCommonPrefix = (
  sections: readonly (BookmarkSection | undefined)[],
): BookmarkSection | undefined => {
  const normalizedSections = sections.map((section) => normalizeSection(section) ?? []);
  const prefixLength = Math.min(...normalizedSections.map((section) => section.length));
  const prefix: BookmarkNode[] = [];

  for (let index = 0; index < prefixLength; index++) {
    const candidate = normalizedSections[0]![index]!;
    if (!normalizedSections.every((section) => nodesEqual(section[index]!, candidate))) break;
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

  const allSections = Object.fromEntries(
    sectionKeys.map((sectionKey) => {
      const supportedTargetIds = supportedTargetIdsForSection(targetIds, sectionKey);
      const prefix =
        supportedTargetIds.length === 0
          ? undefined
          : longestCommonPrefix(
              supportedTargetIds.map((targetId) => resolvedTrees[targetId]![sectionKey]),
            );
      return [sectionKey, prefix];
    }),
  ) as Record<SectionKey, BookmarkSection | undefined>;

  const afterAll = Object.fromEntries(
    targetIds.map((targetId) => [
      targetId,
      treeFromSections(
        Object.fromEntries(
          sectionKeys.map((sectionKey) => {
            const supported = sectionKeysForBrowser(browserOfTargetId(targetId)).includes(
              sectionKey,
            );
            return [
              sectionKey,
              supported
                ? sectionSuffix(
                    resolvedTrees[targetId]![sectionKey],
                    allSections[sectionKey]?.length ?? 0,
                  )
                : undefined,
            ];
          }),
        ) as Partial<Record<SectionKey, BookmarkSection | undefined>>,
      ),
    ]),
  ) as Record<string, BookmarkTree>;

  const chromeTargetIds = targetIds.filter((targetId) => browserOfTargetId(targetId) === "chrome");
  const chromeSections = Object.fromEntries(
    sectionKeys.map((sectionKey) => {
      const supported = sectionKeysForBrowser("chrome").includes(sectionKey);
      const prefix =
        !supported || chromeTargetIds.length === 0
          ? undefined
          : longestCommonPrefix(chromeTargetIds.map((targetId) => afterAll[targetId]![sectionKey]));
      return [sectionKey, prefix];
    }),
  ) as Record<SectionKey, BookmarkSection | undefined>;

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
    ...chromeTargetIds.map((targetId) => profileOfTargetId(targetId)!).filter(Boolean),
    ...Object.keys(currentConfig.chrome?.profiles ?? {}),
  ]);

  const chromeProfiles = Object.fromEntries(
    [...profileNames].sort().flatMap((profile): readonly [string, ChromeProfileBookmarks][] => {
      const targetId = `chrome/${profile}`;
      const overlayTree =
        targetId in afterAll
          ? treeFromSections({
              bar: sectionSuffix(afterAll[targetId]!.bar, chromeSections.bar?.length ?? 0),
              menu: sectionSuffix(afterAll[targetId]!.menu, chromeSections.menu?.length ?? 0),
              mobile: sectionSuffix(afterAll[targetId]!.mobile, chromeSections.mobile?.length ?? 0),
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
  readonly result: TargetResult;
  readonly writePatches: readonly Patch.BookmarkPatch[];
}

const planSyncTarget = (
  target: Targets.TargetDescriptor,
  baselineTree: BookmarkTree,
  yamlTree: BookmarkTree,
  maxAge: Duration.Duration,
): Effect.Effect<PlannedTargetSync, Error> =>
  Effect.gen(function* () {
    const browserTree = yield* Targets.readTree(target);
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
    const writeMode = finalProjection.exact ? ("patches" as const) : ("rewrite" as const);

    return {
      target,
      tree: finalTree,
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
  yamlTree: BookmarkTree,
  dryRun: boolean,
): Effect.Effect<TargetResult, Error> =>
  Effect.gen(function* () {
    const browserTree = yield* Targets.readTree(target);
    const finalProjection = yield* projectTree(
      browserTree,
      yamlTree,
      "yaml",
      `${target.browser} target`,
    );
    const writeMode = finalProjection.exact ? ("patches" as const) : ("rewrite" as const);

    if (!dryRun) {
      if (writeMode === "rewrite") {
        yield* Targets.writeTree(target, yamlTree);
      } else {
        yield* Targets.applyPatches(target, finalProjection.patches);
      }
      yield* verifyTargetWrite(target, yamlTree);
    }

    return {
      target,
      applied: finalProjection.patches,
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
 * Git is the state store. The committed bookmarks.yaml is the baseline for
 * three-way diff. After sync, bookmarks.yaml is auto-committed so the
 * committed version becomes the new baseline.
 *
 * Fresh sync (no committed bookmarks.yaml): baseline is empty tree,
 * every Safari bookmark becomes an Add patch, YAML is populated from scratch.
 *
 * Incremental sync: three-way diff between committed YAML (baseline),
 * current YAML on disk (user edits), and current Safari (browser changes).
 * Newest-wins conflict resolution, YAML tie-break.
 */
const runSync = (config: SyncConfig): Effect.Effect<SyncResult, Error> =>
  Effect.gen(function* () {
    const yamlConfig = yield* loadConfig(config);
    const baselineConfig = (yield* readGitBaselineConfig(config.yamlPath)) ?? emptyConfig();
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
          yield* Targets.writeTree(targetSync.target, targetSync.tree);
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
      const yamlTree = yield* YamlModule.resolveTarget(yamlConfig, resolvedTargetOf(target));
      const browserTree = yield* Targets.readTree(target);
      targetStatuses.push({
        target,
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
        try: () =>
          Fs.access(candidate.path).then(
            () => true,
            () => false,
          ),
        catch: (e) => new Error(`Failed to inspect backup candidate ${candidate.path}: ${e}`),
      });

      if (!exists) {
        skipped.push(candidate.label);
        continue;
      }

      yield* Effect.tryPromise({
        try: () => Fs.copyFile(candidate.path, destination),
        catch: (e) => new Error(`Failed to back up ${candidate.path}: ${e}`),
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
      cleanedResolvedTrees[targetId] = yield* gcTree(currentResolvedTrees[targetId]!, maxAge);
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
