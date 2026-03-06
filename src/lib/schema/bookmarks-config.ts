import * as Schema from "effect/Schema"
import { BookmarkTree } from "./bookmark-tree.js"
import { BookmarkSection } from "./bookmark-structure.js"

const BarSection = Schema.optional(BookmarkSection)
const MenuSection = Schema.optional(BookmarkSection)
const ReadingListSection = Schema.optional(BookmarkSection)
const MobileSection = Schema.optional(BookmarkSection)

export class SafariBookmarks extends Schema.Class<SafariBookmarks>("SafariBookmarks")({
  enabled: Schema.optional(Schema.Boolean),
  bar: BarSection,
  menu: MenuSection,
  reading_list: ReadingListSection,
}) {
  static is = Schema.is(SafariBookmarks)
}

export class ChromeProfileBookmarks extends Schema.Class<ChromeProfileBookmarks>("ChromeProfileBookmarks")({
  enabled: Schema.optional(Schema.Boolean),
  bar: BarSection,
  menu: MenuSection,
  mobile: MobileSection,
}) {
  static is = Schema.is(ChromeProfileBookmarks)
}

export class ChromeBookmarks extends Schema.Class<ChromeBookmarks>("ChromeBookmarks")({
  enabled: Schema.optional(Schema.Boolean),
  bar: BarSection,
  menu: MenuSection,
  mobile: MobileSection,
  profiles: Schema.optional(Schema.Record({ key: Schema.String, value: ChromeProfileBookmarks })),
}) {
  static is = Schema.is(ChromeBookmarks)
}

export class BookmarksConfig extends Schema.Class<BookmarksConfig>("BookmarksConfig")({
  version: Schema.Literal(2).pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => 2 as const),
  ),
  all: BookmarkTree,
  safari: Schema.optional(SafariBookmarks),
  chrome: Schema.optional(ChromeBookmarks),
}) {
  static is = Schema.is(BookmarksConfig)
}
