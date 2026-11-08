/**
 * Writing one target's bookmarks back into the YAML's layers.
 *
 * A target sees each section as its layers concatenated: Safari's bar is `all.bar` followed
 * by `safari.bar`; a Chrome profile's is `all.bar`, `chrome.bar`, then
 * `chrome.profiles.<name>.bar`. After a target's three-way merge, {@link absorbTargetTree}
 * puts each top-level node back in the layer it came from, so an edit made in one browser to
 * a shared folder lands in `all` and reaches every other browser, instead of splitting the
 * shared section into per-browser copies.
 */

import {
  BookmarkFolder,
  BookmarkLeaf,
  type BookmarkNode,
  type BookmarkSection,
  BookmarksConfig,
  BookmarkTree,
  ChromeBookmarks,
  ChromeProfileBookmarks,
  SafariBookmarks,
} from "./schema/__.ts";

export const sectionKeys = ["bar", "menu", "reading_list", "mobile"] as const;
export type SectionKey = (typeof sectionKeys)[number];

const supportedSectionsByBrowser: Record<string, readonly SectionKey[]> = {
  safari: ["bar", "menu", "reading_list"],
  chrome: ["bar", "menu", "reading_list", "mobile"],
};

export const sectionKeysForBrowser = (browser: string): readonly SectionKey[] =>
  supportedSectionsByBrowser[browser] ?? sectionKeys;

export interface LayerTarget {
  readonly browser: string;
  readonly profile?: string | undefined;
}

type Layer =
  | { readonly _tag: "all" }
  | { readonly _tag: "safari" }
  | { readonly _tag: "chrome" }
  | { readonly _tag: "chromeProfile"; readonly profile: string };

/**
 * The layers a target reads a section from, outermost first. Chrome's reading list is the
 * shared one only: the YAML has no Chrome-specific reading list.
 */
const layersFor = (target: LayerTarget, section: SectionKey): readonly Layer[] => {
  if (!sectionKeysForBrowser(target.browser).includes(section)) return [];
  switch (target.browser) {
    case "safari":
      return [{ _tag: "all" }, { _tag: "safari" }];
    case "chrome":
      if (section === "reading_list") return [{ _tag: "all" }];
      return target.profile
        ? [{ _tag: "all" }, { _tag: "chrome" }, { _tag: "chromeProfile", profile: target.profile }]
        : [{ _tag: "all" }, { _tag: "chrome" }];
    default:
      return [{ _tag: "all" }];
  }
};

const layerSection = (
  config: BookmarksConfig,
  layer: Layer,
  section: SectionKey,
): BookmarkSection | undefined => {
  switch (layer._tag) {
    case "all":
      return config.all[section];
    case "safari":
      return section === "mobile" ? undefined : config.safari?.[section];
    case "chrome":
      return section === "reading_list" ? undefined : config.chrome?.[section];
    case "chromeProfile":
      return section === "reading_list"
        ? undefined
        : config.chrome?.profiles?.[layer.profile]?.[section];
  }
};

const orUndefined = (nodes: BookmarkSection): BookmarkSection | undefined =>
  nodes.length > 0 ? nodes : undefined;

const withSection = <T extends Partial<Record<SectionKey, BookmarkSection | undefined>>>(
  value: T,
  section: SectionKey,
  nodes: BookmarkSection,
): T => Object.assign({}, value, { [section]: orUndefined(nodes) });

const withLayerSection = (
  config: BookmarksConfig,
  layer: Layer,
  section: SectionKey,
  nodes: BookmarkSection,
): BookmarksConfig => {
  switch (layer._tag) {
    case "all": {
      const all = config.all;
      return BookmarksConfig.make({
        version: config.version,
        all: BookmarkTree.make({
          bar: all.bar,
          menu: all.menu,
          reading_list: all.reading_list,
          mobile: all.mobile,
          [section]: orUndefined(nodes),
        }),
        safari: config.safari,
        chrome: config.chrome,
      });
    }
    case "safari": {
      if (section === "mobile") return config;
      if (!config.safari && nodes.length === 0) return config;
      const safari = config.safari;
      return BookmarksConfig.make({
        version: config.version,
        all: config.all,
        safari: SafariBookmarks.make(
          withSection(
            {
              enabled: safari?.enabled,
              bar: safari?.bar,
              menu: safari?.menu,
              reading_list: safari?.reading_list,
            },
            section,
            nodes,
          ),
        ),
        chrome: config.chrome,
      });
    }
    case "chrome": {
      if (section === "reading_list") return config;
      if (!config.chrome && nodes.length === 0) return config;
      const chrome = config.chrome;
      return BookmarksConfig.make({
        version: config.version,
        all: config.all,
        safari: config.safari,
        chrome: ChromeBookmarks.make(
          withSection(
            {
              enabled: chrome?.enabled,
              bar: chrome?.bar,
              menu: chrome?.menu,
              mobile: chrome?.mobile,
              profiles: chrome?.profiles,
            },
            section,
            nodes,
          ),
        ),
      });
    }
    case "chromeProfile": {
      if (section === "reading_list") return config;
      const existing = config.chrome?.profiles?.[layer.profile];
      if (!existing && nodes.length === 0) return config;
      const chrome = config.chrome;
      return BookmarksConfig.make({
        version: config.version,
        all: config.all,
        safari: config.safari,
        chrome: ChromeBookmarks.make({
          enabled: chrome?.enabled,
          bar: chrome?.bar,
          menu: chrome?.menu,
          mobile: chrome?.mobile,
          profiles: {
            ...chrome?.profiles,
            [layer.profile]: ChromeProfileBookmarks.make(
              withSection(
                {
                  enabled: existing?.enabled,
                  bar: existing?.bar,
                  menu: existing?.menu,
                  mobile: existing?.mobile,
                },
                section,
                nodes,
              ),
            ),
          },
        }),
      });
    }
  }
};

/** A top-level folder is known by its name, a top-level bookmark by its URL and name. */
const identityOf = (node: BookmarkNode): string =>
  BookmarkFolder.is(node)
    ? JSON.stringify(["folder", node.name])
    : JSON.stringify(["leaf", node.url, node.name]);

const leavesOf = (node: BookmarkNode): readonly BookmarkLeaf[] =>
  BookmarkLeaf.is(node) ? [node] : node.children.flatMap(leavesOf);

const leafKey = (leaf: BookmarkLeaf): string => JSON.stringify([leaf.url, leaf.name]);

/**
 * The outermost layer each bookmark lived in before the merge, by URL and name, and by URL
 * alone for a bookmark whose name changed.
 */
const bookmarkLayers = (layerNodes: readonly BookmarkSection[]) => {
  const byKey = new Map<string, number>();
  const byUrl = new Map<string, number>();
  layerNodes.forEach((nodes, layer) => {
    for (const leaf of nodes.flatMap(leavesOf)) {
      if (!byKey.has(leafKey(leaf))) byKey.set(leafKey(leaf), layer);
      if (!byUrl.has(leaf.url)) byUrl.set(leaf.url, layer);
    }
  });
  return (leaf: BookmarkLeaf): number | undefined =>
    byKey.get(leafKey(leaf)) ?? byUrl.get(leaf.url);
};

/**
 * The layer index for each merged top-level node. A node that existed keeps its layer. A node
 * renamed in a browser, or made of bookmarks moved there, takes the outermost layer its
 * bookmarks came from, so renaming a shared folder never hides its bookmarks from another
 * browser. A new node joins the layer of the node before it (or after it, at the start), so
 * additions to a shared section stay shared. Layers must appear in order, so a node placed
 * before a node of an outer layer moves out to that layer: a reorder never hides a shared node
 * from a browser.
 */
export const assignLayers = (
  layerNodes: readonly BookmarkSection[],
  merged: BookmarkSection,
): readonly number[] => {
  const available = new Map<string, number[]>();
  layerNodes.forEach((nodes, layer) => {
    for (const node of nodes) {
      const key = identityOf(node);
      const layers = available.get(key);
      if (layers) layers.push(layer);
      else available.set(key, [layer]);
    }
  });
  const layerOfBookmark = bookmarkLayers(layerNodes);
  const provenance = (node: BookmarkNode): number | undefined => {
    const layers = leavesOf(node).flatMap((leaf) => {
      const layer = layerOfBookmark(leaf);
      return layer === undefined ? [] : [layer];
    });
    return layers.length > 0 ? Math.min(...layers) : undefined;
  };

  const found = merged.map((node) => available.get(identityOf(node))?.shift() ?? provenance(node));
  const assigned: number[] = [];
  let previous: number | undefined;
  for (const layer of found) {
    previous = layer ?? previous;
    assigned.push(previous ?? -1);
  }
  let next: number | undefined;
  for (let index = assigned.length - 1; index >= 0; index--) {
    const layer = assigned[index] ?? -1;
    if (layer === -1) assigned[index] = next ?? 0;
    else next = layer;
  }
  for (let index = assigned.length - 2; index >= 0; index--) {
    assigned[index] = Math.min(assigned[index] ?? 0, assigned[index + 1] ?? 0);
  }
  return assigned;
};

/**
 * Write a target's tree into the config's layers, so that resolving the target from the
 * result gives back exactly `tree`. Sections the target's browser doesn't have are untouched.
 */
export const absorbTargetTree = (
  config: BookmarksConfig,
  target: LayerTarget,
  tree: BookmarkTree,
): BookmarksConfig => {
  let next = config;
  for (const section of sectionKeys) {
    const layers = layersFor(target, section);
    if (layers.length === 0) continue;
    const layerNodes = layers.map((layer) => layerSection(next, layer, section) ?? []);
    const merged = tree[section] ?? [];
    const assigned = assignLayers(layerNodes, merged);
    layers.forEach((layer, layerIndex) => {
      const nodes = merged.filter((_, index) => assigned[index] === layerIndex);
      next = withLayerSection(next, layer, section, nodes);
    });
  }
  return next;
};
