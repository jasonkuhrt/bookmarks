/**
 * Safari plist adapter.
 *
 * Reads Safari's Bookmarks.plist and extracts a clean BookmarkTree (lossy — discards Safari metadata).
 * Applies BookmarkPatch[] surgically to the native plist structure (preserves all metadata).
 * Handles binary plist parsing/serialization and atomic file writes.
 */

import { parse } from "@plist/binary.parse";
import { serialize } from "@plist/binary.serialize";
import { Effect, Schema } from "effect";
import { rename } from "node:fs/promises";
import * as Patch from "./patch.ts";
import type { BookmarkNode, BookmarkSection } from "./schema/__.ts";
import { BookmarkFolder, BookmarkLeaf, BookmarkTree } from "./schema/__.ts";
import { separatorIssue, UnsupportedBookmarks, unsupportedNodeIssue } from "./unsupported.ts";
import type { BookmarkIssue } from "./unsupported.ts";

// -- Plist type aliases (matches @plist/common; avoids direct dependency on internal package) --

type PlistValue =
  | null
  | string
  | number
  | bigint
  | boolean
  | ArrayBuffer
  | Date
  | PlistDict
  | PlistValue[];
type PlistDict = { [key: string]: PlistValue };

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isPlistDict = (value: unknown): value is PlistDict =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof ArrayBuffer) &&
  !(value instanceof Date);

const isPlistDictArray = (value: unknown): value is PlistDict[] =>
  Array.isArray(value) && value.every((item) => isPlistDict(item));

const plistString = (dict: PlistDict, key: string): string | undefined => {
  const value = dict[key];
  return typeof value === "string" ? value : undefined;
};

const plistDict = (dict: PlistDict, key: string): PlistDict | undefined => {
  const value = dict[key];
  return isPlistDict(value) ? value : undefined;
};

const plistDictChildren = (dict: PlistDict): PlistDict[] | undefined => {
  const children = dict["Children"];
  return isPlistDictArray(children) ? children : undefined;
};

const ensurePlistChildren = (dict: PlistDict): PlistValue[] => {
  const children = dict["Children"];
  if (Array.isArray(children)) return children;

  const nextChildren: PlistValue[] = [];
  dict["Children"] = nextChildren;
  return nextChildren;
};

const parsePlistRoot = (data: ArrayBuffer, plistPath: string): PlistDict => {
  try {
    const root = parse(data);
    if (!isPlistDict(root)) {
      throw new Error("Parsed plist root is not a dictionary.");
    }
    return root;
  } catch (error) {
    throw new Error(
      `Failed to parse Safari bookmarks at ${plistPath}: ${messageFromUnknown(error)}`,
      { cause: error },
    );
  }
};

const readRootChildren = (root: PlistDict, plistPath: string): PlistDict[] => {
  const children = plistDictChildren(root);
  if (!children) {
    throw new Error(`Safari bookmarks at ${plistPath} are missing a root Children array.`);
  }
  return children;
};

const decodeUnknownChildren = (children: readonly unknown[] | undefined): BookmarkNode[] => {
  if (!children) return [];

  const plistChildren: PlistDict[] = [];
  for (const child of children) {
    if (isPlistDict(child)) {
      plistChildren.push(child);
    }
  }

  return decodeNodes(plistChildren);
};

const makeSafariLeafNode = (url: string, title: string): PlistDict => ({
  WebBookmarkType: "WebBookmarkTypeLeaf",
  WebBookmarkUUID: crypto.randomUUID().toUpperCase(),
  URLString: url,
  URIDictionary: { title },
});

const makeSafariFolderNode = (title: string): PlistDict => ({
  WebBookmarkType: "WebBookmarkTypeList",
  WebBookmarkUUID: crypto.randomUUID().toUpperCase(),
  Title: title,
  Children: [],
});

// -- Safari plist ↔ domain Schema transforms (read path: lossy, discards Safari metadata) --

const SafariLeafTransform = Schema.transform(
  Schema.Struct({
    WebBookmarkType: Schema.Literal("WebBookmarkTypeLeaf"),
    URLString: Schema.String,
    URIDictionary: Schema.Struct({ title: Schema.String }),
  }),
  BookmarkLeaf,
  {
    strict: true,
    decode: (plist) => ({
      _tag: "BookmarkLeaf" as const,
      url: plist.URLString,
      name: plist.URIDictionary.title,
    }),
    encode: (leaf) => ({
      WebBookmarkType: "WebBookmarkTypeLeaf" as const,
      URLString: leaf.url,
      URIDictionary: { title: leaf.name },
    }),
  },
);

const SafariFolderTransform = Schema.transform(
  Schema.Struct({
    WebBookmarkType: Schema.Literal("WebBookmarkTypeList"),
    Title: Schema.String,
    Children: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
  BookmarkFolder,
  {
    strict: false,
    decode: (plist) => ({
      _tag: "BookmarkFolder" as const,
      name: plist.Title,
      children: decodeUnknownChildren(plist.Children),
    }),
    encode: (folder) => ({
      WebBookmarkType: "WebBookmarkTypeList" as const,
      Title: folder.name,
      Children: folder.children,
    }),
  },
);

// -- Safari section Title ↔ domain section key mappings --

const SECTION_TITLE_TO_KEY: Record<string, keyof Omit<BookmarkTree, "_tag">> = {
  BookmarksBar: "bar",
  "com.apple.ReadingList": "reading_list",
};

const SECTION_KEY_TO_TITLE: Record<string, string> = {
  bar: "BookmarksBar",
  menu: "BookmarksMenu",
  reading_list: "com.apple.ReadingList",
};

// -- readBookmarks --

/** Read Safari bookmarks from a binary plist path into a clean BookmarkTree. */
export const readBookmarks = (plistPath: string): Effect.Effect<BookmarkTree, Error> =>
  Effect.gen(function* () {
    const data = yield* Effect.tryPromise({
      try: () => Bun.file(plistPath).arrayBuffer(),
      catch: (cause) => new Error(`Failed to read plist at ${plistPath}`, { cause }),
    });

    const root = parsePlistRoot(data, plistPath);
    const children = readRootChildren(root, plistPath);
    const issues = scanNodes(children, "root");

    const sections: Partial<Record<"bar" | "menu" | "reading_list" | "mobile", BookmarkSection>> =
      {};

    for (const child of children) {
      const type = plistString(child, "WebBookmarkType");
      if (type === "WebBookmarkTypeProxy") continue;

      const title = plistString(child, "Title");
      const sectionKey = title ? SECTION_TITLE_TO_KEY[title] : undefined;
      const sectionChildren = plistDictChildren(child);

      if (sectionKey && sectionChildren) {
        // Standard section (BookmarksBar, ReadingList)
        sections[sectionKey] = decodeNodes(sectionChildren);
      } else if (title === "BookmarksMenu") {
        // BookmarksMenu maps to "menu" — its children merge with root-level extras
        sections.menu ??= [];
        if (sectionChildren) {
          sections.menu = [...sections.menu, ...decodeNodes(sectionChildren)];
        }
      } else if (type === "WebBookmarkTypeList") {
        // Root-level folder outside standard sections → append to "menu"
        sections.menu ??= [];
        sections.menu = [...sections.menu, Schema.decodeUnknownSync(SafariFolderTransform)(child)];
      } else if (type === "WebBookmarkTypeLeaf") {
        // Root-level leaf → append to "menu"
        sections.menu ??= [];
        sections.menu = [...sections.menu, Schema.decodeUnknownSync(SafariLeafTransform)(child)];
      }
    }

    if (issues.length > 0) {
      return yield* Effect.fail(
        new UnsupportedBookmarks({
          source: `Safari bookmarks at ${plistPath}`,
          issues,
        }),
      );
    }

    return BookmarkTree.make({
      bar: sections.bar,
      menu: sections.menu,
      reading_list: sections.reading_list,
    });
  });

// -- applyPatches --

/**
 * Apply bookmark patches surgically to an existing Safari plist, preserving all metadata.
 *
 * Architecture note: this operates on raw PlistDict references via in-place mutation rather than
 * Schema decode→mutate→encode. Schema.transform creates new objects on decode, breaking reference
 * chains to parent nodes in the tree. Surgical patches require mutable references to the original
 * nodes so that modifications propagate through the tree without parent/index tracking.
 * Schema-derived constructors (SafariLeafNode.make, SafariFolderNode.make) are used for new nodes.
 */
export const applyPatches = (
  plistPath: string,
  patches: ReadonlyArray<Patch.BookmarkPatch>,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const data = yield* Effect.tryPromise({
      try: () => Bun.file(plistPath).arrayBuffer(),
      catch: (cause) => new Error(`Failed to read plist at ${plistPath}`, { cause }),
    });

    const root = parsePlistRoot(data, plistPath);
    const children = readRootChildren(root, plistPath);

    for (const patch of patches) {
      Patch.$match(patch, {
        Add: ({ url, name, path }) => {
          const { sectionTitle, folderPath } = parseDomainPath(path);
          const sectionChildren = findOrCreateSectionChildren(children, sectionTitle);
          const parent = ensureFolderPath(sectionChildren, folderPath);
          parent.push(makeSafariLeafNode(url, name));
        },
        Remove: ({ url }) => {
          removeLeafByUrl(children, url);
        },
        Rename: ({ url, newName }) => {
          const leaf = findLeafByUrl(children, url);
          if (leaf) {
            const uriDict = plistDict(leaf, "URIDictionary") ?? {};
            uriDict["title"] = newName;
            leaf["URIDictionary"] = uriDict;
          }
        },
        Move: ({ url, toPath }) => {
          const removed = extractLeafByUrl(children, url);
          if (removed) {
            const { sectionTitle, folderPath } = parseDomainPath(toPath);
            const sectionChildren = findOrCreateSectionChildren(children, sectionTitle);
            const parent = ensureFolderPath(sectionChildren, folderPath);
            parent.push(removed);
          }
        },
      });
    }

    // Serialize and write atomically
    const serialized = serialize(root);
    const tmpPath = `${plistPath}.tmp.${Date.now()}`;

    yield* Effect.tryPromise({
      try: async () => {
        await Bun.write(tmpPath, serialized);
        await rename(tmpPath, plistPath);
      },
      catch: (cause) => new Error(`Failed to write plist at ${plistPath}`, { cause }),
    });
  });

export const writeTree = (plistPath: string, tree: BookmarkTree): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const data = yield* Effect.tryPromise({
      try: () => Bun.file(plistPath).arrayBuffer(),
      catch: (cause) => new Error(`Failed to read plist at ${plistPath}`, { cause }),
    });

    const root = parsePlistRoot(data, plistPath);
    const children = readRootChildren(root, plistPath);
    const lookup = collectSafariNodes(children);

    const favoritesSection = reuseOrCreateSectionNode(lookup, "BookmarksBar");
    const otherSection = reuseOrCreateSectionNode(lookup, "BookmarksMenu");
    const readingListSection = reuseOrCreateSectionNode(lookup, "com.apple.ReadingList");

    setSectionChildren(favoritesSection, buildSafariChildren(tree.bar, "bar", lookup));
    setSectionChildren(otherSection, buildSafariChildren(tree.menu, "menu", lookup));
    setSectionChildren(
      readingListSection,
      buildSafariChildren(tree.reading_list, "reading_list", lookup),
    );

    root["Children"] = [
      favoritesSection,
      otherSection,
      readingListSection,
      ...lookup.unmanagedRootChildren,
    ];

    const serialized = serialize(root);
    const tmpPath = `${plistPath}.tmp.${Date.now()}`;

    yield* Effect.tryPromise({
      try: async () => {
        await Bun.write(tmpPath, serialized);
        await rename(tmpPath, plistPath);
      },
      catch: (cause) => new Error(`Failed to write plist at ${plistPath}`, { cause }),
    });
  });

// -- Read path helpers (Schema-driven decoding) --

interface SafariNodeLookup {
  readonly foldersByPath: Map<string, PlistDict>;
  readonly leavesByUrl: Map<string, PlistDict>;
  readonly sectionsByTitle: Map<string, PlistDict>;
  readonly unmanagedRootChildren: PlistDict[];
}

const collectSafariNodes = (rootChildren: PlistDict[]): SafariNodeLookup => {
  const lookup: SafariNodeLookup = {
    foldersByPath: new Map(),
    leavesByUrl: new Map(),
    sectionsByTitle: new Map(),
    unmanagedRootChildren: [],
  };

  for (const child of rootChildren) {
    const type = plistString(child, "WebBookmarkType");
    const title = plistString(child, "Title");
    const childNodes = plistDictChildren(child) ?? [];

    if (type === "WebBookmarkTypeProxy") {
      lookup.unmanagedRootChildren.push(child);
      continue;
    }

    if (type === "WebBookmarkTypeList" && title === "BookmarksBar") {
      lookup.sectionsByTitle.set(title, child);
      collectSafariChildren(childNodes, "bar", lookup);
      continue;
    }

    if (type === "WebBookmarkTypeList" && title === "BookmarksMenu") {
      lookup.sectionsByTitle.set(title, child);
      collectSafariChildren(childNodes, "menu", lookup);
      continue;
    }

    if (type === "WebBookmarkTypeList" && title === "com.apple.ReadingList") {
      lookup.sectionsByTitle.set(title, child);
      collectSafariChildren(childNodes, "reading_list", lookup);
      continue;
    }

    if (type === "WebBookmarkTypeLeaf") {
      const url = plistString(child, "URLString");
      if (url) lookup.leavesByUrl.set(url, child);
      continue;
    }

    if (type === "WebBookmarkTypeList" && title) {
      const folderPath = `menu/${title}`;
      lookup.foldersByPath.set(folderPath, child);
      collectSafariChildren(childNodes, folderPath, lookup);
      continue;
    }

    lookup.unmanagedRootChildren.push(child);
  }

  return lookup;
};

const collectSafariChildren = (
  nodes: PlistDict[],
  parentPath: string,
  lookup: SafariNodeLookup,
): void => {
  for (const node of nodes) {
    const type = plistString(node, "WebBookmarkType");
    if (type === "WebBookmarkTypeLeaf") {
      const url = plistString(node, "URLString");
      if (url) lookup.leavesByUrl.set(url, node);
      continue;
    }

    if (type === "WebBookmarkTypeList") {
      const title = plistString(node, "Title");
      if (!title) continue;
      const folderPath = `${parentPath}/${title}`;
      lookup.foldersByPath.set(folderPath, node);
      collectSafariChildren(plistDictChildren(node) ?? [], folderPath, lookup);
    }
  }
};

const reuseOrCreateSectionNode = (lookup: SafariNodeLookup, title: string): PlistDict =>
  lookup.sectionsByTitle.get(title) ?? makeSafariFolderNode(title);

const setSectionChildren = (section: PlistDict, children: PlistDict[]): void => {
  if (children.length > 0) {
    section["Children"] = children;
  } else {
    delete section["Children"];
  }
};

const buildSafariChildren = (
  nodes: BookmarkSection | undefined,
  parentPath: string,
  lookup: SafariNodeLookup,
): PlistDict[] =>
  (nodes ?? []).map((node) => {
    if (BookmarkLeaf.is(node)) {
      const existing = lookup.leavesByUrl.get(node.url);
      if (existing) {
        existing["URLString"] = node.url;
        const uriDict = plistDict(existing, "URIDictionary") ?? {};
        uriDict["title"] = node.name;
        existing["URIDictionary"] = uriDict;
        lookup.leavesByUrl.delete(node.url);
        return existing;
      }

      return makeSafariLeafNode(node.url, node.name);
    }

    const folderPath = `${parentPath}/${node.name}`;
    const existing = lookup.foldersByPath.get(folderPath);
    const folder = existing ?? makeSafariFolderNode(node.name);

    folder["Title"] = node.name;
    folder["Children"] = buildSafariChildren(node.children, folderPath, lookup);
    lookup.foldersByPath.delete(folderPath);
    return folder;
  });

const scanNodes = (children: PlistDict[], path: string): BookmarkIssue[] => {
  const issues: BookmarkIssue[] = [];

  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (!child) continue;

    const type = plistString(child, "WebBookmarkType") ?? "";
    const title = typeof child["Title"] === "string" ? child["Title"] : undefined;
    const itemPath = title ? `${path}/${title}` : `${path}/[${index + 1}]`;

    if (type === "WebBookmarkTypeLeaf") continue;

    if (type === "WebBookmarkTypeList") {
      issues.push(...scanNodes(plistDictChildren(child) ?? [], itemPath));
      continue;
    }

    if (type === "WebBookmarkTypeProxy" && title === "History") {
      continue;
    }

    if (type.includes("Separator") || (title?.toLowerCase().includes("separator") ?? false)) {
      issues.push(
        separatorIssue(
          itemPath,
          `Safari bookmark node type "${type}" would be dropped during sync.`,
        ),
      );
      continue;
    }

    issues.push(
      unsupportedNodeIssue(
        itemPath,
        `Unsupported Safari bookmark node type "${type}" would be dropped during sync.`,
      ),
    );
  }

  return issues;
};

function decodeNodes(children: PlistDict[]): BookmarkNode[] {
  const nodes: BookmarkNode[] = [];
  for (const child of children) {
    const type = plistString(child, "WebBookmarkType");
    if (type === "WebBookmarkTypeLeaf") {
      nodes.push(Schema.decodeUnknownSync(SafariLeafTransform)(child));
    } else if (type === "WebBookmarkTypeList") {
      nodes.push(Schema.decodeUnknownSync(SafariFolderTransform)(child));
    }
  }
  return nodes;
}

// -- Write path helpers (raw PlistDict mutation — see applyPatches architecture note) --

/** Parse a domain path like "bar/Dev" into Safari section title + folder path. */
const parseDomainPath = (path: string): { sectionTitle: string; folderPath: string[] } => {
  const [sectionKey = "menu", ...rest] = path.split("/");
  const sectionTitle = SECTION_KEY_TO_TITLE[sectionKey] ?? sectionKey;
  return { sectionTitle, folderPath: rest };
};

/** Find the Children array for a section by its Safari title, creating the section if needed. */
const findOrCreateSectionChildren = (
  rootChildren: PlistDict[],
  sectionTitle: string,
): PlistValue[] => {
  const section = rootChildren.find(
    (c) =>
      plistString(c, "Title") === sectionTitle &&
      plistString(c, "WebBookmarkType") === "WebBookmarkTypeList",
  );
  if (section) {
    // Safari omits Children entirely when empty — ensure it exists as a mutable array
    return ensurePlistChildren(section);
  }

  const newSection = makeSafariFolderNode(sectionTitle);
  rootChildren.push(newSection);
  return ensurePlistChildren(newSection);
};

/** Walk or create nested folders, returning the final Children array. */
const ensureFolderPath = (children: PlistValue[], folderPath: string[]): PlistValue[] => {
  let current = children;
  for (const folderName of folderPath) {
    const existing = current.find(
      (child): child is PlistDict =>
        isPlistDict(child) &&
        plistString(child, "WebBookmarkType") === "WebBookmarkTypeList" &&
        plistString(child, "Title") === folderName,
    );
    if (existing) {
      current = ensurePlistChildren(existing);
    } else {
      const newFolder = makeSafariFolderNode(folderName);
      current.push(newFolder);
      current = ensurePlistChildren(newFolder);
    }
  }
  return current;
};

/** Find a leaf node by URL anywhere in the tree. */
const findLeafByUrl = (nodes: PlistDict[], url: string): PlistDict | undefined => {
  for (const node of nodes) {
    if (
      plistString(node, "WebBookmarkType") === "WebBookmarkTypeLeaf" &&
      plistString(node, "URLString") === url
    ) {
      return node;
    }
    const children = plistDictChildren(node);
    if (children) {
      const found = findLeafByUrl(children, url);
      if (found) return found;
    }
  }
  return undefined;
};

/** Remove a leaf by URL from anywhere in the tree. Returns true if removed. */
const removeLeafByUrl = (nodes: PlistDict[], url: string): boolean => {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;

    if (
      plistString(node, "WebBookmarkType") === "WebBookmarkTypeLeaf" &&
      plistString(node, "URLString") === url
    ) {
      nodes.splice(i, 1);
      return true;
    }
    const children = plistDictChildren(node);
    if (children && removeLeafByUrl(children, url)) return true;
  }
  return false;
};

/** Extract (remove and return) a leaf by URL from anywhere in the tree. */
const extractLeafByUrl = (nodes: PlistDict[], url: string): PlistDict | undefined => {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;

    if (
      plistString(node, "WebBookmarkType") === "WebBookmarkTypeLeaf" &&
      plistString(node, "URLString") === url
    ) {
      nodes.splice(i, 1);
      return node;
    }
    const children = plistDictChildren(node);
    if (children) {
      const found = extractLeafByUrl(children, url);
      if (found) return found;
    }
  }
  return undefined;
};
