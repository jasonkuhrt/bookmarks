import * as Schema from "effect/Schema";
import { BookmarkSection } from "./bookmark-structure.ts";

export class BookmarkTree extends Schema.Class<BookmarkTree>("BookmarkTree")({
  bar: Schema.optional(BookmarkSection),
  menu: Schema.optional(BookmarkSection),
  reading_list: Schema.optional(BookmarkSection),
  mobile: Schema.optional(BookmarkSection),
}) {
  static is = Schema.is(BookmarkTree);
}
