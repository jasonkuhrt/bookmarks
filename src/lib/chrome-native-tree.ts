import { BookmarkFolder, BookmarkLeaf, BookmarkTree, type BookmarkNode } from "./schema/__.ts";

/** Chrome stores HTTP(S) URLs in canonical form; bookmarklet source stays byte-for-byte intact. */
export const canonicalUrl = (url: string): string =>
  /^https?:/i.test(url) ? new URL(url).href : url;

const canonicalNode = (node: BookmarkNode): BookmarkNode =>
  BookmarkLeaf.is(node)
    ? BookmarkLeaf.make({ name: node.name, url: canonicalUrl(node.url) })
    : BookmarkFolder.make({ name: node.name, children: node.children.map(canonicalNode) });

export const canonicalTree = (tree: BookmarkTree): BookmarkTree =>
  BookmarkTree.make({
    ...(tree.reading_list ? { reading_list: tree.reading_list } : {}),
    ...(tree.bar ? { bar: tree.bar.map(canonicalNode) } : {}),
    ...(tree.menu ? { menu: tree.menu.map(canonicalNode) } : {}),
    ...(tree.mobile ? { mobile: tree.mobile.map(canonicalNode) } : {}),
  });
