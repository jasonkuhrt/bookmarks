import { expect, test } from "bun:test";
import * as Canonical from "./canonical.ts";
import {
  BookmarkFolder,
  BookmarkLeaf,
  BookmarksConfig,
  BookmarkTree,
  ChromeBookmarks,
  ChromeProfileBookmarks,
  SafariBookmarks,
  SharedBookmarks,
  ReadingListItem,
} from "./schema/__.ts";

const pinboardAsTyped =
  "javascript:if(document.getSelection)%7Bs=document.getSelection();%7Delse%7Bs='';%7D;document.location='https://pinboard.in/add?next=same&url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)";
const pinboardAsChromeStores =
  "javascript:if(document.getSelection)%7Bs=document.getSelection();%7Delse%7Bs='';%7D;document.location='https://pinboard.in/add?next=same&url=%27+encodeURIComponent(location.href)+%27&title=%27+encodeURIComponent(document.title)";

test("a bookmarklet compares equal in the form Safari keeps and the form Chrome stores", () => {
  expect(Canonical.canonicalUrl(pinboardAsTyped)).toBe(pinboardAsChromeStores);
  expect(Canonical.canonicalUrl(pinboardAsChromeStores)).toBe(pinboardAsChromeStores);
});

test("a bookmarklet keeps its quotes outside the query, as Chrome does", () => {
  expect(Canonical.canonicalUrl("javascript:alert('hi')")).toBe("javascript:alert('hi')");
  expect(Canonical.canonicalUrl("javascript:a('x')#b('y')")).toBe("javascript:a('x')#b('y')");
  expect(Canonical.canonicalUrl("javascript:a#b?c='d'")).toBe("javascript:a#b?c='d'");
  expect(Canonical.canonicalUrl("javascript:a?b='c' d#e 'f'")).toBe(
    "javascript:a?b=%27c%27%20d#e%20'f'",
  );
});

test("web URLs take their WHATWG form and an unparseable one stays as written", () => {
  expect(Canonical.canonicalUrl("https://EXAMPLE.com")).toBe("https://example.com/");
  expect(Canonical.canonicalUrl("http://example.com:80/a b?x=1#part")).toBe(
    "http://example.com/a%20b?x=1#part",
  );
  expect(Canonical.canonicalUrl("https://exa mple.com")).toBe("https://exa mple.com");
  expect(Canonical.canonicalUrl("mailto:me@example.com")).toBe("mailto:me@example.com");
});

test("titles lose the line breaks Chrome replaces with spaces", () => {
  expect(Canonical.canonicalName("Dan (@dan)\n818 likes\r\t·\u2028x\u2029y")).toBe(
    "Dan (@dan) 818 likes  · x y",
  );
  expect(Canonical.canonicalName("Plain")).toBe("Plain");
});

test("trees and configs are canonical in every section and overlay, idempotently", () => {
  const raw = BookmarkTree.make({
    bar: [
      BookmarkFolder.make({
        name: "Tools\nand more",
        children: [BookmarkLeaf.make({ name: "Example", url: "https://EXAMPLE.com" })],
      }),
    ],
  });
  const tree = Canonical.canonicalTree(raw);
  expect(tree).toEqual(
    BookmarkTree.make({
      bar: [
        BookmarkFolder.make({
          name: "Tools and more",
          children: [BookmarkLeaf.make({ name: "Example", url: "https://example.com/" })],
        }),
      ],
    }),
  );
  expect(Canonical.canonicalTree(tree)).toEqual(tree);

  const config = Canonical.canonicalConfig(
    BookmarksConfig.make({
      all: SharedBookmarks.make({
        bar: raw.bar,
        menu: raw.menu,
        mobile: raw.mobile,
        reading_list: [
          ReadingListItem.make({ name: " A  B ", url: "https://EXAMPLE.com", read: true }),
        ],
      }),
      safari: SafariBookmarks.make({ enabled: true, bar: raw.bar }),
      chrome: ChromeBookmarks.make({
        menu: raw.bar,
        profiles: { work: ChromeProfileBookmarks.make({ bar: raw.bar }) },
      }),
    }),
  );
  expect(Canonical.canonicalTree(config.all)).toEqual(tree);
  expect(config.all.reading_list).toEqual([
    ReadingListItem.make({ name: "A B", url: "https://example.com/", read: true }),
  ]);
  expect(config.safari?.enabled).toBe(true);
  expect(config.safari?.bar).toEqual(tree.bar);
  expect(config.chrome?.menu).toEqual(tree.bar);
  expect(config.chrome?.profiles?.["work"]?.bar).toEqual(tree.bar);
});
