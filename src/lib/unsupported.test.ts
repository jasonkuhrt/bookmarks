import { describe, expect, test } from "bun:test";
import {
  UnsupportedBookmarks,
  collectAmbiguousPathIssues,
  separatorIssue,
  unsupportedNodeIssue,
} from "./unsupported.ts";
import { BookmarkFolder, BookmarkTree } from "./schema/__.ts";

describe("unsupported bookmarks", () => {
  test("reports folder paths that cannot identify one native folder", () => {
    const tree = BookmarkTree.make({
      bar: [
        BookmarkFolder.make({ name: "A/B", children: [] }),
        BookmarkFolder.make({ name: "Same", children: [] }),
        BookmarkFolder.make({ name: "Same", children: [] }),
      ],
    });

    expect(collectAmbiguousPathIssues(tree).map((issue) => issue.code)).toEqual([
      "ambiguous-path",
      "ambiguous-path",
    ]);
  });

  test("UnsupportedBookmarks exposes a guard and readable message", () => {
    const error = new UnsupportedBookmarks({
      source: "chrome/default",
      issues: [separatorIssue("menu/Divider", "Delete the divider before syncing.")],
    });

    expect(UnsupportedBookmarks.is(error)).toBe(true);
    expect(error.message).toContain("chrome/default");
    expect(error.message).toContain("Delete the divider before syncing.");
  });

  test("separatorIssue and unsupportedNodeIssue produce clear diagnostics", () => {
    expect(separatorIssue("menu/Divider", "Delete the divider before syncing.")).toEqual({
      code: "separator",
      path: "menu/Divider",
      message: "Bookmark separators are not supported. Delete the divider before syncing.",
    });
    expect(unsupportedNodeIssue("menu/Raw", "Unsupported bookmark node")).toEqual({
      code: "unsupported-node",
      path: "menu/Raw",
      message: "Unsupported bookmark node",
    });
  });
});
