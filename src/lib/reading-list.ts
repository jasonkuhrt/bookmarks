import { Data, HashMap, Option } from "effect";
import * as Canonical from "./canonical.ts";
import { ReadingListItem } from "./schema/__.ts";

export type Change = Data.TaggedEnum<{
  Added: { readonly item: ReadingListItem };
  Removed: { readonly item: ReadingListItem };
  Renamed: { readonly item: ReadingListItem; readonly oldName: string };
  MarkedRead: { readonly item: ReadingListItem };
  MarkedUnread: { readonly item: ReadingListItem };
}>;
export const { Added, Removed, Renamed, MarkedRead, MarkedUnread, $is, $match } =
  Data.taggedEnum<Change>();

export const canonicalItem = (item: ReadingListItem): ReadingListItem => {
  const url = Canonical.canonicalUrl(item.url);
  if (!URL.canParse(url) || !/^https?:/i.test(url))
    throw new Error(`Reading List URL must be HTTP(S): ${item.url}`);
  return ReadingListItem.make({
    name: item.name.trim().replaceAll(/\s+/g, " "),
    url,
    read: item.read,
  });
};

const index = (items: readonly ReadingListItem[]) =>
  HashMap.fromIterable(items.map((item) => [item.url, item] as const));

/** Canonical URL identity also coalesces URL aliases in YAML. First occurrence keeps its place. */
export const canonical = (items: readonly ReadingListItem[]): readonly ReadingListItem[] => {
  let seen = HashMap.empty<string, ReadingListItem>();
  const result: ReadingListItem[] = [];
  for (const raw of items) {
    const item = canonicalItem(raw);
    if (HashMap.has(seen, item.url)) continue;
    seen = HashMap.set(seen, item.url, item);
    result.push(item);
  }
  return result;
};

/** Browser-safe semantic stamp, shared by the extension, CLI and watcher. */
export const fingerprint = (items: readonly ReadingListItem[]): string =>
  JSON.stringify(
    canonical(items)
      .map((item) => [item.url, item.name, item.read] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
export const equal = (left: readonly ReadingListItem[], right: readonly ReadingListItem[]) =>
  fingerprint(left) === fingerprint(right);
export const sameOrder = (left: readonly ReadingListItem[], right: readonly ReadingListItem[]) =>
  JSON.stringify(left.map((item) => item.url)) === JSON.stringify(right.map((item) => item.url));

export const changes = (
  before: readonly ReadingListItem[],
  after: readonly ReadingListItem[],
): readonly Change[] => {
  const previous = index(canonical(before));
  const next = index(canonical(after));
  const result: Change[] = [];
  for (const item of HashMap.values(previous))
    if (!HashMap.has(next, item.url)) result.push(Removed({ item }));
  for (const item of canonical(after)) {
    const old = HashMap.get(previous, item.url);
    if (Option.isNone(old)) result.push(Added({ item }));
    else {
      if (item.name !== old.value.name) result.push(Renamed({ item, oldName: old.value.name }));
      if (item.read !== old.value.read)
        result.push(item.read ? MarkedRead({ item }) : MarkedUnread({ item }));
    }
  }
  return result;
};

/** Presence is merged before fields; ordering is only a presentation policy. */
export const merge = (
  baseline: readonly ReadingListItem[],
  yaml: readonly ReadingListItem[],
  browser: readonly ReadingListItem[],
): {
  readonly items: readonly ReadingListItem[];
  readonly graveyard: readonly ReadingListItem[];
} => {
  const base = index(canonical(baseline));
  const left = canonical(yaml);
  const right = canonical(browser);
  const y = index(left);
  const b = index(right);
  let kept = HashMap.empty<string, ReadingListItem>();
  const graveyard: ReadingListItem[] = [];
  for (const item of [...left, ...right]) {
    const ancestor = HashMap.get(base, item.url);
    const yamlItem = HashMap.get(y, item.url);
    const browserItem = HashMap.get(b, item.url);
    if (Option.isSome(ancestor) && (Option.isNone(yamlItem) || Option.isNone(browserItem))) {
      const survivor = Option.orElse(yamlItem, () => browserItem);
      if (
        Option.isSome(survivor) &&
        !equal([ancestor.value], [survivor.value]) &&
        !graveyard.some((entry) => entry.url === item.url)
      )
        graveyard.push(survivor.value);
      continue;
    }
    if (Option.isSome(yamlItem) && Option.isSome(browserItem)) {
      const l = yamlItem.value;
      const r = browserItem.value;
      kept = HashMap.set(
        kept,
        item.url,
        ReadingListItem.make({
          url: item.url,
          name: Option.isSome(ancestor) && r.name === ancestor.value.name ? l.name : r.name,
          read: Option.isSome(ancestor)
            ? l.read === ancestor.value.read
              ? r.read
              : r.read === ancestor.value.read
                ? l.read
                : l.read || r.read
            : l.read || r.read,
        }),
      );
    } else kept = HashMap.set(kept, item.url, item);
  }
  const ordered = [...right.filter((item) => !HashMap.has(y, item.url)), ...left];
  return {
    items: ordered.flatMap((item) => Option.toArray(HashMap.get(kept, item.url))),
    graveyard,
  };
};
