import * as Schema from "effect/Schema";
import { BookmarkTree } from "./bookmark-tree.ts";
import { ReadingListItem } from "./reading-list-item.ts";

export class TargetState extends Schema.Class<TargetState>("TargetState")({
  tree: BookmarkTree,
  readingList: Schema.Array(ReadingListItem),
}) {}
