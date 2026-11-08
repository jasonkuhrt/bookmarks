/**
 * Chrome JSON adapter.
 *
 * Reads Chrome's Bookmarks JSON and extracts a clean BookmarkTree (lossy -- discards Chrome metadata).
 * Applies BookmarkPatch[] surgically to the native JSON structure (preserves all metadata).
 * Handles Chrome's Windows-epoch timestamps, MD5 checksum recalculation, and atomic file writes.
 */

import { DateTime, Effect, Schema } from "effect";
import { rename } from "node:fs/promises";
import * as Patch from "./patch.ts";
import type { BookmarkNode, BookmarkSection } from "./schema/__.ts";
import { BookmarkFolder, BookmarkLeaf, BookmarkTree } from "./schema/__.ts";
import { separatorIssue, UnsupportedBookmarks, unsupportedNodeIssue } from "./unsupported.ts";
import type { BookmarkIssue } from "./unsupported.ts";

// -- Chrome JSON type aliases --

type ChromeNode = {
  type: string;
  name: string;
  id: string;
  guid: string;
  date_added: string;
  date_last_used?: string;
  url?: string;
  children?: ChromeNode[];
  meta_info?: Record<string, string>;
  date_modified?: string;
};

type ChromeRoot = {
  bookmark_bar: ChromeNode;
  other: ChromeNode;
  synced: ChromeNode;
};

type ChromeBookmarksFile = {
  checksum: string;
  roots: ChromeRoot;
  version: number;
  sync_metadata?: string;
};

type ChromeSectionKey = "bar" | "menu" | "mobile";

const chromeSections = [
  ["bookmark_bar", "bar"],
  ["other", "menu"],
  ["synced", "mobile"],
] as const satisfies readonly (readonly [keyof ChromeRoot, ChromeSectionKey])[];

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const expectDefined = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
};

const parseChromeBookmarksFile = (text: string, bookmarksPath: string): ChromeBookmarksFile => {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Chrome bookmark files are read from the browser and used through the adapter's typed helpers below.
    return JSON.parse(text) as ChromeBookmarksFile;
  } catch (error) {
    throw new Error(
      `Failed to parse Chrome bookmarks at ${bookmarksPath}: ${messageFromUnknown(error)}`,
      { cause: error },
    );
  }
};

const syncMetadataMutationError = (bookmarksPath: string): Error =>
  new Error(
    `Cannot modify Chrome bookmarks at ${bookmarksPath} by writing its data file because Chrome Sync metadata is present. Chrome Sync can undo direct disk edits. Use Chrome's browser-native Bookmark Manager or bookmark import instead.`,
  );

const ensureNoSyncMetadata = (
  file: ChromeBookmarksFile,
  bookmarksPath: string,
): Effect.Effect<void, Error> =>
  file.sync_metadata ? Effect.fail(syncMetadataMutationError(bookmarksPath)) : Effect.void;

export const ensureDirectMutationSafe = (bookmarksPath: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => Bun.file(bookmarksPath).text(),
      catch: (cause) => new Error(`Failed to read Chrome bookmarks at ${bookmarksPath}`, { cause }),
    });
    yield* ensureNoSyncMetadata(parseChromeBookmarksFile(text, bookmarksPath), bookmarksPath);
  });

const decodeUnknownChildren = (children: readonly unknown[] | undefined): BookmarkNode[] => {
  if (!children) return [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Schema transforms only pass raw Chrome child node arrays into this helper.
  return decodeNodes(children as ChromeNode[]);
};

// -- Chrome timestamp helpers --

/** Offset in seconds between Windows epoch (1601-01-01) and Unix epoch (1970-01-01). */
const WINDOWS_EPOCH_OFFSET = 11_644_473_600n;

/** Convert Chrome timestamp (Windows epoch microseconds as string) to Unix milliseconds. */
export const chromeTimestampToUnixMs = (chromeTs: string): number => {
  const us = BigInt(chromeTs);
  if (us === 0n) return 0;
  const unixSeconds = us / 1_000_000n - WINDOWS_EPOCH_OFFSET;
  return Number(unixSeconds) * 1000;
};

/** Convert Unix milliseconds to Chrome timestamp (Windows epoch microseconds as string). */
export const unixMsToChromeTimestamp = (unixMs: number): string => {
  const unixSeconds = BigInt(Math.floor(unixMs / 1000));
  const us = (unixSeconds + WINDOWS_EPOCH_OFFSET) * 1_000_000n;
  return us.toString();
};

/** Generate a Chrome timestamp for "now". */
const nowChromeTimestamp = (): string =>
  unixMsToChromeTimestamp(DateTime.toEpochMillis(DateTime.unsafeNow()));

// -- Chrome section key ↔ domain section key mappings --

const SECTION_TO_CHROME_KEY: Record<ChromeSectionKey, keyof ChromeRoot> = {
  bar: "bookmark_bar",
  menu: "other",
  mobile: "synced",
};

// -- Chrome JSON ↔ domain Schema transforms (read path: lossy, discards Chrome metadata) --

const ChromeLeafTransform = Schema.transform(
  Schema.Struct({
    type: Schema.Literal("url"),
    name: Schema.String,
    url: Schema.String,
  }),
  BookmarkLeaf,
  {
    strict: false,
    decode: (chrome) => ({ _tag: "BookmarkLeaf" as const, url: chrome.url, name: chrome.name }),
    encode: (leaf) => ({
      type: "url" as const,
      name: leaf.name,
      url: leaf.url,
    }),
  },
);

const ChromeFolderTransform = Schema.transform(
  Schema.Struct({
    type: Schema.Literal("folder"),
    name: Schema.String,
    children: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
  BookmarkFolder,
  {
    strict: false,
    decode: (chrome) => ({
      _tag: "BookmarkFolder" as const,
      name: chrome.name,
      children: decodeUnknownChildren(chrome.children),
    }),
    encode: (folder) => ({
      type: "folder" as const,
      name: folder.name,
      children: folder.children,
    }),
  },
);

// -- MD5 checksum calculation --

/**
 * Encode a string as UTF-16LE bytes (matching Chromium's internal string16 representation).
 * This is used for the "name" (title) field in the checksum calculation.
 */
const toUtf16LeBytes = (str: string): Uint8Array => {
  return new Uint8Array(Buffer.from(str, "utf16le"));
};

/**
 * Calculate Chrome's MD5 checksum for the bookmark tree.
 *
 * Walks the tree depth-first through bookmark_bar, other, synced roots.
 * For each node feeds into MD5: id (ASCII), name (UTF-16LE), type ("url"|"folder" ASCII),
 * and for URL nodes also the url (ASCII). For folders, recurses into children.
 */
export const calculateChecksum = (roots: ChromeRoot): string => {
  const hasher = new Bun.CryptoHasher("md5");

  const updateNode = (node: ChromeNode): void => {
    // id as ASCII bytes
    hasher.update(node.id);
    // name as UTF-16LE bytes
    hasher.update(toUtf16LeBytes(node.name));

    if (node.type === "url") {
      hasher.update("url");
      hasher.update(node.url ?? "");
    } else {
      hasher.update("folder");
      if (node.children) {
        for (const child of node.children) {
          updateNode(child);
        }
      }
    }
  };

  // Process roots in the canonical order: bookmark_bar, other, synced
  updateNode(roots.bookmark_bar);
  updateNode(roots.other);
  updateNode(roots.synced);

  return hasher.digest("hex");
};

// -- readBookmarks --

const bookmarkNodesEqual = (left: BookmarkNode, right: BookmarkNode): boolean => {
  if (BookmarkLeaf.is(left) && BookmarkLeaf.is(right)) {
    return left.name === right.name && left.url === right.url;
  }
  if (BookmarkFolder.is(left) && BookmarkFolder.is(right)) {
    return (
      left.name === right.name &&
      left.children.length === right.children.length &&
      left.children.every((node, index) => {
        const other = right.children[index];
        return other !== undefined && bookmarkNodesEqual(node, other);
      })
    );
  }
  return false;
};

const bookmarkSectionsEqual = (
  left: BookmarkSection | undefined,
  right: BookmarkSection | undefined,
): boolean => {
  const leftNodes = left ?? [];
  const rightNodes = right ?? [];
  return (
    leftNodes.length === rightNodes.length &&
    leftNodes.every((node, index) => {
      const other = rightNodes[index];
      return other !== undefined && bookmarkNodesEqual(node, other);
    })
  );
};

const bookmarkTreesEqual = (left: BookmarkTree, right: BookmarkTree): boolean =>
  (["bar", "menu", "reading_list", "mobile"] as const).every((section) =>
    bookmarkSectionsEqual(left[section], right[section]),
  );

const decodeBookmarkTree = (
  file: ChromeBookmarksFile,
  bookmarksPath: string,
): Effect.Effect<BookmarkTree, Error> =>
  Effect.gen(function* () {
    const { roots } = file;
    const sections: Partial<Record<"bar" | "menu" | "mobile", BookmarkSection>> = {};
    const issues: BookmarkIssue[] = [];

    for (const [chromeKey, sectionKey] of chromeSections) {
      const rootNode = roots[chromeKey];
      if (rootNode.children && rootNode.children.length > 0) {
        issues.push(...scanNodes(rootNode.children, sectionKey));
        sections[sectionKey] = decodeNodes(rootNode.children);
      }
    }

    if (issues.length > 0) {
      return yield* Effect.fail(
        new UnsupportedBookmarks({
          source: `Chrome bookmarks at ${bookmarksPath}`,
          issues,
        }),
      );
    }

    return BookmarkTree.make({
      bar: sections.bar,
      menu: sections.menu,
      mobile: sections.mobile,
    });
  });

/** Read Chrome bookmarks from a Bookmarks JSON file path into a clean BookmarkTree. */
export const readBookmarks = (bookmarksPath: string): Effect.Effect<BookmarkTree, Error> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => Bun.file(bookmarksPath).text(),
      catch: (cause) => new Error(`Failed to read Chrome bookmarks at ${bookmarksPath}`, { cause }),
    });

    const file = parseChromeBookmarksFile(text, bookmarksPath);
    return yield* decodeBookmarkTree(file, bookmarksPath);
  });

// -- applyPatches --

/**
 * Apply bookmark patches surgically to an existing Chrome Bookmarks JSON, preserving all metadata.
 *
 * Architecture note: this operates on raw ChromeNode references via in-place mutation rather than
 * Schema decode->mutate->encode. Schema.transform creates new objects on decode, breaking reference
 * chains to parent nodes in the tree. Surgical patches require mutable references to the original
 * nodes so that modifications propagate through the tree without parent/index tracking.
 * New nodes are constructed with required Chrome metadata (guid, id, timestamps).
 */
export const applyPatches = (
  bookmarksPath: string,
  patches: ReadonlyArray<Patch.BookmarkPatch>,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => Bun.file(bookmarksPath).text(),
      catch: (cause) => new Error(`Failed to read Chrome bookmarks at ${bookmarksPath}`, { cause }),
    });

    const file = parseChromeBookmarksFile(text, bookmarksPath);
    if (patches.length === 0) return;
    yield* ensureNoSyncMetadata(file, bookmarksPath);
    const { roots } = file;

    // Track next sequential ID for new nodes
    let nextId = findMaxId(roots) + 1;
    const claimed = yield* Effect.try({
      try: () => {
        for (const patch of patches) {
          Patch.$match(patch, {
            Add: ({ path }) => void parseDomainPath(path),
            Remove: ({ path }) => void parseDomainPath(path),
            Update: ({ fromPath, toPath }) => {
              parseDomainPath(fromPath);
              parseDomainPath(toPath);
            },
          });
        }

        const claimedSources: ChromeNode[] = [];
        return patches.map((patch) => {
          const source = Patch.$match(patch, {
            Add: () => undefined,
            Remove: ({ url, name, path }) => claimNode(roots, url, name, path, claimedSources),
            Update: ({ url, oldName, fromPath }) =>
              claimNode(roots, url, oldName, fromPath, claimedSources),
          });
          if (!Patch.$is("Add")(patch) && !source) {
            throw new Error(`Missing Chrome bookmark source for ${patch._tag} "${patch.url}".`);
          }
          if (source) claimedSources.push(source);
          return { patch, source };
        });
      },
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error("Failed to prepare Chrome bookmark patches.", { cause }),
    });
    const sorted = Patch.sortForApplyBy(claimed, (item) => item.patch);

    for (const item of sorted) {
      Patch.$match(item.patch, {
        Add: ({ url, name, path }) => {
          const { chromeKey, folderPath } = parseDomainPath(path);
          const rootNode = roots[chromeKey];
          rootNode.children ??= [];
          const parent = ensureFolderPath(rootNode.children, folderPath, () => nextId++);
          const ts = nowChromeTimestamp();
          const newLeaf: ChromeNode = {
            type: "url",
            name,
            url,
            id: String(nextId++),
            guid: crypto.randomUUID(),
            date_added: ts,
            date_last_used: "0",
          };
          parent.push(newLeaf);
        },
        Remove: () => {
          if (item.source) extractNodeReference(roots, item.source);
        },
        Update: ({ url, newName, fromPath, toPath }) => {
          if (!item.source) return;
          if (fromPath === toPath) {
            item.source.name = newName;
            return;
          }
          const removed = extractNodeReference(roots, item.source);
          if (removed) {
            removed.name = newName;
            removed.url = url;
            const { chromeKey, folderPath } = parseDomainPath(toPath);
            const rootNode = roots[chromeKey];
            rootNode.children ??= [];
            const parent = ensureFolderPath(rootNode.children, folderPath, () => nextId++);
            parent.push(removed);
          }
        },
      });
    }

    // Recalculate checksum
    file.checksum = calculateChecksum(roots);

    // Serialize and write atomically
    const serialized = JSON.stringify(file, null, 3);
    const tmpPath = `${bookmarksPath}.tmp.${Date.now()}`;

    yield* Effect.tryPromise({
      try: async () => {
        await Bun.write(tmpPath, serialized);
        await rename(tmpPath, bookmarksPath);
      },
      catch: (cause) =>
        new Error(`Failed to write Chrome bookmarks at ${bookmarksPath}`, { cause }),
    });
  });

export const writeTree = (bookmarksPath: string, tree: BookmarkTree): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => Bun.file(bookmarksPath).text(),
      catch: (cause) => new Error(`Failed to read Chrome bookmarks at ${bookmarksPath}`, { cause }),
    });

    const file = parseChromeBookmarksFile(text, bookmarksPath);
    if (file.sync_metadata) {
      const currentTree = yield* decodeBookmarkTree(file, bookmarksPath);
      if (bookmarkTreesEqual(currentTree, tree)) return;
      return yield* Effect.fail(syncMetadataMutationError(bookmarksPath));
    }
    const { roots } = file;
    let nextId = findMaxId(roots) + 1;
    const existing = collectChromeNodes(roots);
    const leafAssignments = assignChromeLeaves(tree, existing);
    const leafAssignmentIndex = { value: 0 };

    roots.bookmark_bar.children = buildChromeChildren(
      tree.bar,
      "bar",
      existing,
      leafAssignments,
      leafAssignmentIndex,
      () => nextId++,
    );
    roots.other.children = buildChromeChildren(
      tree.menu,
      "menu",
      existing,
      leafAssignments,
      leafAssignmentIndex,
      () => nextId++,
    );
    roots.synced.children = buildChromeChildren(
      tree.mobile,
      "mobile",
      existing,
      leafAssignments,
      leafAssignmentIndex,
      () => nextId++,
    );

    file.checksum = calculateChecksum(roots);

    const serialized = JSON.stringify(file, null, 3);
    const tmpPath = `${bookmarksPath}.tmp.${Date.now()}`;

    yield* Effect.tryPromise({
      try: async () => {
        await Bun.write(tmpPath, serialized);
        await rename(tmpPath, bookmarksPath);
      },
      catch: (cause) =>
        new Error(`Failed to write Chrome bookmarks at ${bookmarksPath}`, { cause }),
    });
  });

// -- Read path helpers (Schema-driven decoding) --

interface ChromeNodeLookup {
  readonly foldersByPath: Map<string, ChromeNode>;
  readonly leavesByExactKey: Map<string, ChromeNode[]>;
  readonly leavesByUrl: Map<string, ChromeNode[]>;
}

const leafExactKey = (url: string, name: string, path: string): string =>
  JSON.stringify([url, name, path]);

const appendLookupNode = (
  lookup: Map<string, ChromeNode[]>,
  key: string,
  node: ChromeNode,
): void => {
  const nodes = lookup.get(key);
  if (nodes) nodes.push(node);
  else lookup.set(key, [node]);
};

const collectChromeNodes = (roots: ChromeRoot): ChromeNodeLookup => {
  const lookup: ChromeNodeLookup = {
    foldersByPath: new Map(),
    leavesByExactKey: new Map(),
    leavesByUrl: new Map(),
  };

  for (const [chromeKey, sectionKey] of chromeSections) {
    const rootNode = roots[chromeKey];
    collectChromeChildren(rootNode.children ?? [], sectionKey, lookup);
  }

  return lookup;
};

const collectChromeChildren = (
  children: ChromeNode[],
  parentPath: string,
  lookup: ChromeNodeLookup,
): void => {
  for (const child of children) {
    if (child.type === "url" && child.url) {
      appendLookupNode(
        lookup.leavesByExactKey,
        leafExactKey(child.url, child.name, parentPath),
        child,
      );
      appendLookupNode(lookup.leavesByUrl, child.url, child);
      continue;
    }

    if (child.type === "folder") {
      const folderPath = `${parentPath}/${child.name}`;
      lookup.foldersByPath.set(folderPath, child);
      collectChromeChildren(child.children ?? [], folderPath, lookup);
    }
  }
};

const takeFirstAvailable = (
  nodes: ChromeNode[] | undefined,
  used: readonly ChromeNode[],
): ChromeNode | undefined => nodes?.find((node) => !used.includes(node));

const collectDomainLeaves = (
  nodes: BookmarkSection | undefined,
  path: string,
  leaves: Array<{ readonly leaf: BookmarkLeaf; readonly path: string }>,
): void => {
  for (const node of nodes ?? []) {
    if (BookmarkLeaf.is(node)) {
      leaves.push({ leaf: node, path });
    } else {
      collectDomainLeaves(node.children, `${path}/${node.name}`, leaves);
    }
  }
};

const assignChromeLeaves = (
  tree: BookmarkTree,
  lookup: ChromeNodeLookup,
): readonly (ChromeNode | undefined)[] => {
  const desired: Array<{ readonly leaf: BookmarkLeaf; readonly path: string }> = [];
  collectDomainLeaves(tree.bar, "bar", desired);
  collectDomainLeaves(tree.menu, "menu", desired);
  collectDomainLeaves(tree.mobile, "mobile", desired);

  const assignments: Array<ChromeNode | undefined> = desired.map(() => undefined);
  const used: ChromeNode[] = [];

  for (let index = 0; index < desired.length; index++) {
    const entry = desired[index];
    if (!entry) continue;
    const candidate = takeFirstAvailable(
      lookup.leavesByExactKey.get(leafExactKey(entry.leaf.url, entry.leaf.name, entry.path)),
      used,
    );
    if (!candidate) continue;
    assignments[index] = candidate;
    used.push(candidate);
  }

  for (let index = 0; index < desired.length; index++) {
    if (assignments[index]) continue;
    const entry = desired[index];
    if (!entry) continue;
    const candidate = takeFirstAvailable(lookup.leavesByUrl.get(entry.leaf.url), used);
    if (!candidate) continue;
    assignments[index] = candidate;
    used.push(candidate);
  }

  return assignments;
};

const makeChromeLeaf = (leaf: BookmarkLeaf, allocateId: () => number): ChromeNode => {
  const ts = nowChromeTimestamp();
  return {
    type: "url",
    name: leaf.name,
    url: leaf.url,
    id: String(allocateId()),
    guid: crypto.randomUUID(),
    date_added: ts,
    date_last_used: "0",
  };
};

const makeChromeFolder = (name: string, allocateId: () => number): ChromeNode => {
  const ts = nowChromeTimestamp();
  return {
    type: "folder",
    name,
    children: [],
    id: String(allocateId()),
    guid: crypto.randomUUID(),
    date_added: ts,
    date_modified: ts,
    date_last_used: "0",
  };
};

const buildChromeChildren = (
  nodes: BookmarkSection | undefined,
  parentPath: string,
  lookup: ChromeNodeLookup,
  leafAssignments: readonly (ChromeNode | undefined)[],
  leafAssignmentIndex: { value: number },
  allocateId: () => number,
): ChromeNode[] =>
  (nodes ?? []).map((node) => {
    if (BookmarkLeaf.is(node)) {
      const existing = leafAssignments[leafAssignmentIndex.value];
      leafAssignmentIndex.value += 1;
      if (existing) {
        existing.name = node.name;
        existing.url = node.url;
        return existing;
      }

      return makeChromeLeaf(node, allocateId);
    }

    const folderPath = `${parentPath}/${node.name}`;
    const existing = lookup.foldersByPath.get(folderPath);
    const folder = existing ?? makeChromeFolder(node.name, allocateId);
    folder.name = node.name;
    folder.children = buildChromeChildren(
      node.children,
      folderPath,
      lookup,
      leafAssignments,
      leafAssignmentIndex,
      allocateId,
    );
    lookup.foldersByPath.delete(folderPath);
    return folder;
  });

const scanNodes = (children: ChromeNode[], path: string): BookmarkIssue[] => {
  const issues: BookmarkIssue[] = [];

  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (!child) continue;
    const itemPath = `${path}/[${index + 1}]`;

    if (child.type === "url") continue;

    if (child.type === "folder") {
      issues.push(...scanNodes(child.children ?? [], `${path}/${child.name}`));
      continue;
    }

    if (child.type === "separator") {
      issues.push(
        separatorIssue(
          itemPath,
          "Imported Chrome separators would be dropped during sync. Remove them manually before retrying.",
        ),
      );
      continue;
    }

    issues.push(
      unsupportedNodeIssue(
        itemPath,
        `Unsupported Chrome bookmark node type "${String(child.type)}" would be dropped during sync.`,
      ),
    );
  }

  return issues;
};

function decodeNodes(children: ChromeNode[]): BookmarkNode[] {
  const nodes: BookmarkNode[] = [];
  for (const child of children) {
    if (child.type === "url") {
      nodes.push(Schema.decodeUnknownSync(ChromeLeafTransform)(child));
    } else if (child.type === "folder") {
      nodes.push(Schema.decodeUnknownSync(ChromeFolderTransform)(child));
    }
  }
  return nodes;
}

// -- Write path helpers (raw JSON mutation -- see applyPatches architecture note) --

/** Parse a domain path like "bar/Dev" into Chrome root key + folder path. */
const parseDomainPath = (path: string): { chromeKey: keyof ChromeRoot; folderPath: string[] } => {
  const [sectionKey, ...rest] = path.split("/");
  if (sectionKey !== "bar" && sectionKey !== "menu" && sectionKey !== "mobile") {
    throw new Error(`Invalid Chrome bookmark path "${path}".`);
  }
  const chromeKey = SECTION_TO_CHROME_KEY[sectionKey];
  return { chromeKey, folderPath: rest };
};

/** Walk or create nested folders, returning the final children array. */
const ensureFolderPath = (
  children: ChromeNode[],
  folderPath: string[],
  allocateId: () => number,
): ChromeNode[] => {
  let current = children;
  for (const folderName of folderPath) {
    const existing = current.find((c) => c.type === "folder" && c.name === folderName);
    if (existing) {
      existing.children ??= [];
      current = existing.children;
    } else {
      const ts = nowChromeTimestamp();
      const newFolder: ChromeNode = {
        type: "folder",
        name: folderName,
        children: [],
        id: String(allocateId()),
        guid: crypto.randomUUID(),
        date_added: ts,
        date_modified: ts,
        date_last_used: "0",
      };
      current.push(newFolder);
      current = expectDefined(newFolder.children, "Expected Chrome folder children array");
    }
  }
  return current;
};

const childrenAtPath = (roots: ChromeRoot, path: string): ChromeNode[] | undefined => {
  const { chromeKey, folderPath } = parseDomainPath(path);
  const rootChildren = roots[chromeKey].children;
  if (!rootChildren) return undefined;
  let children = rootChildren;

  for (const folderName of folderPath) {
    const folder = children.find((node) => node.type === "folder" && node.name === folderName);
    if (!folder?.children) return undefined;
    children = folder.children;
  }

  return children;
};

const claimNode = (
  roots: ChromeRoot,
  url: string,
  name: string,
  path: string,
  claimed: readonly ChromeNode[],
): ChromeNode | undefined => {
  const children = childrenAtPath(roots, path);
  return children?.find(
    (node) =>
      node.type === "url" && node.url === url && node.name === name && !claimed.includes(node),
  );
};

const findNodeReferenceLocationInChildren = (
  children: ChromeNode[],
  target: ChromeNode,
): { readonly children: ChromeNode[]; readonly index: number } | undefined => {
  for (let index = 0; index < children.length; index++) {
    const node = children[index];
    if (node === target) return { children, index };
    if (node?.children) {
      const nested = findNodeReferenceLocationInChildren(node.children, target);
      if (nested) return nested;
    }
  }
  return undefined;
};

const extractNodeReference = (roots: ChromeRoot, target: ChromeNode): ChromeNode | undefined => {
  for (const key of ["bookmark_bar", "other", "synced"] as const) {
    const children = roots[key].children;
    if (!children) continue;
    const location = findNodeReferenceLocationInChildren(children, target);
    if (location) return location.children.splice(location.index, 1)[0];
  }
  return undefined;
};

/** Find the maximum numeric ID across all nodes in the roots. */
const findMaxId = (roots: ChromeRoot): number => {
  let maxId = 0;
  const walk = (node: ChromeNode): void => {
    const id = parseInt(node.id, 10);
    if (id > maxId) maxId = id;
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  };
  walk(roots.bookmark_bar);
  walk(roots.other);
  walk(roots.synced);
  return maxId;
};
