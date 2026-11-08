/**
 * One form for every URL and name the sync engine compares.
 *
 * Browsers store the same bookmark differently: Chrome canonicalizes URLs and
 * strips line breaks from titles, Safari keeps what it was given. The engine
 * reads every tree (YAML, Safari, Chrome, baselines) through these functions,
 * so one bookmark compares equal wherever it lives. The form is Chrome's,
 * because Chrome rewrites anything else on write and the write then fails its
 * read-back check.
 */

import {
  BookmarkFolder,
  BookmarkLeaf,
  type BookmarkNode,
  BookmarksConfig,
  BookmarkTree,
  ChromeBookmarks,
  ChromeProfileBookmarks,
  SafariBookmarks,
} from "./schema/__.ts";

/**
 * Chrome's `javascript:` form: the WHATWG serialization, plus `'` escaped in
 * the query. Chrome applies the special-scheme query set to `javascript:`, so
 * `?url='+x` is stored as `?url=%27+x`, while a `'` before the `?` or in the
 * fragment stays as typed.
 */
const canonicalJavascriptUrl = (url: string): string => {
  const href = new URL(url).href;
  const fragmentStart = href.indexOf("#");
  const queryEnd = fragmentStart === -1 ? href.length : fragmentStart;
  const queryStart = href.indexOf("?");
  if (queryStart === -1 || queryStart > queryEnd) return href;
  return (
    href.slice(0, queryStart) +
    href.slice(queryStart, queryEnd).replaceAll("'", "%27") +
    href.slice(queryEnd)
  );
};

/** A URL the parser rejects stays as written; Chrome refuses it on write with its own error. */
export const canonicalUrl = (url: string): string => {
  try {
    if (/^https?:/i.test(url)) return new URL(url).href;
    if (/^javascript:/i.test(url)) return canonicalJavascriptUrl(url);
  } catch {
    return url;
  }
  return url;
};

/** Chrome replaces each line break, tab and Unicode line or paragraph separator in a title with a space. */
export const canonicalName = (name: string): string =>
  name.replaceAll(/[\n\r\t\u2028\u2029]/g, " ");

const canonicalNode = (node: BookmarkNode): BookmarkNode =>
  BookmarkLeaf.is(node)
    ? BookmarkLeaf.make({ name: canonicalName(node.name), url: canonicalUrl(node.url) })
    : BookmarkFolder.make({
        name: canonicalName(node.name),
        children: node.children.map(canonicalNode),
      });

const canonicalSection = (
  nodes: readonly BookmarkNode[] | undefined,
): readonly BookmarkNode[] | undefined => nodes?.map(canonicalNode);

export const canonicalTree = (tree: BookmarkTree): BookmarkTree =>
  BookmarkTree.make({
    ...(tree.bar ? { bar: tree.bar.map(canonicalNode) } : {}),
    ...(tree.menu ? { menu: tree.menu.map(canonicalNode) } : {}),
    ...(tree.reading_list ? { reading_list: tree.reading_list.map(canonicalNode) } : {}),
    ...(tree.mobile ? { mobile: tree.mobile.map(canonicalNode) } : {}),
  });

export const canonicalConfig = (config: BookmarksConfig): BookmarksConfig =>
  BookmarksConfig.make({
    version: config.version,
    all: canonicalTree(config.all),
    ...(config.safari
      ? {
          safari: SafariBookmarks.make({
            enabled: config.safari.enabled,
            bar: canonicalSection(config.safari.bar),
            menu: canonicalSection(config.safari.menu),
            reading_list: canonicalSection(config.safari.reading_list),
          }),
        }
      : {}),
    ...(config.chrome
      ? {
          chrome: ChromeBookmarks.make({
            enabled: config.chrome.enabled,
            bar: canonicalSection(config.chrome.bar),
            menu: canonicalSection(config.chrome.menu),
            mobile: canonicalSection(config.chrome.mobile),
            profiles: config.chrome.profiles
              ? Object.fromEntries(
                  Object.entries(config.chrome.profiles).map(([profile, profileConfig]) => [
                    profile,
                    ChromeProfileBookmarks.make({
                      enabled: profileConfig.enabled,
                      bar: canonicalSection(profileConfig.bar),
                      menu: canonicalSection(profileConfig.menu),
                      mobile: canonicalSection(profileConfig.mobile),
                    }),
                  ]),
                )
              : undefined,
          }),
        }
      : {}),
  });
