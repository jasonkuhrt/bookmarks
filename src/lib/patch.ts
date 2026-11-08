/**
 * Domain-specific bookmark patch types and generation.
 *
 * Patches are the intermediate representation between "what changed"
 * and "apply the change." Source/target occurrence tuples are conflict keys,
 * so one URL can have multiple independently placed occurrences.
 *
 * Key data structures:
 * - BookmarkIndex (HashMap<string, BookmarkEntry[]>) — URL-keyed occurrence groups, used for diffing
 * - BookmarkTrie (BookmarkTree) — structural working copy, used for applying patches
 */

import {
  Array as Arr,
  Data,
  DateTime,
  Effect,
  HashMap,
  HashSet,
  Option,
  Order,
  pipe,
} from "effect";
import type { BookmarkNode, BookmarkSection } from "./schema/__.ts";
import { BookmarkFolder, BookmarkLeaf, BookmarkTree } from "./schema/__.ts";

// -- Patch types (Data.TaggedEnum) --

export type BookmarkPatch = Data.TaggedEnum<{
  Add: {
    readonly url: string;
    readonly name: string;
    readonly path: string;
    readonly date: DateTime.Utc;
  };
  Remove: {
    readonly url: string;
    readonly name: string;
    readonly path: string;
    readonly date: DateTime.Utc;
  };
  Update: {
    readonly url: string;
    readonly oldName: string;
    readonly newName: string;
    readonly fromPath: string;
    readonly toPath: string;
    readonly date: DateTime.Utc;
  };
}>;

export const { Add, Remove, Update, $is, $match } = Data.taggedEnum<BookmarkPatch>();

const applyPriority: Record<BookmarkPatch["_tag"], number> = {
  Remove: 0,
  Update: 1,
  Add: 2,
};

export const sortForApplyBy = <A>(
  items: readonly A[],
  patchOf: (item: A) => BookmarkPatch,
): readonly A[] =>
  Arr.sort(
    items,
    Order.mapInput(Order.number, (item: A) => applyPriority[patchOf(item)._tag]),
  );

// -- BookmarkEntry (for URL-keyed diffing) --

export interface BookmarkEntry {
  readonly url: string;
  readonly name: string;
  readonly path: string;
}

export type BookmarkIndex = HashMap.HashMap<string, readonly BookmarkEntry[]>;

export interface DuplicateCounts {
  readonly urlGroups: number;
  readonly extraPlacements: number;
}

// -- BookmarkTrie (for structural patch application) --

export type BookmarkTrie = BookmarkTree;

// -- Section keys for tree traversal --

const sectionKeys = ["bar", "menu", "reading_list", "mobile"] as const;

// -- flatten: BookmarkTree → BookmarkIndex (URL-keyed) --

export interface FlattenResult {
  readonly index: BookmarkIndex;
  readonly duplicates: DuplicateCounts;
}

/** Flatten a BookmarkTree into URL-keyed occurrence groups in canonical traversal order. */
export const flatten = (tree: BookmarkTree): FlattenResult => {
  let index = HashMap.empty<string, readonly BookmarkEntry[]>();

  const visit = (nodes: BookmarkSection | undefined, path: string): void => {
    if (!nodes) return;
    for (const node of nodes) {
      if (BookmarkLeaf.is(node)) {
        const occurrences = pipe(
          HashMap.get(index, node.url),
          Option.getOrElse<readonly BookmarkEntry[]>(() => []),
        );
        index = HashMap.set(index, node.url, [
          ...occurrences,
          { url: node.url, name: node.name, path },
        ]);
      } else if (BookmarkFolder.is(node)) {
        visit(node.children, path === "" ? node.name : `${path}/${node.name}`);
      }
    }
  };

  for (const key of sectionKeys) {
    visit(tree[key], key);
  }

  let urlGroups = 0;
  let extraPlacements = 0;
  HashMap.forEach(index, (occurrences) => {
    if (occurrences.length < 2) return;
    urlGroups += 1;
    extraPlacements += occurrences.length - 1;
  });

  return { index, duplicates: { urlGroups, extraPlacements } };
};

export const countDuplicates = (tree: BookmarkTree): DuplicateCounts => flatten(tree).duplicates;

const cloneNode = (node: BookmarkNode): BookmarkNode =>
  BookmarkLeaf.is(node)
    ? BookmarkLeaf.make({ name: node.name, url: node.url })
    : BookmarkFolder.make({
        name: node.name,
        children: cloneSection(node.children) ?? [],
      });

const cloneSection = (nodes: BookmarkSection | undefined): BookmarkSection | undefined =>
  nodes?.map((node) => cloneNode(node));

// -- toTrie: BookmarkTree → BookmarkTrie --

/** Clone a BookmarkTree into a structural working copy. */
export const toTrie = (tree: BookmarkTree): BookmarkTrie =>
  BookmarkTree.make({
    bar: cloneSection(tree.bar),
    menu: cloneSection(tree.menu),
    reading_list: cloneSection(tree.reading_list),
    mobile: cloneSection(tree.mobile),
  });

// -- fromTrie: BookmarkTrie → BookmarkTree --

/** Clone the working tree back into a BookmarkTree value. */
export const fromTrie = (trie: BookmarkTrie): BookmarkTree => toTrie(trie);

// -- generatePatches --

/** Generate patches by diffing last-sync state against current state. */
export const generatePatches = (
  lastSync: BookmarkTree,
  current: BookmarkTree,
  _currentSource: string,
  dates?: HashMap.HashMap<string, DateTime.Utc>,
  _lastSyncSource = "existing state",
): Effect.Effect<readonly BookmarkPatch[], Error> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const { index: lastIndex } = flatten(lastSync);
    const { index: currentIndex } = flatten(current);
    const patches: BookmarkPatch[] = [];

    const dateFor = (url: string): DateTime.Utc =>
      dates
        ? pipe(
            HashMap.get(dates, url),
            Option.getOrElse(() => now),
          )
        : now;

    let urls = HashSet.empty<string>();
    for (const url of HashMap.keys(lastIndex)) urls = HashSet.add(urls, url);
    for (const url of HashMap.keys(currentIndex)) urls = HashSet.add(urls, url);

    for (const url of [...urls].sort()) {
      const previous = pipe(
        HashMap.get(lastIndex, url),
        Option.getOrElse<readonly BookmarkEntry[]>(() => []),
      );
      const next = pipe(
        HashMap.get(currentIndex, url),
        Option.getOrElse<readonly BookmarkEntry[]>(() => []),
      );

      const unmatchedPrevious = [...previous];
      const unmatchedNext: BookmarkEntry[] = [];

      // Preserve unchanged occurrences before pairing edits. This keeps one changed
      // duplicate from stealing the identity of an unchanged sibling.
      for (const entry of next) {
        const exactIndex = unmatchedPrevious.findIndex(
          (candidate) => candidate.path === entry.path && candidate.name === entry.name,
        );
        if (exactIndex === -1) {
          unmatchedNext.push(entry);
        } else {
          unmatchedPrevious.splice(exactIndex, 1);
        }
      }

      const pairedCount = Math.min(unmatchedPrevious.length, unmatchedNext.length);
      for (let index = 0; index < pairedCount; index++) {
        const prev = unmatchedPrevious[index];
        const entry = unmatchedNext[index];
        if (!prev || !entry) continue;

        if (prev.path !== entry.path || prev.name !== entry.name) {
          patches.push(
            Update({
              url,
              oldName: prev.name,
              newName: entry.name,
              fromPath: prev.path,
              toPath: entry.path,
              date: dateFor(url),
            }),
          );
        }
      }

      for (const entry of unmatchedPrevious.slice(pairedCount)) {
        patches.push(Remove({ url, name: entry.name, path: entry.path, date: dateFor(url) }));
      }

      for (const entry of unmatchedNext.slice(pairedCount)) {
        patches.push(Add({ url, name: entry.name, path: entry.path, date: dateFor(url) }));
      }
    }

    return patches;
  });
