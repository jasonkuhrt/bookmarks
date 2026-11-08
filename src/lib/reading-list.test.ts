import { expect, test } from "bun:test";
import { Effect } from "effect";
import * as ReadingList from "./reading-list.ts";
import * as Fingerprint from "./fingerprint.ts";
import * as Graveyard from "./graveyard.ts";
import * as Yaml from "./yaml.ts";
import {
  BookmarkTree,
  BookmarksConfig,
  ReadingListItem,
  SharedBookmarks,
  TargetState,
} from "./schema/__.ts";

const item = (name = "A", read = false, url = "https://a.example/") =>
  ReadingListItem.make({ name, read, url });
const a = item();

test("one-sided addition is retained", () => {
  expect(ReadingList.merge([], [a], []).items).toEqual([a]);
  expect(ReadingList.merge([], [], [a]).items).toEqual([a]);
});
test("one side's field edit takes that side's value", () => {
  expect(ReadingList.merge([a], [item("YAML", true)], [a]).items).toEqual([item("YAML", true)]);
  expect(
    ReadingList.merge([item("A", true)], [item("A", true)], [item("Browser", false)]).items,
  ).toEqual([item("Browser", false)]);
});
test("independent name and read edits both survive", () => {
  expect(ReadingList.merge([a], [item("YAML")], [item("A", true)]).items).toEqual([
    item("YAML", true),
  ]);
});
test("conflicting names take the browser name", () => {
  expect(ReadingList.merge([a], [item("YAML")], [item("Browser")]).items).toEqual([
    item("Browser"),
  ]);
});
test("both sides adding one URL resolve fields once, with read true winning", () => {
  expect(ReadingList.merge([], [item("YAML", true)], [item("Browser")]).items).toEqual([
    item("Browser", true),
  ]);
});
test("removal beats an unchanged survivor", () => {
  expect(ReadingList.merge([a], [], [a])).toEqual({ items: [], graveyard: [] });
  expect(ReadingList.merge([a], [a], [])).toEqual({ items: [], graveyard: [] });
});
test("removal beats an edit, archiving the complete changed version", async () => {
  const changed = item("Changed", true);
  const result = ReadingList.merge([a], [], [changed]);
  expect(result).toEqual({ items: [], graveyard: [changed] });
  expect(ReadingList.merge([a], [changed], [])).toEqual(result);
  const archived = await Effect.runPromise(
    Graveyard.addReadingListEntries(BookmarkTree.make({}), result.graveyard, "chrome"),
  );
  const archive = JSON.stringify(archived);
  expect(archive).toContain('"name":"read"');
  expect(archive).toContain('"name":"Changed","url":"https://a.example/"');
  expect(archive).not.toContain('"read":');
});
test("YAML order survives and browser additions go first in browser order", () => {
  const b = item("B", false, "https://b.example/");
  const c = item("C", false, "https://c.example/");
  const d = item("D", false, "https://d.example/");
  expect(ReadingList.merge([a, b], [b, c, a], [d, a, b]).items).toEqual([d, b, c, a]);
});
test("equality and fingerprints ignore order, but include read state", () => {
  const b = item("B", false, "https://b.example/");
  expect(ReadingList.equal([a, b], [b, a])).toBe(true);
  expect(Fingerprint.ofReadingList([a, b])).toBe(Fingerprint.ofReadingList([b, a]));
  expect(Fingerprint.ofReadingList([a])).not.toBe(Fingerprint.ofReadingList([item("A", true)]));
  const tree = BookmarkTree.make({});
  expect(Fingerprint.ofState(TargetState.make({ tree, readingList: [a] }))).not.toBe(
    Fingerprint.ofState(TargetState.make({ tree, readingList: [item("A", true)] })),
  );
});
test("names collapse whitespace and URLs take bookmark canonical form", () => {
  expect(
    ReadingList.canonical([item(" \tA\n  B\r\u2028 C\u00a0 ", true, "https://EXAMPLE.com:443")]),
  ).toEqual([item("A B C", true, "https://example.com/")]);
  expect(ReadingList.canonical([a, item("Alias", true, "https://A.example")])).toEqual([a]);
});
test("non-HTTP(S) and malformed URLs are refused", () => {
  for (const url of [
    "file:///tmp/article",
    "javascript:alert(1)",
    "mailto:a@example.com",
    "https://bad host/",
  ])
    expect(() => ReadingList.canonical([item("A", false, url)])).toThrow("HTTP(S)");
});
test("YAML writes true only for read items and decodes omitted read as unread", async () => {
  const config = BookmarksConfig.make({
    all: SharedBookmarks.make({ reading_list: [a, item("B", true, "https://b.example/")] }),
  });
  const text = await Effect.runPromise(Yaml.render(config));
  expect(text).toContain("read: true");
  expect(text).not.toContain("read: false");
  const decoded = await Effect.runPromise(
    Yaml.decodeDocument({ version: 2, all: { reading_list: [{ name: "A", url: a.url }] } }, "test"),
  );
  expect(decoded.all.reading_list).toEqual([a]);
});
test("YAML refuses Reading List folders and every browser overlay", async () => {
  const inputs = [
    { all: { reading_list: [{ name: "Folder", children: [] }] } },
    { all: {}, safari: { reading_list: [] } },
    { all: {}, chrome: { reading_list: [] } },
    { all: {}, chrome: { profiles: { default: { reading_list: [] } } } },
  ];
  const results = await Promise.all(
    inputs.map((input) =>
      Effect.runPromise(Effect.either(Yaml.decodeDocument({ version: 2, ...input }, "test"))),
    ),
  );
  for (const result of results) expect(result._tag).toBe("Left");
});
