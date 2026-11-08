import * as Schema from "effect/Schema";
import * as BookmarkTree from "./bookmark-tree.ts";
import * as ReadingListItem from "./reading-list-item.ts";

export class TargetState extends Schema.Class<TargetState>("TargetState")({
  tree: BookmarkTree.BookmarkTree,
  readingList: Schema.Array(ReadingListItem.ReadingListItem),
}) {}
