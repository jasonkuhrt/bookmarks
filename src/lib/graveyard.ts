/**
 * Graveyard management and garbage collection.
 *
 * The graveyard is a real bookmark folder (`_graveyard/`) that stores
 * conflict losers with self-describing names: `YYYY-MM-DD_{source}_{reason}/`.
 * GC removes entries older than the configured max age (default 90 days).
 *
 * Original bookmark paths are preserved as nested folders inside each
 * graveyard event folder, so the structure is:
 *   menu/_graveyard/2025-01-15_safari_conflict/bar/AI/Tools/ChatGPT
 */

import { DateTime, Duration, Effect, Option } from "effect";
import * as Patch from "./patch.ts";
import type { BookmarkNode, ReadingListItem } from "./schema/__.ts";
import { BookmarkFolder, BookmarkLeaf, BookmarkTree } from "./schema/__.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the top-level graveyard folder under `menu`. */
export const GRAVEYARD_FOLDER_NAME = "_graveyard";

/** Regex for parsing graveyard event folder names. */
const EVENT_FOLDER_RE = /^(\d{4}-\d{2}-\d{2})_([^_]+)_([^_]+)$/;

const expectDefined = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
};

// ---------------------------------------------------------------------------
// Helpers (internal)
// ---------------------------------------------------------------------------

/** Format a DateTime.Utc as YYYY-MM-DD. */
const formatDate = (dt: DateTime.Utc): string => DateTime.formatIsoDateUtc(dt);
const withMenu = (tree: BookmarkTree, menu: readonly BookmarkNode[]): BookmarkTree =>
  BookmarkTree.make({
    bar: tree.bar,
    menu,
    mobile: tree.mobile,
  });

/** Build a graveyard event folder name from date, source, and reason. */
export const makeEventFolderName = (date: DateTime.Utc, source: string, reason: string): string =>
  `${formatDate(date)}_${source}_${reason}`;

/** Parse a graveyard event folder name, returning the date portion. */
export const parseEventFolderName = (
  name: string,
): Option.Option<{ date: DateTime.Utc; source: string; reason: string }> => {
  const m = EVENT_FOLDER_RE.exec(name);
  if (!m) return Option.none();
  const dateOpt = DateTime.make(expectDefined(m[1], `Missing graveyard date in "${name}"`));
  if (Option.isNone(dateOpt)) return Option.none();
  return Option.some({
    date: dateOpt.value,
    source: expectDefined(m[2], `Missing graveyard source in "${name}"`),
    reason: expectDefined(m[3], `Missing graveyard reason in "${name}"`),
  });
};

/** Reuse path folders while retaining every archived bookmark occurrence. */
const appendAtPath = (
  nodes: readonly BookmarkNode[],
  pathSegments: readonly string[],
  leaf: BookmarkLeaf,
): readonly BookmarkNode[] => {
  const [name, ...rest] = pathSegments;
  if (name === undefined) return [...nodes, leaf];

  const existing = nodes.find(
    (node): node is BookmarkFolder => BookmarkFolder.is(node) && node.name === name,
  );
  const folder = BookmarkFolder.make({
    name,
    children: appendAtPath(existing?.children ?? [], rest, leaf),
  });
  return existing ? nodes.map((node) => (node === existing ? folder : node)) : [...nodes, folder];
};

/**
 * Extract bookmark info from a patch for graveyard entry creation.
 * Returns the url, name, and path segments for the bookmark being affected.
 */
const patchToBookmarkInfo = (
  patch: Patch.BookmarkPatch,
): { url: string; name: string; pathSegments: string[] } =>
  Patch.$match(patch, {
    Add: (p) => ({ url: p.url, name: p.name, pathSegments: p.path.split("/") }),
    Remove: (p) => ({ url: p.url, name: p.name, pathSegments: p.path.split("/") }),
    Update: (p) => ({
      url: p.url,
      name: p.oldName,
      pathSegments: p.fromPath.split("/"),
    }),
  });

/**
 * Find or create the _graveyard folder within the `menu` section.
 * Returns the updated `menu` array and the graveyard folder.
 */
const ensureGraveyardFolder = (
  menu: readonly BookmarkNode[],
): { menu: readonly BookmarkNode[]; graveyardFolder: BookmarkFolder } => {
  const existing = menu.find(
    (n): n is BookmarkFolder => BookmarkFolder.is(n) && n.name === GRAVEYARD_FOLDER_NAME,
  );
  if (existing) {
    return { menu, graveyardFolder: existing };
  }
  const folder = BookmarkFolder.make({ name: GRAVEYARD_FOLDER_NAME, children: [] });
  return { menu: [...menu, folder], graveyardFolder: folder };
};

/**
 * Find or create an event folder within the graveyard folder.
 * Returns the updated graveyard folder.
 */
const ensureEventFolder = (
  graveyardFolder: BookmarkFolder,
  eventFolderName: string,
): { graveyardFolder: BookmarkFolder; eventFolder: BookmarkFolder } => {
  const existing = graveyardFolder.children.find(
    (n): n is BookmarkFolder => BookmarkFolder.is(n) && n.name === eventFolderName,
  );
  if (existing) {
    return { graveyardFolder, eventFolder: existing };
  }
  const folder = BookmarkFolder.make({ name: eventFolderName, children: [] });
  const updated = BookmarkFolder.make({
    name: graveyardFolder.name,
    children: [...graveyardFolder.children, folder],
  });
  return { graveyardFolder: updated, eventFolder: folder };
};

/**
 * Replace the graveyard folder in the `menu` array with an updated version.
 */
const replaceGraveyardInMenu = (
  menu: readonly BookmarkNode[],
  graveyardFolder: BookmarkFolder,
): readonly BookmarkNode[] =>
  menu.map((n) => (BookmarkFolder.is(n) && n.name === GRAVEYARD_FOLDER_NAME ? graveyardFolder : n));

/**
 * Replace an event folder inside the graveyard folder.
 */
const replaceEventInGraveyard = (
  graveyardFolder: BookmarkFolder,
  eventFolder: BookmarkFolder,
): BookmarkFolder =>
  BookmarkFolder.make({
    name: graveyardFolder.name,
    children: graveyardFolder.children.map((n) =>
      BookmarkFolder.is(n) && n.name === eventFolder.name ? eventFolder : n,
    ),
  });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Create a graveyard entry from a conflict-losing patch. */
export const addToGraveyard = (
  tree: BookmarkTree,
  patch: Patch.BookmarkPatch,
  source: string,
  reason: string,
): Effect.Effect<BookmarkTree, Error> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const info = patchToBookmarkInfo(patch);
    const eventFolderName = makeEventFolderName(now, source, reason);

    // Create the leaf bookmark to store in graveyard
    const graveyardLeaf = BookmarkLeaf.make({ name: info.name, url: info.url });

    // Ensure `menu` section exists
    const menuSection = tree.menu ?? [];

    // Ensure _graveyard folder exists
    const { menu: menuWithGraveyard, graveyardFolder } = ensureGraveyardFolder(menuSection);

    // Ensure event folder exists
    const { graveyardFolder: graveyardWithEvent, eventFolder } = ensureEventFolder(
      graveyardFolder,
      eventFolderName,
    );

    // Add the entry to the event folder
    const updatedEventFolder = BookmarkFolder.make({
      name: eventFolder.name,
      children: appendAtPath(eventFolder.children, info.pathSegments, graveyardLeaf),
    });

    // Reassemble: event -> graveyard -> menu -> tree
    const updatedGraveyard = replaceEventInGraveyard(graveyardWithEvent, updatedEventFolder);
    const updatedMenu = replaceGraveyardInMenu(menuWithGraveyard, updatedGraveyard);

    return withMenu(tree, updatedMenu);
  });

/** Batch version: add multiple patches to graveyard. */
export const addGraveyardEntries = (
  tree: BookmarkTree,
  patches: readonly Patch.BookmarkPatch[],
  source: string,
  reason: string,
): Effect.Effect<BookmarkTree, Error> =>
  Effect.gen(function* () {
    let current = tree;
    for (const patch of patches) {
      current = yield* addToGraveyard(current, patch, source, reason);
    }
    return current;
  });

/** Remove graveyard entries older than maxAge. */
export const gc = (
  tree: BookmarkTree,
  maxAge: Duration.Duration,
): Effect.Effect<BookmarkTree, Error> =>
  Effect.gen(function* () {
    const menuSection = tree.menu;
    if (!menuSection) return tree;

    const graveyardFolder = menuSection.find(
      (n): n is BookmarkFolder => BookmarkFolder.is(n) && n.name === GRAVEYARD_FOLDER_NAME,
    );
    if (!graveyardFolder) return tree;

    const now = yield* DateTime.now;
    const maxAgeMillis = Duration.toMillis(maxAge);

    // Filter event folders: keep those whose date is within maxAge
    const keptChildren = graveyardFolder.children.filter((child) => {
      if (!BookmarkFolder.is(child)) return true; // keep non-folder nodes (shouldn't exist, but safe)
      const parsed = parseEventFolderName(child.name);
      if (Option.isNone(parsed)) return true; // keep unparseable folders
      const ageMillis = DateTime.distance(parsed.value.date, now);
      return ageMillis < maxAgeMillis;
    });

    // If all children were kept, no change needed
    if (keptChildren.length === graveyardFolder.children.length) return tree;

    // If no children remain, remove the graveyard folder entirely
    if (keptChildren.length === 0) {
      const updatedMenu = menuSection.filter(
        (n) => !(BookmarkFolder.is(n) && n.name === GRAVEYARD_FOLDER_NAME),
      );
      return withMenu(tree, updatedMenu);
    }

    // Otherwise, update the graveyard folder with remaining children
    const updatedGraveyard = BookmarkFolder.make({
      name: GRAVEYARD_FOLDER_NAME,
      children: keptChildren,
    });
    const updatedMenu = replaceGraveyardInMenu(menuSection, updatedGraveyard);
    return withMenu(tree, updatedMenu);
  });

/** Archive the whole losing version; folder names keep read state recoverable. */
export const addReadingListEntries = (
  tree: BookmarkTree,
  items: readonly ReadingListItem[],
  source: string,
): Effect.Effect<BookmarkTree, Error> =>
  Effect.gen(function* () {
    let current = tree;
    const date = yield* DateTime.now;
    for (const item of items) {
      const eventName = makeEventFolderName(date, source, "conflict");
      const { menu, graveyardFolder } = ensureGraveyardFolder(current.menu ?? []);
      const { graveyardFolder: withEvent, eventFolder } = ensureEventFolder(
        graveyardFolder,
        eventName,
      );
      const event = BookmarkFolder.make({
        name: eventName,
        children: appendAtPath(
          eventFolder.children,
          ["reading_list", item.read ? "read" : "unread"],
          BookmarkLeaf.make({ name: item.name, url: item.url }),
        ),
      });
      current = withMenu(
        current,
        replaceGraveyardInMenu(menu, replaceEventInGraveyard(withEvent, event)),
      );
    }
    return current;
  });
