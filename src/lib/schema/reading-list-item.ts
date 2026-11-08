import * as Schema from "effect/Schema";

/** Reading List state belongs to a URL, never to a bookmark placement. */
export class ReadingListItem extends Schema.Class<ReadingListItem>("ReadingListItem")({
  name: Schema.String,
  url: Schema.String,
  read: Schema.optionalWith(Schema.Boolean, { default: () => false }),
}) {}
