/**
 * Safari plist adapter.
 *
 * Reads Safari's Bookmarks.plist and extracts a clean BookmarkTree (lossy — discards Safari metadata).
 * Applies BookmarkPatch[] surgically to the native plist structure (preserves all metadata).
 * Handles binary plist parsing/serialization and atomic file writes.
 */

import { parse } from "@plist/binary.parse"
import { serialize } from "@plist/binary.serialize"
import { Effect, Schema } from "effect"
import { rename } from "node:fs/promises"
import * as Patch from "./patch.js"
import { BookmarkLeaf, BookmarkFolder, BookmarkNode, BookmarkSection, BookmarkTree } from "./schema/__.js"
import type { WorkspaceNode, WorkspaceTree } from "./schema/workspace.js"
import { separatorIssue, UnsupportedBookmarks, unsupportedNodeIssue } from "./unsupported.js"
import type { BookmarkIssue } from "./unsupported.js"
import type { ImportedOccurrence, ImportedTargetSnapshot } from "./workspace-types.js"

// -- Plist type aliases (matches @plist/common; avoids direct dependency on internal package) --

type PlistValue = null | string | number | bigint | boolean | ArrayBuffer | Date | PlistDict | PlistValue[]
type PlistDict = { [key: string]: PlistValue }

// -- Safari plist node schemas (for type-safe construction of new nodes) --

const SafariLeafNode = Schema.Struct({
  WebBookmarkType: Schema.Literal("WebBookmarkTypeLeaf").pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => "WebBookmarkTypeLeaf" as const),
  ),
  WebBookmarkUUID: Schema.String.pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => crypto.randomUUID().toUpperCase()),
  ),
  URLString: Schema.String,
  URIDictionary: Schema.Struct({ title: Schema.String }),
})

const SafariFolderNode = Schema.Struct({
  WebBookmarkType: Schema.Literal("WebBookmarkTypeList").pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => "WebBookmarkTypeList" as const),
  ),
  WebBookmarkUUID: Schema.String.pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => crypto.randomUUID().toUpperCase()),
  ),
  Title: Schema.String,
  Children: Schema.Array(Schema.Unknown),
})

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
    decode: (plist) => ({ _tag: "BookmarkLeaf" as const, url: plist.URLString, name: plist.URIDictionary.title }),
    encode: (leaf) => ({
      WebBookmarkType: "WebBookmarkTypeLeaf" as const,
      URLString: leaf.url,
      URIDictionary: { title: leaf.name },
    }),
  },
)

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
      children: plist.Children ? decodeNodes(plist.Children as PlistDict[]) : [],
    }),
    encode: (folder) => ({
      WebBookmarkType: "WebBookmarkTypeList" as const,
      Title: folder.name,
      Children: folder.children as any,
    }),
  },
)

// -- Safari section Title ↔ domain section key mappings --

const SECTION_TITLE_TO_KEY: Record<string, keyof Omit<BookmarkTree, "_tag">> = {
  BookmarksBar: "favorites_bar",
  "com.apple.ReadingList": "reading_list",
}

const SECTION_KEY_TO_TITLE: Record<string, string> = {
  favorites_bar: "BookmarksBar",
  other: "BookmarksMenu",
  reading_list: "com.apple.ReadingList",
}

// -- readBookmarks --

/** Read Safari bookmarks from a binary plist path into a clean BookmarkTree. */
export const readBookmarks = (plistPath: string): Effect.Effect<BookmarkTree, Error> =>
  Effect.gen(function* () {
    const data = yield* Effect.tryPromise({
      try: () => Bun.file(plistPath).arrayBuffer(),
      catch: (cause) => new Error(`Failed to read plist at ${plistPath}`, { cause }),
    })

    const root = parse(data) as PlistDict
    const children = root["Children"] as PlistDict[]
    const issues = scanNodes(children, "root")

    const sections: Partial<Record<"favorites_bar" | "other" | "reading_list" | "mobile", BookmarkSection>> = {}

    for (const child of children) {
      const type = child["WebBookmarkType"] as string
      if (type === "WebBookmarkTypeProxy") continue

      const title = child["Title"] as string
      const sectionKey = SECTION_TITLE_TO_KEY[title]

      if (sectionKey && child["Children"]) {
        // Standard section (BookmarksBar, ReadingList)
        sections[sectionKey] = decodeNodes(child["Children"] as PlistDict[])
      } else if (title === "BookmarksMenu") {
        // BookmarksMenu maps to "other" — its children merge with root-level extras
        if (!sections.other) sections.other = []
        const menuChildren = child["Children"] as PlistDict[] | undefined
        if (menuChildren) {
          sections.other = [...sections.other, ...decodeNodes(menuChildren)]
        }
      } else if (type === "WebBookmarkTypeList") {
        // Root-level folder outside standard sections → append to "other"
        if (!sections.other) sections.other = []
        sections.other = [...sections.other, Schema.decodeUnknownSync(SafariFolderTransform)(child)]
      } else if (type === "WebBookmarkTypeLeaf") {
        // Root-level leaf → append to "other"
        if (!sections.other) sections.other = []
        sections.other = [...sections.other, Schema.decodeUnknownSync(SafariLeafTransform)(child)]
      }
    }

    if (issues.length > 0) {
      return yield* Effect.fail(new UnsupportedBookmarks({
        source: `Safari bookmarks at ${plistPath}`,
        issues,
      }))
    }

    return BookmarkTree.make({
      favorites_bar: sections.favorites_bar,
      other: sections.other,
      reading_list: sections.reading_list,
    })
  })

const plistToJson = (value: PlistValue): unknown => {
  if (value === null) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", byteLength: value.byteLength }
  if (Array.isArray(value)) return value.map((entry) => plistToJson(entry))
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, plistToJson(entry)]),
  )
}

export const importBookmarks = (
  plistPath: string,
  targetId: string,
): Effect.Effect<ImportedTargetSnapshot, Error> =>
  Effect.gen(function* () {
    const data = yield* Effect.tryPromise({
      try: () => Bun.file(plistPath).arrayBuffer(),
      catch: (cause) => new Error(`Failed to read plist at ${plistPath}`, { cause }),
    })

    const root = parse(data) as PlistDict
    const children = (root["Children"] as PlistDict[] | undefined) ?? []
    const occurrences: ImportedOccurrence[] = []
    const targetToken = targetId.replaceAll("/", "__").replaceAll(/[^a-zA-Z0-9_]/g, "_")
    let nextNodeId = 1
    let nextOccurrenceId = 1

    const allocateNodeId = () => `node_${targetToken}_${nextNodeId++}`
    const allocateOccurrenceId = () => `occ_${targetToken}_${nextOccurrenceId++}`

    const importNodes = (
      nodes: PlistDict[],
      parentPath: readonly string[],
    ): WorkspaceNode[] =>
      nodes.map((node, index) => {
        const type = String(node["WebBookmarkType"] ?? "")
        const title = typeof node["Title"] === "string"
          ? node["Title"]
          : typeof (node["URIDictionary"] as PlistDict | undefined)?.["title"] === "string"
            ? String((node["URIDictionary"] as PlistDict)["title"])
            : `[${index + 1}]`
        const occurrenceId = allocateOccurrenceId()
        const itemPath = [...parentPath, title]
        const nativeId = typeof node["WebBookmarkUUID"] === "string"
          ? node["WebBookmarkUUID"]
          : null

        if (type === "WebBookmarkTypeLeaf") {
          const url = typeof node["URLString"] === "string" ? node["URLString"] : ""
          occurrences.push({
            id: occurrenceId,
            targetId,
            nativeId,
            kind: "bookmark",
            title,
            url,
            path: itemPath,
            nativeKinds: [type],
          })
          return {
            kind: "bookmark" as const,
            id: allocateNodeId(),
            title,
            url,
            sources: [occurrenceId],
          }
        }

        if (type === "WebBookmarkTypeList") {
          occurrences.push({
            id: occurrenceId,
            targetId,
            nativeId,
            kind: "folder",
            title,
            path: itemPath,
            nativeKinds: [type],
          })
          return {
            kind: "folder" as const,
            id: allocateNodeId(),
            title,
            children: importNodes((node["Children"] as PlistDict[] | undefined) ?? [], itemPath) ?? [],
            sources: [occurrenceId],
          }
        }

        if (type.includes("Separator") || title.toLowerCase().includes("separator")) {
          occurrences.push({
            id: occurrenceId,
            targetId,
            nativeId,
            kind: "separator",
            title,
            path: itemPath,
            nativeKinds: [type],
            payload: plistToJson(node),
          })
          return {
            kind: "separator" as const,
            id: allocateNodeId(),
            sources: [occurrenceId],
            note: `Imported Safari separator-like node "${type}"`,
          }
        }

        occurrences.push({
          id: occurrenceId,
          targetId,
          nativeId,
          kind: "raw",
          title,
          path: itemPath,
          nativeKinds: [type],
          payload: plistToJson(node),
        })
        return {
          kind: "raw" as const,
          id: allocateNodeId(),
          title,
          nativeKinds: [type],
          sources: [occurrenceId],
          note: `Imported unsupported Safari node type "${type}"`,
        }
      })

    const tree: WorkspaceTree = {}
    const other: WorkspaceNode[] = []

    for (const child of children) {
      const type = String(child["WebBookmarkType"] ?? "")
      const title = typeof child["Title"] === "string" ? child["Title"] : undefined
      const sectionKey = title ? SECTION_TITLE_TO_KEY[title] : undefined

      if (sectionKey && child["Children"]) {
        tree[sectionKey] = importNodes(child["Children"] as PlistDict[], [sectionKey])
        continue
      }

      if (title === "BookmarksMenu") {
        other.push(...importNodes((child["Children"] as PlistDict[] | undefined) ?? [], ["other"]))
        continue
      }

      if (type === "WebBookmarkTypeProxy" && title === "History") {
        other.push(...importNodes([child], ["other"]))
        continue
      }

      other.push(...importNodes([child], ["other"]))
    }

    if (other.length > 0) tree.other = other

    return { tree, occurrences }
  })

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
    })

    const root = parse(data) as PlistDict
    const children = root["Children"] as PlistDict[]

    for (const patch of patches) {
      Patch.$match(patch, {
        Add: ({ url, name, path }) => {
          const { sectionTitle, folderPath } = parseDomainPath(path)
          const sectionChildren = findOrCreateSectionChildren(children, sectionTitle)
          const parent = ensureFolderPath(sectionChildren, folderPath)
          parent.push(SafariLeafNode.make({ URLString: url, URIDictionary: { title: name } }))
        },
        Remove: ({ url }) => {
          removeLeafByUrl(children, url)
        },
        Rename: ({ url, newName }) => {
          const leaf = findLeafByUrl(children, url)
          if (leaf) {
            const uriDict = leaf["URIDictionary"] as PlistDict
            uriDict["title"] = newName
          }
        },
        Move: ({ url, toPath }) => {
          const removed = extractLeafByUrl(children, url)
          if (removed) {
            const { sectionTitle, folderPath } = parseDomainPath(toPath)
            const sectionChildren = findOrCreateSectionChildren(children, sectionTitle)
            const parent = ensureFolderPath(sectionChildren, folderPath)
            parent.push(removed)
          }
        },
      })
    }

    // Serialize and write atomically
    const serialized = serialize(root as PlistValue)
    const tmpPath = `${plistPath}.tmp.${Date.now()}`

    yield* Effect.tryPromise({
      try: async () => {
        await Bun.write(tmpPath, serialized)
        await rename(tmpPath, plistPath)
      },
      catch: (cause) => new Error(`Failed to write plist at ${plistPath}`, { cause }),
    })
  })

export const writeTree = (
  plistPath: string,
  tree: BookmarkTree,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const data = yield* Effect.tryPromise({
      try: () => Bun.file(plistPath).arrayBuffer(),
      catch: (cause) => new Error(`Failed to read plist at ${plistPath}`, { cause }),
    })

    const root = parse(data) as PlistDict
    const children = root["Children"] as PlistDict[]
    const lookup = collectSafariNodes(children)

    const favoritesSection = reuseOrCreateSectionNode(lookup, "BookmarksBar")
    const otherSection = reuseOrCreateSectionNode(lookup, "BookmarksMenu")
    const readingListSection = reuseOrCreateSectionNode(lookup, "com.apple.ReadingList")

    setSectionChildren(
      favoritesSection,
      buildSafariChildren(tree.favorites_bar, "favorites_bar", lookup),
    )
    setSectionChildren(
      otherSection,
      buildSafariChildren(tree.other, "other", lookup),
    )
    setSectionChildren(
      readingListSection,
      buildSafariChildren(tree.reading_list, "reading_list", lookup),
    )

    root["Children"] = [
      favoritesSection,
      otherSection,
      readingListSection,
      ...lookup.unmanagedRootChildren,
    ]

    const serialized = serialize(root as PlistValue)
    const tmpPath = `${plistPath}.tmp.${Date.now()}`

    yield* Effect.tryPromise({
      try: async () => {
        await Bun.write(tmpPath, serialized)
        await rename(tmpPath, plistPath)
      },
      catch: (cause) => new Error(`Failed to write plist at ${plistPath}`, { cause }),
    })
  })

// -- Read path helpers (Schema-driven decoding) --

interface SafariNodeLookup {
  readonly foldersByPath: Map<string, PlistDict>
  readonly leavesByUrl: Map<string, PlistDict>
  readonly sectionsByTitle: Map<string, PlistDict>
  readonly unmanagedRootChildren: PlistDict[]
}

const collectSafariNodes = (rootChildren: PlistDict[]): SafariNodeLookup => {
  const lookup: SafariNodeLookup = {
    foldersByPath: new Map(),
    leavesByUrl: new Map(),
    sectionsByTitle: new Map(),
    unmanagedRootChildren: [],
  }

  for (const child of rootChildren) {
    const type = child["WebBookmarkType"] as string
    const title = child["Title"] as string | undefined

    if (type === "WebBookmarkTypeProxy") {
      lookup.unmanagedRootChildren.push(child)
      continue
    }

    if (type === "WebBookmarkTypeList" && title === "BookmarksBar") {
      lookup.sectionsByTitle.set(title, child)
      collectSafariChildren((child["Children"] as PlistDict[] | undefined) ?? [], "favorites_bar", lookup)
      continue
    }

    if (type === "WebBookmarkTypeList" && title === "BookmarksMenu") {
      lookup.sectionsByTitle.set(title, child)
      collectSafariChildren((child["Children"] as PlistDict[] | undefined) ?? [], "other", lookup)
      continue
    }

    if (type === "WebBookmarkTypeList" && title === "com.apple.ReadingList") {
      lookup.sectionsByTitle.set(title, child)
      collectSafariChildren((child["Children"] as PlistDict[] | undefined) ?? [], "reading_list", lookup)
      continue
    }

    if (type === "WebBookmarkTypeLeaf") {
      const url = child["URLString"] as string | undefined
      if (url) lookup.leavesByUrl.set(url, child)
      continue
    }

    if (type === "WebBookmarkTypeList" && title) {
      const folderPath = `other/${title}`
      lookup.foldersByPath.set(folderPath, child)
      collectSafariChildren((child["Children"] as PlistDict[] | undefined) ?? [], folderPath, lookup)
      continue
    }

    lookup.unmanagedRootChildren.push(child)
  }

  return lookup
}

const collectSafariChildren = (
  nodes: PlistDict[],
  parentPath: string,
  lookup: SafariNodeLookup,
): void => {
  for (const node of nodes) {
    const type = node["WebBookmarkType"] as string
    if (type === "WebBookmarkTypeLeaf") {
      const url = node["URLString"] as string | undefined
      if (url) lookup.leavesByUrl.set(url, node)
      continue
    }

    if (type === "WebBookmarkTypeList") {
      const title = node["Title"] as string
      const folderPath = `${parentPath}/${title}`
      lookup.foldersByPath.set(folderPath, node)
      collectSafariChildren((node["Children"] as PlistDict[] | undefined) ?? [], folderPath, lookup)
    }
  }
}

const reuseOrCreateSectionNode = (lookup: SafariNodeLookup, title: string): PlistDict =>
  lookup.sectionsByTitle.get(title)
  ?? SafariFolderNode.make({ Title: title, Children: [] }) as unknown as PlistDict

const setSectionChildren = (section: PlistDict, children: PlistDict[]): void => {
  if (children.length > 0) {
    section["Children"] = children
  } else {
    delete section["Children"]
  }
}

const buildSafariChildren = (
  nodes: BookmarkSection | undefined,
  parentPath: string,
  lookup: SafariNodeLookup,
): PlistDict[] =>
  (nodes ?? []).map((node) => {
    if (BookmarkLeaf.is(node)) {
      const existing = lookup.leavesByUrl.get(node.url)
      if (existing) {
        existing["URLString"] = node.url
        const uriDict = (existing["URIDictionary"] as PlistDict | undefined) ?? {}
        uriDict["title"] = node.name
        existing["URIDictionary"] = uriDict
        lookup.leavesByUrl.delete(node.url)
        return existing
      }

      return SafariLeafNode.make({
        URLString: node.url,
        URIDictionary: { title: node.name },
      }) as unknown as PlistDict
    }

    const folderPath = `${parentPath}/${node.name}`
    const existing = lookup.foldersByPath.get(folderPath)
    const folder = existing ?? SafariFolderNode.make({
      Title: node.name,
      Children: [],
    }) as unknown as PlistDict

    folder["Title"] = node.name
    folder["Children"] = buildSafariChildren(
      node.children as BookmarkSection,
      folderPath,
      lookup,
    )
    lookup.foldersByPath.delete(folderPath)
    return folder
  })

const scanNodes = (children: PlistDict[], path: string): BookmarkIssue[] => {
  const issues: BookmarkIssue[] = []

  for (let index = 0; index < children.length; index++) {
    const child = children[index]!
    const type = String(child["WebBookmarkType"] ?? "")
    const title = typeof child["Title"] === "string" ? child["Title"] : undefined
    const itemPath = title ? `${path}/${title}` : `${path}/[${index + 1}]`

    if (type === "WebBookmarkTypeLeaf") continue

    if (type === "WebBookmarkTypeList") {
      issues.push(...scanNodes((child["Children"] as PlistDict[] | undefined) ?? [], itemPath))
      continue
    }

    if (type === "WebBookmarkTypeProxy" && title === "History") {
      continue
    }

    if (type.includes("Separator") || (title?.toLowerCase().includes("separator") ?? false)) {
      issues.push(separatorIssue(
        itemPath,
        `Safari bookmark node type "${type}" would be dropped during sync.`,
      ))
      continue
    }

    issues.push(unsupportedNodeIssue(
      itemPath,
      `Unsupported Safari bookmark node type "${type}" would be dropped during sync.`,
    ))
  }

  return issues
}

function decodeNodes(children: PlistDict[]): BookmarkNode[] {
  const nodes: BookmarkNode[] = []
  for (const child of children) {
    const type = child["WebBookmarkType"] as string
    if (type === "WebBookmarkTypeLeaf") {
      nodes.push(Schema.decodeUnknownSync(SafariLeafTransform)(child))
    } else if (type === "WebBookmarkTypeList") {
      nodes.push(Schema.decodeUnknownSync(SafariFolderTransform)(child))
    }
  }
  return nodes
}

// -- Write path helpers (raw PlistDict mutation — see applyPatches architecture note) --

/** Parse a domain path like "favorites_bar/Dev" into Safari section title + folder path. */
const parseDomainPath = (path: string): { sectionTitle: string; folderPath: string[] } => {
  const [sectionKey, ...rest] = path.split("/")
  const sectionTitle = SECTION_KEY_TO_TITLE[sectionKey!] ?? sectionKey!
  return { sectionTitle, folderPath: rest }
}

/** Find the Children array for a section by its Safari title, creating the section if needed. */
const findOrCreateSectionChildren = (rootChildren: PlistDict[], sectionTitle: string): PlistValue[] => {
  const section = rootChildren.find(
    (c) => (c["Title"] as string) === sectionTitle && (c["WebBookmarkType"] as string) === "WebBookmarkTypeList",
  )
  if (section) {
    // Safari omits Children entirely when empty — ensure it exists as a mutable array
    if (!section["Children"]) section["Children"] = []
    return section["Children"] as PlistValue[]
  }

  const newSection = SafariFolderNode.make({ Title: sectionTitle, Children: [] })
  rootChildren.push(newSection as unknown as PlistDict)
  return newSection.Children as unknown as PlistValue[]
}

/** Walk or create nested folders, returning the final Children array. */
const ensureFolderPath = (children: PlistValue[], folderPath: string[]): PlistValue[] => {
  let current = children
  for (const folderName of folderPath) {
    const existing = (current as PlistDict[]).find(
      (c) => (c["WebBookmarkType"] as string) === "WebBookmarkTypeList" && (c["Title"] as string) === folderName,
    )
    if (existing) {
      current = existing["Children"] as PlistValue[]
    } else {
      const newFolder = SafariFolderNode.make({ Title: folderName, Children: [] })
      current.push(newFolder as unknown as PlistDict)
      current = newFolder.Children as unknown as PlistValue[]
    }
  }
  return current
}

/** Find a leaf node by URL anywhere in the tree. */
const findLeafByUrl = (nodes: PlistDict[], url: string): PlistDict | undefined => {
  for (const node of nodes) {
    if ((node["WebBookmarkType"] as string) === "WebBookmarkTypeLeaf" && (node["URLString"] as string) === url) {
      return node
    }
    const children = node["Children"] as PlistDict[] | undefined
    if (children) {
      const found = findLeafByUrl(children, url)
      if (found) return found
    }
  }
  return undefined
}

/** Remove a leaf by URL from anywhere in the tree. Returns true if removed. */
const removeLeafByUrl = (nodes: PlistDict[], url: string): boolean => {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    if ((node["WebBookmarkType"] as string) === "WebBookmarkTypeLeaf" && (node["URLString"] as string) === url) {
      nodes.splice(i, 1)
      return true
    }
    const children = node["Children"] as PlistDict[] | undefined
    if (children && removeLeafByUrl(children, url)) return true
  }
  return false
}

/** Extract (remove and return) a leaf by URL from anywhere in the tree. */
const extractLeafByUrl = (nodes: PlistDict[], url: string): PlistDict | undefined => {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    if ((node["WebBookmarkType"] as string) === "WebBookmarkTypeLeaf" && (node["URLString"] as string) === url) {
      nodes.splice(i, 1)
      return node
    }
    const children = node["Children"] as PlistDict[] | undefined
    if (children) {
      const found = extractLeafByUrl(children, url)
      if (found) return found
    }
  }
  return undefined
}
