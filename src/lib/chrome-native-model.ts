import { Context, Effect } from "effect";
import type { BookmarkNode, BookmarkSection } from "./schema/__.ts";
import { BookmarkFolder, BookmarkLeaf, BookmarkTree } from "./schema/__.ts";

export type ChromeFolderType = "bookmarks-bar" | "other" | "mobile" | "managed";

export interface ChromeBookmarkNode {
  readonly id: string;
  readonly parentId?: string;
  readonly index?: number;
  readonly title: string;
  readonly url?: string;
  readonly children?: readonly ChromeBookmarkNode[];
  readonly folderType?: ChromeFolderType;
  readonly syncing?: boolean;
  readonly unmodifiable?: "managed";
  readonly dateAdded?: number;
  readonly dateGroupModified?: number;
}

export interface ChromeCreateDetails {
  readonly parentId: string;
  readonly index?: number;
  readonly title: string;
  readonly url?: string;
}

export interface ChromeUpdateChanges {
  readonly title?: string;
  readonly url?: string;
}

export interface ChromeMoveDestination {
  readonly parentId: string;
  readonly index: number;
}

export interface ChromeBookmarksApi {
  readonly getTree: () => Effect.Effect<readonly ChromeBookmarkNode[], Error>;
  readonly create: (details: ChromeCreateDetails) => Effect.Effect<ChromeBookmarkNode, Error>;
  readonly update: (
    id: string,
    changes: ChromeUpdateChanges,
  ) => Effect.Effect<ChromeBookmarkNode, Error>;
  readonly move: (
    id: string,
    destination: ChromeMoveDestination,
  ) => Effect.Effect<ChromeBookmarkNode, Error>;
  readonly remove: (id: string) => Effect.Effect<void, Error>;
}

export const ChromeBookmarks = Context.GenericTag<ChromeBookmarksApi>(
  "@jasonkuhrt/bookmarks/ChromeBookmarks",
);

export interface ChromeRootOptions {
  readonly rootSelection?: "unique" | "prefer-syncing";
}

type ChromeSectionKey = "bar" | "menu" | "mobile";

interface SelectedRoots {
  readonly bar: ChromeBookmarkNode | undefined;
  readonly menu: ChromeBookmarkNode | undefined;
  readonly mobile: ChromeBookmarkNode | undefined;
}

interface NativeEntry {
  readonly node: ChromeBookmarkNode;
  readonly parentId: string;
  readonly section: ChromeSectionKey;
  readonly index: number;
  readonly depth: number;
  readonly traversal: number;
}

interface DesiredEntry {
  readonly node: BookmarkNode;
  readonly parentKey: string;
  readonly section: ChromeSectionKey;
  readonly index: number;
  readonly depth: number;
  readonly key: string;
  readonly traversal: number;
}

const sectionRootTypes = {
  bar: "bookmarks-bar",
  menu: "other",
  mobile: "mobile",
} as const satisfies Record<ChromeSectionKey, ChromeFolderType>;

const legacyRootIds = {
  bar: "1",
  menu: "2",
  mobile: "3",
} as const satisfies Record<ChromeSectionKey, string>;

const sectionKeys = ["bar", "menu", "mobile"] as const;

const errorFromUnknown = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const directRoots = (tree: readonly ChromeBookmarkNode[]): readonly ChromeBookmarkNode[] =>
  tree.flatMap((node) =>
    node.folderType || node.parentId !== undefined ? [node] : (node.children ?? []),
  );

const selectTypedRoot = (
  candidates: readonly ChromeBookmarkNode[],
  section: ChromeSectionKey,
  rootSelection: "unique" | "prefer-syncing",
): ChromeBookmarkNode | undefined => {
  const type = sectionRootTypes[section];
  const matches = candidates.filter((node) => node.folderType === type);
  if (matches.length === 0) return undefined;

  if (rootSelection === "prefer-syncing") {
    if (matches.length === 1) return matches[0];
    const syncingMatches = matches.filter((node) => node.syncing === true);
    if (syncingMatches.length === 1) return syncingMatches[0];
    if (syncingMatches.length > 1) {
      throw new Error(`Chrome exposes multiple syncing ${type} bookmark roots.`);
    }
    throw new Error(`Chrome does not expose one syncing ${type} bookmark root.`);
  }

  if (matches.length > 1) {
    throw new Error(
      `Chrome exposes multiple ${type} bookmark roots. Select the syncing root explicitly.`,
    );
  }
  return matches[0];
};

const selectRoots = (
  tree: readonly ChromeBookmarkNode[],
  options: ChromeRootOptions,
): SelectedRoots => {
  const candidates = directRoots(tree);
  const hasTypedRoots = candidates.some((node) => node.folderType !== undefined);
  const rootSelection = options.rootSelection ?? "unique";

  if (hasTypedRoots) {
    return {
      bar: selectTypedRoot(candidates, "bar", rootSelection),
      menu: selectTypedRoot(candidates, "menu", rootSelection),
      mobile: selectTypedRoot(candidates, "mobile", rootSelection),
    };
  }

  const byId = new Map(candidates.map((node) => [node.id, node]));
  return {
    bar: byId.get(legacyRootIds.bar),
    menu: byId.get(legacyRootIds.menu),
    mobile: byId.get(legacyRootIds.mobile),
  };
};

const toBookmarkNode = (node: ChromeBookmarkNode): BookmarkNode =>
  node.url === undefined
    ? BookmarkFolder.make({
        name: node.title,
        children: (node.children ?? []).map(toBookmarkNode),
      })
    : BookmarkLeaf.make({ name: node.title, url: node.url });

export const toBookmarkTree = (
  tree: readonly ChromeBookmarkNode[],
  options: ChromeRootOptions = {},
): BookmarkTree => {
  const roots = selectRoots(tree, options);
  const section = (root: ChromeBookmarkNode | undefined): BookmarkSection | undefined =>
    root?.children?.map(toBookmarkNode) ?? (root ? [] : undefined);

  return BookmarkTree.make({
    bar: section(roots.bar),
    menu: section(roots.menu),
    mobile: section(roots.mobile),
  });
};

const canonicalNode = (node: BookmarkNode): unknown =>
  BookmarkLeaf.is(node)
    ? ["leaf", node.name, node.url]
    : ["folder", node.name, node.children.map(canonicalNode)];

export const fingerprint = (tree: BookmarkTree): string =>
  JSON.stringify(sectionKeys.map((section) => [section, (tree[section] ?? []).map(canonicalNode)]));

const treeEquals = (left: BookmarkTree, right: BookmarkTree): boolean =>
  fingerprint(left) === fingerprint(right);

const decodeTree = (
  tree: readonly ChromeBookmarkNode[],
  options: ChromeRootOptions,
): Effect.Effect<BookmarkTree, Error> =>
  Effect.try({
    try: () => toBookmarkTree(tree, options),
    catch: errorFromUnknown,
  });

const flattenNative = (roots: SelectedRoots): readonly NativeEntry[] => {
  const entries: NativeEntry[] = [];
  let traversal = 0;

  const visit = (
    nodes: readonly ChromeBookmarkNode[],
    parentId: string,
    section: ChromeSectionKey,
    depth: number,
  ): void => {
    nodes.forEach((node, index) => {
      entries.push({ node, parentId, section, index, depth, traversal: traversal++ });
      if (node.url === undefined) visit(node.children ?? [], node.id, section, depth + 1);
    });
  };

  for (const section of sectionKeys) {
    const root = roots[section];
    if (root) visit(root.children ?? [], root.id, section, 0);
  }
  return entries;
};

const flattenDesired = (tree: BookmarkTree): readonly DesiredEntry[] => {
  const entries: DesiredEntry[] = [];
  let traversal = 0;

  const visit = (
    nodes: BookmarkSection,
    parentKey: string,
    section: ChromeSectionKey,
    depth: number,
    indices: readonly number[],
  ): void => {
    nodes.forEach((node, index) => {
      const key = `${section}/${[...indices, index].join("/")}`;
      entries.push({ node, parentKey, section, index, depth, key, traversal: traversal++ });
      if (BookmarkFolder.is(node)) {
        visit(node.children, key, section, depth + 1, [...indices, index]);
      }
    });
  };

  for (const section of sectionKeys) {
    visit(tree[section] ?? [], `root:${section}`, section, 0, []);
  }
  return entries;
};

const nativeNodeAsBookmark = (node: ChromeBookmarkNode): BookmarkNode => toBookmarkNode(node);

const folderContentFingerprint = (node: BookmarkFolder): string =>
  JSON.stringify(node.children.map(canonicalNode));

const desiredParentId = (
  desired: DesiredEntry,
  roots: SelectedRoots,
  matchedIds: ReadonlyMap<string, string>,
): string | undefined => {
  if (desired.parentKey.startsWith("root:")) return roots[desired.section]?.id;
  return matchedIds.get(desired.parentKey);
};

const matchEntries = (
  nativeEntries: readonly NativeEntry[],
  desiredEntries: readonly DesiredEntry[],
  roots: SelectedRoots,
): Map<string, string> => {
  const matchedIds = new Map<string, string>();
  const usedNativeIds = new Set<string>();

  interface Candidate {
    readonly desired: DesiredEntry;
    readonly native: NativeEntry;
    readonly score: number;
  }

  const assignCandidates = (candidates: readonly Candidate[]): void => {
    const ordered = [...candidates].sort(
      (left, right) =>
        right.score - left.score ||
        left.desired.traversal - right.desired.traversal ||
        left.native.traversal - right.native.traversal,
    );
    for (const candidate of ordered) {
      if (matchedIds.has(candidate.desired.key) || usedNativeIds.has(candidate.native.node.id)) {
        continue;
      }
      matchedIds.set(candidate.desired.key, candidate.native.node.id);
      usedNativeIds.add(candidate.native.node.id);
    }
  };

  const folders = desiredEntries
    .filter((entry): entry is DesiredEntry & { readonly node: BookmarkFolder } =>
      BookmarkFolder.is(entry.node),
    )
    .sort((left, right) => left.depth - right.depth || left.traversal - right.traversal);

  for (const depth of new Set(folders.map((folder) => folder.depth))) {
    const candidates: Candidate[] = [];
    for (const desired of folders.filter((folder) => folder.depth === depth)) {
      const parentId = desiredParentId(desired, roots, matchedIds);
      const desiredFull = JSON.stringify(canonicalNode(desired.node));
      const desiredContent = folderContentFingerprint(desired.node);

      for (const native of nativeEntries) {
        if (usedNativeIds.has(native.node.id) || native.node.url !== undefined) continue;
        const nativeFolder = nativeNodeAsBookmark(native.node);
        if (!BookmarkFolder.is(nativeFolder)) continue;
        const fullMatch = JSON.stringify(canonicalNode(nativeFolder)) === desiredFull;
        const contentMatch = folderContentFingerprint(nativeFolder) === desiredContent;
        const titleMatch = nativeFolder.name === desired.node.name;
        const parentMatch = parentId !== undefined && native.parentId === parentId;
        if (
          !fullMatch &&
          !contentMatch &&
          !titleMatch &&
          !(parentMatch && native.index === desired.index)
        ) {
          continue;
        }
        candidates.push({
          desired,
          native,
          score:
            (fullMatch ? 100_000 : 0) +
            (contentMatch ? 50_000 : 0) +
            (titleMatch ? 10_000 : 0) +
            (parentMatch ? 1_000 : 0) +
            (native.section === desired.section ? 100 : 0) +
            (native.index === desired.index ? 10 : 0),
        });
      }
    }
    assignCandidates(candidates);
  }

  const leaves = desiredEntries.filter(
    (entry): entry is DesiredEntry & { readonly node: BookmarkLeaf } => BookmarkLeaf.is(entry.node),
  );
  const leafCandidates: Candidate[] = [];
  for (const desired of leaves) {
    const parentId = desiredParentId(desired, roots, matchedIds);
    for (const native of nativeEntries) {
      if (
        usedNativeIds.has(native.node.id) ||
        native.node.url === undefined ||
        native.node.url !== desired.node.url
      ) {
        continue;
      }
      leafCandidates.push({
        desired,
        native,
        score:
          (native.node.title === desired.node.name ? 10_000 : 0) +
          (parentId !== undefined && native.parentId === parentId ? 1_000 : 0) +
          (native.section === desired.section ? 100 : 0) +
          (native.index === desired.index ? 10 : 0),
      });
    }
  }
  assignCandidates(leafCandidates);

  return matchedIds;
};

const ensureMutableRoots = (
  roots: SelectedRoots,
  nativeEntries: readonly NativeEntry[],
): Effect.Effect<void, Error> => {
  const unmodifiable = [
    ...sectionKeys.flatMap((section) => (roots[section] ? [roots[section]] : [])),
    ...nativeEntries.map((entry) => entry.node),
  ].find((node) => node.unmodifiable !== undefined);

  return unmodifiable
    ? Effect.fail(
        new Error(
          `Cannot reconcile Chrome bookmarks because selected root node ${unmodifiable.id} is managed or unmodifiable.`,
        ),
      )
    : Effect.void;
};

export const snapshot = (
  options: ChromeRootOptions = {},
): Effect.Effect<BookmarkTree, Error, ChromeBookmarksApi> =>
  Effect.gen(function* () {
    const api = yield* ChromeBookmarks;
    return yield* decodeTree(yield* api.getTree(), options);
  });

export const reconcile = (
  expectedTree: BookmarkTree,
  desiredTree: BookmarkTree,
  options: ChromeRootOptions = {},
): Effect.Effect<BookmarkTree, Error, ChromeBookmarksApi> =>
  Effect.gen(function* () {
    const api = yield* ChromeBookmarks;
    const initialNativeTree = yield* api.getTree();
    const initialTree = yield* decodeTree(initialNativeTree, options);
    if (!treeEquals(initialTree, expectedTree)) {
      return yield* Effect.fail(
        new Error("Chrome bookmarks changed after planning; retry from a fresh snapshot."),
      );
    }
    if (treeEquals(initialTree, desiredTree)) return initialTree;

    const roots = yield* Effect.try({
      try: () => selectRoots(initialNativeTree, options),
      catch: errorFromUnknown,
    });
    const nativeEntries = flattenNative(roots);
    yield* ensureMutableRoots(roots, nativeEntries);

    for (const section of sectionKeys) {
      if ((desiredTree[section]?.length ?? 0) > 0 && !roots[section]) {
        return yield* Effect.fail(
          new Error(`Chrome does not expose a ${sectionRootTypes[section]} bookmark root.`),
        );
      }
    }

    const desiredEntries = flattenDesired(desiredTree);
    const matchedIds = matchEntries(nativeEntries, desiredEntries, roots);
    const nativeById = new Map(nativeEntries.map((entry) => [entry.node.id, entry]));

    for (const desired of desiredEntries) {
      if (matchedIds.has(desired.key)) continue;
      const parentId = desiredParentId(desired, roots, matchedIds);
      if (!parentId) {
        return yield* Effect.fail(new Error(`Cannot resolve Chrome parent for ${desired.key}.`));
      }
      const created = yield* api.create({
        parentId,
        title: desired.node.name,
        ...(BookmarkLeaf.is(desired.node) ? { url: desired.node.url } : {}),
      });
      matchedIds.set(desired.key, created.id);
    }

    for (const desired of desiredEntries) {
      const id = matchedIds.get(desired.key);
      if (!id) return yield* Effect.fail(new Error(`Missing Chrome node for ${desired.key}.`));
      const existing = nativeById.get(id)?.node;
      if (existing && existing.title !== desired.node.name) {
        yield* api.update(id, { title: desired.node.name });
      }
    }

    const childrenByParent = new Map<string, string[]>();
    const parentById = new Map<string, string>();
    for (const section of sectionKeys) {
      const root = roots[section];
      if (root)
        childrenByParent.set(
          root.id,
          (root.children ?? []).map((node) => node.id),
        );
    }
    for (const entry of nativeEntries) {
      parentById.set(entry.node.id, entry.parentId);
      if (entry.node.url === undefined) {
        childrenByParent.set(
          entry.node.id,
          (entry.node.children ?? []).map((node) => node.id),
        );
      }
    }
    for (const desired of desiredEntries) {
      const id = matchedIds.get(desired.key);
      if (!id || nativeById.has(id)) continue;
      const parentId = desiredParentId(desired, roots, matchedIds);
      if (!parentId) return yield* Effect.fail(new Error(`Missing parent for ${desired.key}.`));
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(id);
      childrenByParent.set(parentId, siblings);
      parentById.set(id, parentId);
      if (BookmarkFolder.is(desired.node)) childrenByParent.set(id, []);
    }

    const desiredParents = [
      ...sectionKeys.map((section) => ({
        key: `root:${section}`,
        depth: -1,
        children: desiredEntries.filter((entry) => entry.parentKey === `root:${section}`),
      })),
      ...desiredEntries
        .filter((entry) => BookmarkFolder.is(entry.node))
        .map((entry) => ({
          key: entry.key,
          depth: entry.depth,
          children: desiredEntries.filter((child) => child.parentKey === entry.key),
        })),
    ].sort((left, right) => left.depth - right.depth);

    for (const parent of desiredParents) {
      const rootSection = sectionKeys.find((section) => parent.key === `root:${section}`);
      const parentId = rootSection ? roots[rootSection]?.id : matchedIds.get(parent.key);
      if (!parentId) continue;

      for (const [index, child] of parent.children.entries()) {
        const id = matchedIds.get(child.key);
        if (!id) return yield* Effect.fail(new Error(`Missing Chrome node for ${child.key}.`));
        const currentParentId = parentById.get(id);
        const targetChildren = childrenByParent.get(parentId) ?? [];
        if (currentParentId === parentId && targetChildren[index] === id) continue;

        if (currentParentId) {
          const currentChildren = childrenByParent.get(currentParentId) ?? [];
          const currentIndex = currentChildren.indexOf(id);
          if (currentIndex >= 0) currentChildren.splice(currentIndex, 1);
          childrenByParent.set(currentParentId, currentChildren);
        }
        const insertChildren = childrenByParent.get(parentId) ?? [];
        insertChildren.splice(index, 0, id);
        childrenByParent.set(parentId, insertChildren);
        parentById.set(id, parentId);
        yield* api.move(id, { parentId, index });
      }
    }

    const retainedIds = new Set(matchedIds.values());
    const removals = nativeEntries
      .filter((entry) => !retainedIds.has(entry.node.id))
      .sort((left, right) => right.depth - left.depth || right.traversal - left.traversal);
    for (const removal of removals) yield* api.remove(removal.node.id);

    const finalTree = yield* decodeTree(yield* api.getTree(), options);
    if (!treeEquals(finalTree, desiredTree)) {
      return yield* Effect.fail(
        new Error("Chrome bookmark reconciliation did not produce the requested tree."),
      );
    }
    return finalTree;
  });
