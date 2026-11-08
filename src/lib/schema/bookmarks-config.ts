import * as Schema from "effect/Schema";
import * as BookmarkTree from "./bookmark-tree.ts";
import * as BookmarkStructure from "./bookmark-structure.ts";
import * as ReadingListItem from "./reading-list-item.ts";

const BarSection = Schema.optional(BookmarkStructure.BookmarkSection);
const MenuSection = Schema.optional(BookmarkStructure.BookmarkSection);

export const SharedBookmarks = Schema.Struct({
  ...BookmarkTree.BookmarkTree.fields,
  reading_list: Schema.optional(Schema.Array(ReadingListItem.ReadingListItem)),
});
export type SharedBookmarks = typeof SharedBookmarks.Type;
const MobileSection = Schema.optional(BookmarkStructure.BookmarkSection);

export class SafariBookmarks extends Schema.Class<SafariBookmarks>("SafariBookmarks")({
  enabled: Schema.optional(Schema.Boolean),
  bar: BarSection,
  menu: MenuSection,
}) {
  static is = Schema.is(SafariBookmarks);
}

export class ChromeProfileBookmarks extends Schema.Class<ChromeProfileBookmarks>(
  "ChromeProfileBookmarks",
)({
  enabled: Schema.optional(Schema.Boolean),
  bar: BarSection,
  menu: MenuSection,
  mobile: MobileSection,
}) {
  static is = Schema.is(ChromeProfileBookmarks);
}

export class ChromeBookmarks extends Schema.Class<ChromeBookmarks>("ChromeBookmarks")({
  enabled: Schema.optional(Schema.Boolean),
  bar: BarSection,
  menu: MenuSection,
  mobile: MobileSection,
  profiles: Schema.optional(Schema.Record({ key: Schema.String, value: ChromeProfileBookmarks })),
}) {
  static is = Schema.is(ChromeBookmarks);
}

export class BookmarksConfig extends Schema.Class<BookmarksConfig>("BookmarksConfig")({
  version: Schema.Literal(2).pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => 2 as const),
  ),
  all: SharedBookmarks,
  safari: Schema.optional(SafariBookmarks),
  chrome: Schema.optional(ChromeBookmarks),
}) {
  static is = Schema.is(BookmarksConfig);
}
