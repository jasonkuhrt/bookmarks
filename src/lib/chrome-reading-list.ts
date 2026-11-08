import { Context, Effect, HashMap, Option } from "effect";
import * as ReadingList from "./reading-list.ts";
import { ReadingListItem } from "./schema/__.ts";

export interface Entry {
  readonly url: string;
  readonly title: string;
  readonly hasBeenRead: boolean;
  readonly creationTime: number;
}
export interface Api {
  readonly query: () => Effect.Effect<readonly Entry[], Error>;
  readonly addEntry: (entry: {
    readonly url: string;
    readonly title: string;
    readonly hasBeenRead: boolean;
  }) => Effect.Effect<void, Error>;
  readonly updateEntry: (entry: {
    readonly url: string;
    readonly title: string;
    readonly hasBeenRead: boolean;
  }) => Effect.Effect<void, Error>;
  readonly removeEntry: (entry: { readonly url: string }) => Effect.Effect<void, Error>;
}
export const ChromeReadingList = Context.GenericTag<Api>("bookmarks/ChromeReadingList");
const attempt = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

export const snapshot = Effect.gen(function* () {
  const api = yield* ChromeReadingList;
  const entries = yield* api.query();
  return yield* attempt(() =>
    ReadingList.canonical(
      [...entries]
        .sort((a, b) => b.creationTime - a.creationTime)
        .map((entry) =>
          ReadingListItem.make({ name: entry.title, url: entry.url, read: entry.hasBeenRead }),
        ),
    ),
  );
});

/** Only absent URLs are added. Existing URLs are updated, never upserted. */
export const reconcile = (
  expected: readonly ReadingListItem[],
  desired: readonly ReadingListItem[],
) =>
  Effect.gen(function* () {
    const api = yield* ChromeReadingList;
    const items = yield* attempt(() => ReadingList.canonical(desired));
    const observed = yield* snapshot;
    if (!ReadingList.equal(observed, expected))
      return yield* Effect.fail(
        new Error("Chrome Reading List changed; retry with a fresh snapshot."),
      );
    const current = HashMap.fromIterable(observed.map((item) => [item.url, item] as const));
    const wanted = HashMap.fromIterable(items.map((item) => [item.url, item] as const));
    for (const item of observed)
      if (!HashMap.has(wanted, item.url)) yield* api.removeEntry({ url: item.url });
    for (const item of items) {
      const previous = HashMap.get(current, item.url);
      if (Option.isSome(previous) && !ReadingList.equal([previous.value], [item]))
        yield* api.updateEntry({ url: item.url, title: item.name, hasBeenRead: item.read });
    }
    for (const item of [...items].reverse())
      if (!HashMap.has(current, item.url))
        yield* api.addEntry({ url: item.url, title: item.name, hasBeenRead: item.read });
    const verified = yield* snapshot;
    if (!ReadingList.equal(verified, items))
      return yield* Effect.fail(new Error("Chrome did not retain the requested Reading List."));
    return verified;
  });
