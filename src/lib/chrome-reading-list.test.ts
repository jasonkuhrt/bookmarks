import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import * as ChromeReadingList from "./chrome-reading-list.ts";
import { ReadingListItem } from "./schema/__.ts";

const item = (name: string, read = false) =>
  ReadingListItem.make({ name, url: `https://${name.toLowerCase()}.example/`, read });
const fake = (initial: readonly ReadingListItem[], retainRead = true) => {
  let clock = 0;
  let entries: ChromeReadingList.Entry[] = [...initial].reverse().map((entry) => ({
    url: entry.url,
    title: entry.name,
    hasBeenRead: entry.read,
    creationTime: ++clock,
  }));
  const layer = Layer.succeed(ChromeReadingList.ChromeReadingList, {
    query: () => Effect.sync(() => [...entries].reverse()),
    addEntry: (entry) =>
      Effect.try(() => {
        if (entries.some((existing) => existing.url === entry.url))
          throw new Error("Duplicate URL");
        entries.push({ ...entry, creationTime: ++clock });
      }),
    updateEntry: (entry) =>
      Effect.try(() => {
        if (!entries.some((existing) => existing.url === entry.url)) throw new Error("Missing URL");
        entries = entries.map((existing) =>
          existing.url === entry.url
            ? {
                ...existing,
                ...entry,
                hasBeenRead: retainRead ? entry.hasBeenRead : existing.hasBeenRead,
              }
            : existing,
        );
      }),
    removeEntry: ({ url }) =>
      Effect.sync(() => {
        entries = entries.filter((existing) => existing.url !== url);
      }),
  });
  return { layer, entries: () => entries };
};
test("reconcile updates existing URLs, removes extras, adds oldest first, and verifies as a set", async () => {
  const api = fake([item("A"), item("Removed")]);
  const desired = [
    item("Newest"),
    item("Older"),
    ReadingListItem.make({ url: item("A").url, read: true, name: "Renamed" }),
  ];
  const result = await Effect.runPromise(
    ChromeReadingList.reconcile([item("Removed"), item("A")], desired).pipe(
      Effect.provide(api.layer),
    ),
  );
  expect(result).toEqual(desired);
  expect(api.entries()).toHaveLength(3);
  expect(api.entries().find((entry) => entry.url === item("A").url)?.creationTime).toBe(2);
});
test("a stale read state stops reconcile before mutation", async () => {
  const api = fake([item("A", true)]);
  const outcome = await Effect.runPromise(
    Effect.either(ChromeReadingList.reconcile([item("A")], []).pipe(Effect.provide(api.layer))),
  );
  expect(outcome._tag).toBe("Left");
  expect(api.entries()).toHaveLength(1);
});
test("verification refuses an API that fails to retain a read-only update", async () => {
  const api = fake([item("A")], false);
  const outcome = await Effect.runPromise(
    Effect.either(
      ChromeReadingList.reconcile([item("A")], [item("A", true)]).pipe(Effect.provide(api.layer)),
    ),
  );
  expect(outcome._tag).toBe("Left");
});
