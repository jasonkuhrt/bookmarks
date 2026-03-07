import { describe, expect, test } from "bun:test";
import { parse } from "@plist/binary.parse";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHROME_BOOKMARKS_FIXTURE_PATH,
  copyChromeBookmarksFixture,
  readChromeBookmarksFixture,
  SAFARI_BOOKMARKS_FIXTURE_PATH,
  writeSafariBookmarksFixture,
} from "./test-fixtures.ts";

describe("test fixtures", () => {
  test("copyChromeBookmarksFixture copies the Chrome fixture verbatim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-fixtures-"));
    const destination = join(dir, "Bookmarks");

    try {
      await copyChromeBookmarksFixture(destination);
      expect(await Bun.file(destination).text()).toBe(
        await Bun.file(CHROME_BOOKMARKS_FIXTURE_PATH).text(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readChromeBookmarksFixture returns a parsed object", async () => {
    const fixture = await readChromeBookmarksFixture();
    expect(fixture).toHaveProperty("roots");
    expect(fixture).toHaveProperty("version");
  });

  test("writeSafariBookmarksFixture writes a parseable plist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-fixtures-"));
    const destination = join(dir, "Bookmarks.plist");

    try {
      await writeSafariBookmarksFixture(destination);
      const sourceJson: unknown = JSON.parse(await Bun.file(SAFARI_BOOKMARKS_FIXTURE_PATH).text());
      const parsed: unknown = parse(await Bun.file(destination).arrayBuffer());

      if (
        sourceJson === null ||
        typeof sourceJson !== "object" ||
        !("Children" in sourceJson) ||
        parsed === null ||
        typeof parsed !== "object" ||
        !("Children" in parsed)
      ) {
        throw new Error("Expected Safari fixture JSON and generated plist to contain Children");
      }

      const sourceChildren = sourceJson["Children"];
      const parsedChildren = parsed["Children"];

      expect(Array.isArray(parsedChildren)).toBe(true);
      expect(Array.isArray(sourceChildren)).toBe(true);
      expect(Array.isArray(parsedChildren) ? parsedChildren.length : 0).toBe(
        Array.isArray(sourceChildren) ? sourceChildren.length : 0,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
