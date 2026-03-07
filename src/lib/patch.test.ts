import { describe, expect, test } from "bun:test";
import { DateTime, Effect, HashMap, Option } from "effect";
import { BookmarkFolder, BookmarkLeaf, type BookmarkNode, BookmarkTree } from "./schema/__.ts";
import * as Patch from "./patch.ts";

// -- Test helpers --

const leaf = (name: string, url: string) => new BookmarkLeaf({ name, url });
const folder = (name: string, children: Array<BookmarkLeaf | BookmarkFolder>) =>
  new BookmarkFolder({ name, children });

const emptyTree = () => new BookmarkTree({});

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);

const expectDefined = <T>(value: T | undefined, message: string): T => {
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
};

const expectLeaf = (value: BookmarkNode | undefined, message: string): BookmarkLeaf => {
  const node = expectDefined(value, message);
  expect(BookmarkLeaf.is(node)).toBe(true);
  if (!BookmarkLeaf.is(node)) {
    throw new Error(message);
  }
  return node;
};

const expectFolder = (value: BookmarkNode | undefined, message: string): BookmarkFolder => {
  const node = expectDefined(value, message);
  expect(BookmarkFolder.is(node)).toBe(true);
  if (!BookmarkFolder.is(node)) {
    throw new Error(message);
  }
  return node;
};

const expectRejects = async (promise: Promise<unknown>, message: string): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected rejection containing "${message}"`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error(`Expected Error, received ${String(error)}`, { cause: error });
    }
    expect(error.message).toContain(message);
  }
};

// -- flatten --

describe("flatten", () => {
  test("empty tree produces empty index", () => {
    const result = Patch.flatten(emptyTree());
    expect(HashMap.size(result.index)).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  test("flattens leaves across sections", () => {
    const tree = new BookmarkTree({
      bar: [leaf("A", "https://a.com")],
      menu: [leaf("B", "https://b.com")],
    });
    const result = Patch.flatten(tree);
    expect(HashMap.size(result.index)).toBe(2);

    const a = HashMap.get(result.index, "https://a.com");
    expect(Option.isSome(a)).toBe(true);
    if (Option.isSome(a)) {
      expect(a.value.name).toBe("A");
      expect(a.value.path).toBe("bar");
    }
  });

  test("flattens nested folders with correct path", () => {
    const tree = new BookmarkTree({
      bar: [folder("AI", [folder("Tools", [leaf("ChatGPT", "https://chat.openai.com")])])],
    });
    const result = Patch.flatten(tree);
    const entry = HashMap.get(result.index, "https://chat.openai.com");
    expect(Option.isSome(entry)).toBe(true);
    if (Option.isSome(entry)) {
      expect(entry.value.path).toBe("bar/AI/Tools");
    }
  });

  test("duplicate URLs: first wins, produces warning", () => {
    const tree = new BookmarkTree({
      bar: [leaf("First", "https://dup.com")],
      menu: [leaf("Second", "https://dup.com")],
    });
    const result = Patch.flatten(tree);
    expect(HashMap.size(result.index)).toBe(1);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("Duplicate URL");

    const entry = HashMap.get(result.index, "https://dup.com");
    if (Option.isSome(entry)) {
      expect(entry.value.name).toBe("First");
    }
  });
});

// -- toTrie / fromTrie round-trip --

describe("toTrie / fromTrie", () => {
  test("round-trip preserves single leaf", () => {
    const tree = new BookmarkTree({
      bar: [leaf("A", "https://a.com")],
    });
    const result = Patch.fromTrie(Patch.toTrie(tree));
    const bar = expectDefined(result.bar, "expected bookmarks bar section");
    expect(bar.length).toBe(1);
    const node = expectLeaf(bar[0], "expected bookmark leaf");
    expect(node.name).toBe("A");
    expect(node.url).toBe("https://a.com");
  });

  test("round-trip preserves nested folders", () => {
    const tree = new BookmarkTree({
      bar: [
        folder("AI", [
          leaf("GPT", "https://gpt.com"),
          folder("Research", [leaf("Papers", "https://papers.com")]),
        ]),
      ],
      menu: [leaf("News", "https://news.com")],
    });
    const result = Patch.fromTrie(Patch.toTrie(tree));

    expect(result.bar).toBeDefined();
    expect(result.menu).toBeDefined();
    expect(result.reading_list).toBeUndefined();
    expect(result.mobile).toBeUndefined();

    // Check nested structure
    const bar = expectDefined(result.bar, "expected bookmarks bar section");
    const aiFolder = expectFolder(
      bar.find((node) => BookmarkFolder.is(node) && node.name === "AI"),
      'expected "AI" folder',
    );
    expect(aiFolder.children.length).toBe(2);
  });

  test("round-trip preserves sibling ordering and empty folders", () => {
    const tree = new BookmarkTree({
      bar: [
        leaf("First", "https://first.example"),
        folder("Empty", []),
        folder("Nested", [leaf("Inside", "https://inside.example")]),
        leaf("Last", "https://last.example"),
      ],
      menu: [folder("Other Empty", [])],
    });

    const result = Patch.fromTrie(Patch.toTrie(tree));

    expect(result).toEqual(tree);
  });

  test("round-trip with empty tree", () => {
    const tree = emptyTree();
    const result = Patch.fromTrie(Patch.toTrie(tree));
    expect(result.bar).toBeUndefined();
    expect(result.menu).toBeUndefined();
  });
});

// -- generatePatches --

describe("generatePatches", () => {
  test("first run (empty lastSync) produces only Add patches", async () => {
    const lastSync = emptyTree();
    const current = new BookmarkTree({
      bar: [leaf("A", "https://a.com"), leaf("B", "https://b.com")],
    });
    const patches = await run(Patch.generatePatches(lastSync, current, "yaml"));
    expect(patches.length).toBe(2);
    expect(patches.every(Patch.$is("Add"))).toBe(true);
  });

  test("removed bookmarks produce Remove patches", async () => {
    const lastSync = new BookmarkTree({
      bar: [leaf("A", "https://a.com"), leaf("B", "https://b.com")],
    });
    const current = new BookmarkTree({
      bar: [leaf("A", "https://a.com")],
    });
    const patches = await run(Patch.generatePatches(lastSync, current, "yaml"));
    const removes = patches.filter(Patch.$is("Remove"));
    expect(removes.length).toBe(1);
    expect(expectDefined(removes[0], "expected remove patch").url).toBe("https://b.com");
  });

  test("renamed bookmark produces Rename patch", async () => {
    const lastSync = new BookmarkTree({
      bar: [leaf("Old Name", "https://a.com")],
    });
    const current = new BookmarkTree({
      bar: [leaf("New Name", "https://a.com")],
    });
    const patches = await run(Patch.generatePatches(lastSync, current, "yaml"));
    const renames = patches.filter(Patch.$is("Rename"));
    expect(renames.length).toBe(1);
    const rename = expectDefined(renames[0], "expected rename patch");
    expect(rename.oldName).toBe("Old Name");
    expect(rename.newName).toBe("New Name");
  });

  test("moved bookmark produces Move patch", async () => {
    const lastSync = new BookmarkTree({
      bar: [leaf("A", "https://a.com")],
    });
    const current = new BookmarkTree({
      menu: [leaf("A", "https://a.com")],
    });
    const patches = await run(Patch.generatePatches(lastSync, current, "yaml"));
    const moves = patches.filter(Patch.$is("Move"));
    expect(moves.length).toBe(1);
    const move = expectDefined(moves[0], "expected move patch");
    expect(move.fromPath).toBe("bar");
    expect(move.toPath).toBe("menu");
  });

  test("moved + renamed in one produces both patches", async () => {
    const lastSync = new BookmarkTree({
      bar: [leaf("Old", "https://a.com")],
    });
    const current = new BookmarkTree({
      menu: [leaf("New", "https://a.com")],
    });
    const patches = await run(Patch.generatePatches(lastSync, current, "yaml"));
    expect(patches.filter(Patch.$is("Move")).length).toBe(1);
    expect(patches.filter(Patch.$is("Rename")).length).toBe(1);
  });

  test("no changes produces empty patches", async () => {
    const tree = new BookmarkTree({
      bar: [leaf("A", "https://a.com")],
    });
    const patches = await run(Patch.generatePatches(tree, tree, "yaml"));
    expect(patches.length).toBe(0);
  });

  test("all patches have DateTime.Utc dates", async () => {
    const lastSync = emptyTree();
    const current = new BookmarkTree({
      bar: [leaf("A", "https://a.com")],
    });
    const patches = await run(Patch.generatePatches(lastSync, current, "yaml"));
    for (const p of patches) {
      expect(DateTime.isDateTime(p.date)).toBe(true);
    }
  });

  test("duplicate URLs fail patch generation instead of silently collapsing", async () => {
    const current = new BookmarkTree({
      bar: [leaf("First", "https://dup.example"), leaf("Second", "https://dup.example")],
    });

    await expectRejects(
      run(Patch.generatePatches(emptyTree(), current, "yaml")),
      'Duplicate URL "https://dup.example"',
    );
  });
});
