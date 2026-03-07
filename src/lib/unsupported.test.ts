import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { BookmarkLeaf, BookmarkTree } from "./schema/__.ts";
import {
  UnsupportedBookmarks,
  collectDuplicateUrlIssues,
  ensureMutationSupported,
  separatorIssue,
  unsupportedNodeIssue,
} from "./unsupported.ts";

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);
const runExit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);
const expectFailure = async (promise: Promise<unknown>, message: string): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected rejection containing "${message}"`);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.message).toContain(message);
  }
};

describe("unsupported bookmarks", () => {
  test("collectDuplicateUrlIssues finds duplicate URLs across sections", () => {
    const tree = BookmarkTree.make({
      bar: [new BookmarkLeaf({ name: "First", url: "https://dup.example" })],
      menu: [new BookmarkLeaf({ name: "Second", url: "https://dup.example" })],
    });

    expect(collectDuplicateUrlIssues(tree)).toEqual([
      {
        code: "duplicate-url",
        path: "menu/Second",
        message:
          'Duplicate URL "https://dup.example" is not supported; bookmark identity is URL-based so mutation would be ambiguous.',
      },
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

  test("ensureMutationSupported succeeds for unique trees and fails for duplicates", async () => {
    const supported = BookmarkTree.make({
      bar: [new BookmarkLeaf({ name: "Only", url: "https://only.example" })],
    });
    const unsupported = BookmarkTree.make({
      bar: [
        new BookmarkLeaf({ name: "First", url: "https://dup.example" }),
        new BookmarkLeaf({ name: "Second", url: "https://dup.example" }),
      ],
    });

    expect(Exit.isSuccess(await runExit(ensureMutationSupported(supported, "yaml")))).toBe(true);
    await expectFailure(
      run(ensureMutationSupported(unsupported, "chrome/default")),
      "Cannot safely mutate bookmarks because chrome/default contains unsupported constructs",
    );
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
