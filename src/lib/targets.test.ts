/* oxlint-disable await-thenable, no-confusing-void-expression */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { serialize } from "@plist/binary.serialize";
import { Effect } from "effect";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Targets from "./targets.ts";

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);

describe("targets", () => {
  test("discoverSafariTargets discovers the shared Safari bookmark store once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-safari-targets-"));
    const plistPath = join(dir, "Bookmarks.plist");

    try {
      await Bun.write(plistPath, serialize({ Children: [] }));

      const targets = await run(Targets.discoverSafariTargets(plistPath));
      expect(targets.map(Targets.keyOf)).toEqual(["safari"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("discoverSafariProfiles reads Safari profile metadata from SafariTabs.db", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-safari-profiles-"));
    const tabsDbPath = join(dir, "SafariTabs.db");

    try {
      const db = new Database(tabsDbPath);
      try {
        db.run(
          "create table bookmarks (id integer primary key, parent integer, type integer, subtype integer, title text, external_uuid text, extra_attributes blob)",
        );
        db.run(
          "insert into bookmarks (id, parent, type, subtype, title, external_uuid, extra_attributes) values (?, ?, ?, ?, ?, ?, ?)",
          [
            35,
            0,
            1,
            2,
            null,
            "DefaultProfile",
            Buffer.from(
              serialize({
                "com.apple.Bookmark": { DateAdded: new Date("2026-03-06T00:00:00.000Z") },
                SymbolImageName: "bicycle",
              }),
            ),
          ],
        );
        db.run(
          "insert into bookmarks (id, parent, type, subtype, title, external_uuid, extra_attributes) values (?, ?, ?, ?, ?, ?, ?)",
          [
            201,
            0,
            1,
            2,
            "Heartbeat",
            "FB6E52DB-8796-4D8F-88E2-7EB82D9D0FD5",
            Buffer.from(
              serialize({
                CustomFavoritesFolderServerID: "Favorites Bar",
                "com.apple.Bookmark": { DateAdded: new Date("2026-03-06T00:00:00.000Z") },
                SymbolImageName: "hammer.fill",
              }),
            ),
          ],
        );
      } finally {
        db.close();
      }

      const profiles = await run(Targets.discoverSafariProfiles(tabsDbPath));
      expect(profiles).toEqual([
        { profile: "default", bookmarkScope: "Favorites Bar" },
        { profile: "heartbeat", bookmarkScope: "Favorites Bar" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("discoverChromeTargets reads profile directories from Local State", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-targets-"));

    try {
      await mkdir(join(dir, "Default"), { recursive: true });
      await mkdir(join(dir, "Profile 1"), { recursive: true });
      await mkdir(join(dir, "System Profile"), { recursive: true });
      await Bun.write(join(dir, "Default", "Bookmarks"), "{}");
      await Bun.write(join(dir, "Profile 1", "Bookmarks"), "{}");
      await Bun.write(
        join(dir, "Local State"),
        JSON.stringify({
          profile: {
            info_cache: {
              Default: {},
              "Profile 1": {},
              "System Profile": {},
            },
          },
        }),
      );

      const targets = await run(Targets.discoverChromeTargets(dir));
      expect(targets.map(Targets.keyOf)).toEqual(["chrome/default", "chrome/profile-1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resolveTargetSelectors with no selectors returns Safari once and all discovered Chrome profiles", async () => {
    const targets = [
      { browser: "safari", path: "/tmp/Safari.plist", enabled: true },
      { browser: "chrome", profile: "default", path: "/tmp/default", enabled: true },
      { browser: "chrome", profile: "profile-1", path: "/tmp/profile-1", enabled: true },
    ] as const;

    const resolved = await run(Targets.resolveTargetSelectors(targets, []));
    expect(resolved.map(Targets.keyOf)).toEqual(["safari", "chrome/default", "chrome/profile-1"]);
  });

  test("resolveTargetSelectors treats bare browser selectors as all matching targets", async () => {
    const targets = [
      { browser: "safari", path: "/tmp/Safari.plist", enabled: true },
      { browser: "chrome", profile: "default", path: "/tmp/default", enabled: true },
      { browser: "chrome", profile: "profile-1", path: "/tmp/profile-1", enabled: true },
    ] as const;

    const resolved = await run(Targets.resolveTargetSelectors(targets, ["chrome"]));
    expect(resolved.map(Targets.keyOf)).toEqual(["chrome/default", "chrome/profile-1"]);
  });

  test("resolveTargetSelectors fails clearly for unknown exact Chrome profile selectors", async () => {
    const targets = [
      { browser: "chrome", profile: "default", path: "/tmp/default", enabled: true },
    ] as const;

    await expect(run(Targets.resolveTargetSelectors(targets, ["chrome/defualt"]))).rejects.toThrow(
      'Unknown target selector "chrome/defualt"',
    );
  });

  test("resolveTargetSelectors fails clearly for Safari profile selectors", async () => {
    const targets = [{ browser: "safari", path: "/tmp/Safari.plist", enabled: true }] as const;

    await expect(run(Targets.resolveTargetSelectors(targets, ["safari/default"]))).rejects.toThrow(
      'Safari bookmarks are shared; use "safari" instead of "safari/default".',
    );
  });
});
