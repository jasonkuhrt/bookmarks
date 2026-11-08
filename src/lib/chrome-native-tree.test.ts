import { expect, test } from "bun:test";
import { canonicalTree, canonicalUrl } from "./chrome-native-tree.ts";
import { BookmarkLeaf, BookmarkTree } from "./schema/__.ts";

test("Chrome URL normalization is idempotent and preserves bookmarklet source", () => {
  expect(canonicalUrl("https://EXAMPLE.com")).toBe("https://example.com/");
  expect(canonicalUrl("http://example.com:80/a b?x=1#part")).toBe(
    "http://example.com/a%20b?x=1#part",
  );
  const bookmarklet = "javascript:(function()%7Balert('hi')%7D)()";
  expect(canonicalUrl(bookmarklet)).toBe(bookmarklet);
  const tree = BookmarkTree.make({
    bar: [
      BookmarkLeaf.make({ name: "Example", url: "https://EXAMPLE.com" }),
      BookmarkLeaf.make({ name: "Save", url: bookmarklet }),
    ],
  });
  const normalized = canonicalTree(tree);
  expect(normalized.bar).toEqual([
    BookmarkLeaf.make({ name: "Example", url: "https://example.com/" }),
    BookmarkLeaf.make({ name: "Save", url: bookmarklet }),
  ]);
  expect(canonicalTree(normalized)).toEqual(normalized);
});
