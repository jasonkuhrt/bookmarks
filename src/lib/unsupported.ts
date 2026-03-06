import { Data } from "effect"
import { BookmarkFolder, BookmarkLeaf, BookmarkSection, BookmarkTree } from "./schema/__.js"

export interface BookmarkIssue {
  readonly code: "duplicate-url" | "separator" | "unsupported-node"
  readonly path: string
  readonly message: string
}

export class UnsupportedBookmarks extends Data.TaggedError("UnsupportedBookmarks")<{
  readonly source: string
  readonly issues: readonly BookmarkIssue[]
}> {
  static is = (u: unknown): u is UnsupportedBookmarks =>
    u != null && typeof u === "object" && "_tag" in u && u._tag === "UnsupportedBookmarks"

  override get message(): string {
    return [
      `Cannot safely mutate bookmarks because ${this.source} contains unsupported constructs:`,
      ...this.issues.map((issue) => `- ${issue.path}: ${issue.message}`),
      "",
      "Resolve the listed duplicate URLs or separators and retry. These constructs cannot round-trip safely yet.",
    ].join("\n")
  }
}

export const collectDuplicateUrlIssues = (
  tree: BookmarkTree,
): readonly BookmarkIssue[] => {
  const issues: BookmarkIssue[] = []
  const seen = new Set<string>()

  const visit = (nodes: BookmarkSection | undefined, path: string): void => {
    if (!nodes) return

    for (const node of nodes) {
      if (BookmarkLeaf.is(node)) {
        const leafPath = `${path}/${node.name}`
        if (seen.has(node.url)) {
          issues.push({
            code: "duplicate-url",
            path: leafPath,
            message: `Duplicate URL "${node.url}" is not supported; bookmark identity is URL-based so mutation would be ambiguous.`,
          })
          continue
        }

        seen.add(node.url)
        continue
      }

      if (BookmarkFolder.is(node)) {
        visit(node.children as BookmarkSection, `${path}/${node.name}`)
      }
    }
  }

  for (const sectionKey of ["favorites_bar", "other", "reading_list", "mobile"] as const) {
    visit(tree[sectionKey], sectionKey)
  }

  return issues
}

export const separatorIssue = (path: string, detail: string): BookmarkIssue => ({
  code: "separator",
  path,
  message: `Bookmark separators are not supported. ${detail}`,
})

export const unsupportedNodeIssue = (path: string, detail: string): BookmarkIssue => ({
  code: "unsupported-node",
  path,
  message: detail,
})
