import { expect, test } from "bun:test";
import * as Yaml from "yaml";
import { migrate } from "./migrate-reading-list.ts";
import {
  BookmarkTree,
  BookmarkLeaf,
  BookmarkFolder,
  ReadingListItem,
} from "../src/lib/schema/__.ts";

const leaf = BookmarkLeaf.make({ name: "Article", url: "https://a.example/" });
const yaml = Yaml.stringify({ version: 2, all: { reading_list: [leaf] } });
const baseline = JSON.stringify({
  version: 1,
  targets: {
    safari: { reading_list: [leaf] },
    "chrome/default": { menu: [leaf], reading_list: [leaf] },
  },
});
const file = BookmarkTree.make({
  menu: [leaf, BookmarkFolder.make({ name: "Read Later", children: [leaf] })],
});
test("migration preserves Safari deletion ancestry and appends Chrome's old folder", () => {
  const migrated = migrate(yaml, baseline, { "chrome/default": file });
  expect(migrated.baselines["safari"]?.readingList).toEqual([
    ReadingListItem.make({ name: leaf.name, url: leaf.url, read: false }),
  ]);
  expect(migrated.baselines["chrome/default"]?.tree).toEqual(file);
  expect(migrated.baselines["chrome/default"]?.readingList).toEqual([]);
  expect(migrated.yaml).not.toContain("_tag");
  expect(migrated.yaml).not.toContain("read: true");
});
test("migration refuses overlays", () => {
  expect(() =>
    migrate(Yaml.stringify({ version: 2, all: {}, safari: { reading_list: [] } }), baseline, {
      "chrome/default": file,
    }),
  ).toThrow("overlay");
});
test("migration stops at a Chrome file mismatch before returning rewritten files", () => {
  expect(() => migrate(yaml, baseline, { "chrome/default": BookmarkTree.make({}) })).toThrow(
    "Chrome file mismatch",
  );
});

test("migration refuses unsupported baseline-only Safari URLs before writing v2 state", () => {
  const invalid = BookmarkLeaf.make({ name: "Historical", url: "file:///tmp/article" });
  expect(() =>
    migrate(
      "version: 2\nall: {}\n",
      JSON.stringify({ version: 1, targets: { safari: { reading_list: [invalid] } } }),
      {},
    ),
  ).toThrow("HTTP(S)");
});
