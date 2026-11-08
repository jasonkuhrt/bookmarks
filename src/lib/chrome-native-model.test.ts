import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import * as ChromeNativeModel from "./chrome-native-model.ts";
import { BookmarkFolder, BookmarkLeaf, BookmarkTree } from "./schema/__.ts";

const rejectionOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the promise to reject.");
};

interface MutableChromeNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  children?: MutableChromeNode[];
  folderType?: ChromeNativeModel.ChromeFolderType;
  syncing?: boolean;
  unmodifiable?: "managed";
  dateAdded?: number;
  dateGroupModified?: number;
}

type MutationCall =
  | { readonly operation: "create"; readonly id: string }
  | { readonly operation: "update"; readonly id: string }
  | { readonly operation: "move"; readonly id: string }
  | { readonly operation: "remove"; readonly id: string };

const leaf = (name: string, url: string): BookmarkLeaf => BookmarkLeaf.make({ name, url });
const folder = (name: string, children: readonly (BookmarkLeaf | BookmarkFolder)[]) =>
  BookmarkFolder.make({ name, children });

const nativeLeaf = (id: string, title: string, url: string): MutableChromeNode => ({
  id,
  title,
  url,
  dateAdded: 123,
});

const nativeFolder = (
  id: string,
  title: string,
  children: readonly MutableChromeNode[] = [],
  properties: Partial<MutableChromeNode> = {},
): MutableChromeNode => ({ id, title, children: [...children], ...properties });

const rootTree = (
  bar: readonly MutableChromeNode[] = [],
  menu: readonly MutableChromeNode[] = [],
  mobile: readonly MutableChromeNode[] = [],
  extraRoots: readonly MutableChromeNode[] = [],
): MutableChromeNode[] => [
  nativeFolder("0", "root", [
    nativeFolder("bar", "Bookmarks bar", bar, {
      folderType: "bookmarks-bar",
      syncing: true,
    }),
    nativeFolder("other", "Other bookmarks", menu, { folderType: "other", syncing: true }),
    nativeFolder("mobile", "Mobile bookmarks", mobile, {
      folderType: "mobile",
      syncing: true,
    }),
    ...extraRoots,
  ]),
];

const cloneNode = (node: MutableChromeNode): ChromeNativeModel.ChromeBookmarkNode => ({
  id: node.id,
  title: node.title,
  ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
  ...(node.index !== undefined ? { index: node.index } : {}),
  ...(node.url !== undefined ? { url: node.url } : {}),
  ...(node.children ? { children: node.children.map(cloneNode) } : {}),
  ...(node.folderType ? { folderType: node.folderType } : {}),
  ...(node.syncing !== undefined ? { syncing: node.syncing } : {}),
  ...(node.unmodifiable ? { unmodifiable: node.unmodifiable } : {}),
  ...(node.dateAdded !== undefined ? { dateAdded: node.dateAdded } : {}),
  ...(node.dateGroupModified !== undefined ? { dateGroupModified: node.dateGroupModified } : {}),
});

const memoryApi = (initialTree: MutableChromeNode[]) => {
  const tree = initialTree;
  const calls: MutationCall[] = [];
  let nextId = 1;

  const refreshRelationships = (): void => {
    const visit = (node: MutableChromeNode): void => {
      node.children?.forEach((child, index) => {
        child.parentId = node.id;
        child.index = index;
        visit(child);
      });
    };
    tree.forEach(visit);
  };

  const find = (
    id: string,
  ):
    | {
        readonly node: MutableChromeNode;
        readonly siblings: MutableChromeNode[];
        readonly index: number;
      }
    | undefined => {
    const visit = (nodes: MutableChromeNode[]): ReturnType<typeof find> => {
      const index = nodes.findIndex((node) => node.id === id);
      const match = nodes[index];
      if (match) return { node: match, siblings: nodes, index };
      for (const node of nodes) {
        const found = node.children ? visit(node.children) : undefined;
        if (found) return found;
      }
      return undefined;
    };
    return visit(tree);
  };

  refreshRelationships();
  const api: ChromeNativeModel.ChromeBookmarksApi = {
    getTree: () => Effect.sync(() => tree.map(cloneNode)),
    create: (details) =>
      Effect.try({
        try: () => {
          const parent = find(details.parentId)?.node;
          if (!parent?.children) throw new Error(`Missing folder ${details.parentId}`);
          const node: MutableChromeNode = {
            id: `created-${nextId++}`,
            title: details.title,
            ...(details.url !== undefined ? { url: details.url } : { children: [] }),
          };
          parent.children.splice(details.index ?? parent.children.length, 0, node);
          refreshRelationships();
          calls.push({ operation: "create", id: node.id });
          return cloneNode(node);
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    update: (id, changes) =>
      Effect.try({
        try: () => {
          const node = find(id)?.node;
          if (!node) throw new Error(`Missing node ${id}`);
          if (changes.title !== undefined) node.title = changes.title;
          if (changes.url !== undefined) node.url = changes.url;
          calls.push({ operation: "update", id });
          return cloneNode(node);
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    move: (id, destination) =>
      Effect.try({
        try: () => {
          const found = find(id);
          const parent = find(destination.parentId)?.node;
          if (!found || !parent?.children) throw new Error(`Cannot move ${id}`);
          found.siblings.splice(found.index, 1);
          parent.children.splice(destination.index, 0, found.node);
          refreshRelationships();
          calls.push({ operation: "move", id });
          return cloneNode(found.node);
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    remove: (id) =>
      Effect.try({
        try: () => {
          const found = find(id);
          if (!found) throw new Error(`Missing node ${id}`);
          if ((found.node.children?.length ?? 0) > 0) throw new Error(`Folder ${id} is not empty`);
          found.siblings.splice(found.index, 1);
          refreshRelationships();
          calls.push({ operation: "remove", id });
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
  };

  return { api, calls, find };
};

const runWith = <A>(
  effect: Effect.Effect<A, Error, ChromeNativeModel.ChromeBookmarksApi>,
  api: ChromeNativeModel.ChromeBookmarksApi,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.succeed(ChromeNativeModel.ChromeBookmarks, api))),
  );

describe("Chrome native bookmark model", () => {
  test("selects current typed roots explicitly and leaves the managed root outside the model", () => {
    const localBar = nativeFolder(
      "local-bar",
      "Local bar",
      [nativeLeaf("local", "Local", "https://local.example")],
      {
        folderType: "bookmarks-bar",
        syncing: false,
      },
    );
    const managed = nativeFolder(
      "managed",
      "Managed",
      [nativeLeaf("policy", "Policy", "https://policy.example")],
      {
        folderType: "managed",
        unmodifiable: "managed",
      },
    );
    const tree = rootTree(
      [nativeLeaf("synced", "Synced", "https://synced.example")],
      [],
      [],
      [localBar, managed],
    ).map(cloneNode);

    expect(() => ChromeNativeModel.toBookmarkTree(tree)).toThrow("multiple bookmarks-bar");
    expect(ChromeNativeModel.toBookmarkTree(tree, { rootSelection: "prefer-syncing" }).bar).toEqual(
      [leaf("Synced", "https://synced.example")],
    );

    const legacyTree = [
      nativeFolder("0", "root", [
        nativeFolder("1", "bar", [nativeLeaf("legacy", "Legacy", "https://legacy.example")]),
        nativeFolder("2", "other"),
        nativeFolder("3", "mobile"),
      ]),
    ].map(cloneNode);
    expect(ChromeNativeModel.toBookmarkTree(legacyTree).bar).toEqual([
      leaf("Legacy", "https://legacy.example"),
    ]);

    const onlyLocalRoot = rootTree([nativeLeaf("only", "Only", "https://only.example")]);
    const onlyLocalBar = onlyLocalRoot[0]?.children?.[0];
    if (!onlyLocalBar) throw new Error("Expected the bar root.");
    onlyLocalBar.syncing = false;
    expect(
      ChromeNativeModel.toBookmarkTree(onlyLocalRoot.map(cloneNode), {
        rootSelection: "prefer-syncing",
      }).bar,
    ).toEqual([leaf("Only", "https://only.example")]);
  });

  test("reconciles in place while preserving duplicate identities and adding before removal", async () => {
    const initial = rootTree([
      nativeFolder("folder-a", "Projects", [
        nativeLeaf("alpha", "Alpha", "https://shared.example"),
        nativeLeaf("old", "Old", "https://old.example"),
      ]),
      nativeFolder("folder-b", "Later", [nativeLeaf("beta", "Beta", "https://shared.example")]),
      nativeLeaf("obsolete", "Obsolete", "https://obsolete.example"),
      nativeFolder("trash", "Trash", [
        nativeLeaf("trash-leaf", "Trash leaf", "https://trash.example"),
      ]),
    ]);
    const store = memoryApi(initial);
    const expected = await runWith(
      ChromeNativeModel.snapshot({ rootSelection: "prefer-syncing" }),
      store.api,
    );
    const desired = BookmarkTree.make({
      bar: [
        folder("Renamed Projects", [
          leaf("Beta", "https://shared.example"),
          leaf("New", "https://new.example"),
        ]),
        folder("Later", [leaf("Alpha", "https://shared.example")]),
      ],
      menu: [],
      mobile: [],
    });

    const result = await runWith(
      ChromeNativeModel.reconcile(expected, desired, { rootSelection: "prefer-syncing" }),
      store.api,
    );

    expect(result).toEqual(desired);
    expect(store.find("folder-a")?.node.title).toBe("Renamed Projects");
    expect(store.find("beta")?.node.parentId).toBe("folder-a");
    expect(store.find("alpha")?.node.parentId).toBe("folder-b");
    expect(store.find("alpha")?.node.dateAdded).toBe(123);
    expect(store.find("beta")?.node.dateAdded).toBe(123);
    const operations = store.calls.map((call) => call.operation);
    expect(operations.indexOf("create")).toBeLessThan(operations.indexOf("remove"));
    expect(store.find("old")).toBeUndefined();
    expect(store.find("obsolete")).toBeUndefined();
    expect(store.find("trash")).toBeUndefined();
    expect(store.calls.findIndex((call) => call.id === "trash-leaf")).toBeLessThan(
      store.calls.findIndex((call) => call.id === "trash"),
    );
  });

  test("rejects a stale precondition before calling any mutation", async () => {
    const store = memoryApi(rootTree([nativeLeaf("live", "Live", "https://live.example")]));
    const stale = BookmarkTree.make({
      bar: [leaf("Stale", "https://stale.example")],
      menu: [],
      mobile: [],
    });
    const desired = BookmarkTree.make({
      bar: [leaf("Desired", "https://desired.example")],
      menu: [],
      mobile: [],
    });

    expect(
      await rejectionOf(
        runWith(
          ChromeNativeModel.reconcile(stale, desired, { rootSelection: "prefer-syncing" }),
          store.api,
        ),
      ),
    ).toContain("changed after planning");
    expect(store.calls).toEqual([]);
  });

  test("reserves exact duplicate matches before assigning renamed occurrences", async () => {
    const store = memoryApi(
      rootTree([
        nativeLeaf("keep", "Keep", "https://duplicate.example"),
        nativeLeaf("rename", "Old", "https://duplicate.example"),
      ]),
    );
    const expected = await runWith(
      ChromeNativeModel.snapshot({ rootSelection: "prefer-syncing" }),
      store.api,
    );
    const desired = BookmarkTree.make({
      bar: [
        leaf("Renamed", "https://duplicate.example"),
        leaf("Keep", "https://duplicate.example"),
      ],
      menu: [],
      mobile: [],
    });

    await runWith(
      ChromeNativeModel.reconcile(expected, desired, { rootSelection: "prefer-syncing" }),
      store.api,
    );

    expect(store.find("keep")?.node.title).toBe("Keep");
    expect(store.find("keep")?.node.index).toBe(1);
    expect(store.find("rename")?.node.title).toBe("Renamed");
    expect(store.find("rename")?.node.index).toBe(0);
    expect(store.calls.some((call) => call.operation === "create")).toBe(false);
    expect(store.calls.some((call) => call.operation === "remove")).toBe(false);
  });

  test("preserves an unmodifiable descendant by refusing a changing reconciliation", async () => {
    const locked = nativeLeaf("locked", "Policy", "https://policy.example");
    locked.unmodifiable = "managed";
    const store = memoryApi(rootTree([locked]));
    const expected = await runWith(
      ChromeNativeModel.snapshot({ rootSelection: "prefer-syncing" }),
      store.api,
    );
    const desired = BookmarkTree.make({ bar: [], menu: [], mobile: [] });

    expect(
      await rejectionOf(
        runWith(
          ChromeNativeModel.reconcile(expected, desired, { rootSelection: "prefer-syncing" }),
          store.api,
        ),
      ),
    ).toContain("managed or unmodifiable");
    expect(store.calls).toEqual([]);
    expect(store.find("locked")?.node.id).toBe("locked");
  });
});
