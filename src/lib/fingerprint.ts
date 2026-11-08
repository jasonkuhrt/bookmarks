/**
 * Fingerprints of what a watched file holds, shared by a sync and the daemon.
 *
 * A sync reports, for each file it covered, the fingerprints of what it read there and what it
 * left there. The daemon fingerprints the same files after the sync and queues another sync
 * only for content outside that report: an edit the sync never took in. Its own writes, and
 * a browser's rewrite of the same bookmarks, queue nothing.
 */

import { Schema } from "effect";
import { createHash } from "node:crypto";
import * as Canonical from "./canonical.ts";
import * as Layers from "./layers.ts";
import { BookmarkLeaf, type BookmarkNode, type BookmarkTree } from "./schema/__.ts";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

const encodeNode = (node: BookmarkNode): unknown =>
  BookmarkLeaf.is(node) ? [node.name, node.url] : [node.name, node.children.map(encodeNode)];

/** Two trees share a fingerprint exactly when they hold the same bookmarks, in canonical form. */
export const ofTree = (tree: BookmarkTree): string => {
  const canonical = Canonical.canonicalTree(tree);
  return digest(
    JSON.stringify(Layers.sectionKeys.map((key) => (canonical[key] ?? []).map(encodeNode))),
  );
};

/** bookmarks.yaml's fingerprint, taken of its body without the daemon's managed header. */
export const ofText = (text: string): string => digest(text);

/** For each file a finished sync covered, the fingerprints of what it read there and left there. */
export const SyncSnapshot = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      fingerprints: Schema.Array(Schema.String),
    }),
  ),
});
export type SyncSnapshot = typeof SyncSnapshot.Type;
