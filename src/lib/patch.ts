/**
 * Domain-specific bookmark patch types and generation.
 *
 * Patches are the intermediate representation between "what changed"
 * and "apply the change." URL is the identity key.
 *
 * Key data structures:
 * - BookmarkIndex (HashMap<string, BookmarkEntry>) — URL-keyed, used for diffing
 * - BookmarkTrie (BookmarkTree) — structural working copy, used for applying patches
 */

import { Data, DateTime, Effect, HashMap, Option, pipe } from "effect"
import { BookmarkFolder, BookmarkLeaf, BookmarkNode, BookmarkSection, BookmarkTree } from "./schema/__.js"

// -- Patch types (Data.TaggedEnum) --

export type BookmarkPatch = Data.TaggedEnum<{
  Add: { readonly url: string; readonly name: string; readonly path: string; readonly date: DateTime.Utc }
  Remove: { readonly url: string; readonly path: string; readonly date: DateTime.Utc }
  Rename: { readonly url: string; readonly oldName: string; readonly newName: string; readonly date: DateTime.Utc }
  Move: { readonly url: string; readonly fromPath: string; readonly toPath: string; readonly date: DateTime.Utc }
}>

export const { Add, Remove, Rename, Move, $is, $match } = Data.taggedEnum<BookmarkPatch>()

// -- BookmarkEntry (for URL-keyed diffing) --

export interface BookmarkEntry {
  readonly url: string
  readonly name: string
  readonly path: string
}

export type BookmarkIndex = HashMap.HashMap<string, BookmarkEntry>

// -- BookmarkTrie (for structural patch application) --

export type BookmarkTrie = BookmarkTree

// -- Section keys for tree traversal --

const sectionKeys = ["favorites_bar", "other", "reading_list", "mobile"] as const

// -- flatten: BookmarkTree → BookmarkIndex (URL-keyed) --

export interface FlattenResult {
  readonly index: BookmarkIndex
  readonly warnings: readonly string[]
}

/** Flatten a BookmarkTree into a URL-keyed HashMap for diffing. First occurrence wins on duplicates. */
export const flatten = (tree: BookmarkTree): FlattenResult => {
  const entries: Array<readonly [string, BookmarkEntry]> = []
  const warnings: Array<string> = []
  const seen = new Set<string>()

  const visit = (nodes: BookmarkSection | undefined, path: string): void => {
    if (!nodes) return
    for (const node of nodes) {
      if (BookmarkLeaf.is(node)) {
        if (seen.has(node.url)) {
          warnings.push(`Duplicate URL "${node.url}" at path "${path}" — keeping first occurrence`)
        } else {
          seen.add(node.url)
          entries.push([node.url, { url: node.url, name: node.name, path }])
        }
      } else if (BookmarkFolder.is(node)) {
        visit(node.children as BookmarkSection, path === "" ? node.name : `${path}/${node.name}`)
      }
    }
  }

  for (const key of sectionKeys) {
    visit(tree[key], key)
  }

  return { index: HashMap.fromIterable(entries), warnings }
}

const cloneNode = (node: BookmarkNode): BookmarkNode =>
  BookmarkLeaf.is(node)
    ? BookmarkLeaf.make({ name: node.name, url: node.url })
    : BookmarkFolder.make({
        name: node.name,
        children: cloneSection(node.children as BookmarkSection) ?? [],
      })

const cloneSection = (nodes: BookmarkSection | undefined): BookmarkSection | undefined =>
  nodes?.map((node) => cloneNode(node))

// -- toTrie: BookmarkTree → BookmarkTrie --

/** Clone a BookmarkTree into a structural working copy. */
export const toTrie = (tree: BookmarkTree): BookmarkTrie =>
  BookmarkTree.make({
    favorites_bar: cloneSection(tree.favorites_bar),
    other: cloneSection(tree.other),
    reading_list: cloneSection(tree.reading_list),
    mobile: cloneSection(tree.mobile),
  })

// -- fromTrie: BookmarkTrie → BookmarkTree --

/** Clone the working tree back into a BookmarkTree value. */
export const fromTrie = (trie: BookmarkTrie): BookmarkTree => toTrie(trie)

// -- generatePatches --

/** Generate patches by diffing last-sync state against current state. */
export const generatePatches = (
  lastSync: BookmarkTree,
  current: BookmarkTree,
  _source: string,
  dates?: HashMap.HashMap<string, DateTime.Utc>,
): Effect.Effect<readonly BookmarkPatch[], Error> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    const { index: lastIndex } = flatten(lastSync)
    const { index: currentIndex } = flatten(current)
    const patches: BookmarkPatch[] = []

    const dateFor = (url: string): DateTime.Utc =>
      dates
        ? pipe(HashMap.get(dates, url), Option.getOrElse(() => now))
        : now

    // URLs in current but not in lastSync → add
    // URLs in both → check for rename / move
    HashMap.forEach(currentIndex, (entry, url) => {
      const lastEntry = HashMap.get(lastIndex, url)
      if (Option.isNone(lastEntry)) {
        patches.push(Add({ url, name: entry.name, path: entry.path, date: dateFor(url) }))
      } else {
        const prev = lastEntry.value
        if (prev.path !== entry.path) {
          patches.push(Move({ url, fromPath: prev.path, toPath: entry.path, date: dateFor(url) }))
        }
        if (prev.name !== entry.name) {
          patches.push(Rename({ url, oldName: prev.name, newName: entry.name, date: dateFor(url) }))
        }
      }
    })

    // URLs in lastSync but not in current → remove
    HashMap.forEach(lastIndex, (entry, url) => {
      if (Option.isNone(HashMap.get(currentIndex, url))) {
        patches.push(Remove({ url, path: entry.path, date: dateFor(url) }))
      }
    })

    return patches
  })
