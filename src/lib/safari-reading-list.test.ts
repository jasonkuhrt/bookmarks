import { expect, test } from "bun:test";
import { parse } from "@plist/binary.parse";
import { serialize } from "@plist/binary.serialize";
import { Clock, Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Safari from "./safari.ts";
import { ReadingListItem, TargetState } from "./schema/__.ts";

const record = Schema.decodeUnknownSync(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);
const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);
test("Safari decodes read, preserves viewing history and opaque keys, and handles read transitions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "safari-reading-list-"));
  const path = join(dir, "Bookmarks.plist");
  const viewed = new Date("2026-01-01T00:00:00Z");
  const added = new Date("2025-12-01T00:00:00Z");
  const now = new Date("2026-10-01T00:00:00Z");
  const clock: Clock.Clock = {
    ...Clock.make(),
    currentTimeMillis: Effect.succeed(now.getTime()),
    unsafeCurrentTimeMillis: () => now.getTime(),
  };
  const write = (state: TargetState) =>
    run(Safari.writeState(path, state).pipe(Effect.withClock(clock)));
  try {
    await Bun.write(
      path,
      serialize({
        Children: [
          {
            Title: "com.apple.ReadingList",
            WebBookmarkType: "WebBookmarkTypeList",
            Children: [
              {
                WebBookmarkType: "WebBookmarkTypeLeaf",
                URLString: "https://a.example/",
                URIDictionary: { title: " A  Title " },
                ReadingList: { DateAdded: added, DateLastViewed: viewed, Opaque: "keep" },
                WebBookmarkUUID: "stable",
                Extra: "keep",
              },
              {
                WebBookmarkType: "WebBookmarkTypeLeaf",
                URLString: "https://b.example/",
                URIDictionary: { title: "B" },
                ReadingList: { DateAdded: added },
              },
            ],
          },
        ],
      }),
    );
    const original = await run(Safari.readState(path));
    expect(original.readingList.map((item) => [item.name, item.read])).toEqual([
      ["A Title", true],
      ["B", false],
    ]);
    const desired = original.readingList.map((item) =>
      ReadingListItem.make({ name: item.name, url: item.url, read: true }),
    );
    await write(TargetState.make({ tree: original.tree, readingList: desired }));
    const nodes = async () => {
      const root = record(parse(await Bun.file(path).arrayBuffer()));
      const sections = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(root["Children"]);
      const section = sections
        .map((value) => record(value))
        .find((node) => node["Title"] === "com.apple.ReadingList");
      return Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(section?.["Children"]).map(
        (value) => record(value),
      );
    };
    const saved = await nodes();
    expect(saved[0]?.["WebBookmarkUUID"]).toBe("stable");
    expect(saved[0]?.["Extra"]).toBe("keep");
    expect(record(saved[0]?.["ReadingList"])["DateLastViewed"]).toEqual(viewed);
    expect(record(saved[0]?.["ReadingList"])["Opaque"]).toBe("keep");
    expect(record(saved[1]?.["ReadingList"])["DateLastViewed"]).toEqual(now);
    expect(record(saved[1]?.["ReadingList"])["DateAdded"]).toEqual(added);
    const unread = desired.map((item) =>
      ReadingListItem.make({ name: item.name, url: item.url, read: false }),
    );
    unread.unshift(ReadingListItem.make({ name: "New", url: "https://new.example/", read: true }));
    await write(TargetState.make({ tree: original.tree, readingList: unread }));
    const changed = await nodes();
    expect(record(changed[0]?.["ReadingList"])["DateAdded"]).toEqual(now);
    expect(record(changed[0]?.["ReadingList"])["DateLastViewed"]).toEqual(now);
    expect(record(changed[1]?.["ReadingList"])["DateLastViewed"]).toBeUndefined();
    expect((await run(Safari.readState(path))).readingList).toEqual(unread);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
