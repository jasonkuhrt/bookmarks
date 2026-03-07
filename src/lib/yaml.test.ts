import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BookmarkFolder,
  BookmarkLeaf,
  BookmarksConfig,
  BookmarkTree,
  SafariBookmarks,
} from "./schema/__.ts";
import * as YamlModule from "./yaml.ts";

const leaf = (name: string, url: string) => new BookmarkLeaf({ name, url });
const folder = (name: string, children: Array<BookmarkLeaf | BookmarkFolder>) =>
  new BookmarkFolder({ name, children });

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);

describe("yaml", () => {
  test("save/load preserves sibling ordering and empty folders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-yaml-"));
    const yamlPath = join(dir, "bookmarks.yaml");

    try {
      const config = BookmarksConfig.make({
        all: new BookmarkTree({
          bar: [
            leaf("First", "https://first.example"),
            folder("Empty", []),
            folder("Nested", [leaf("Inside", "https://inside.example")]),
            leaf("Last", "https://last.example"),
          ],
        }),
        safari: SafariBookmarks.make({
          menu: [folder("Profile Empty", []), leaf("Profile Bookmark", "https://profile.example")],
        }),
      });

      await run(YamlModule.save(yamlPath, config));
      const loaded = await run(YamlModule.load(yamlPath));

      expect(loaded).toEqual(config);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
