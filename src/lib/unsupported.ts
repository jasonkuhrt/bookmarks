import { Data, Effect, HashSet } from "effect";
import type { BookmarkSection, BookmarkTree } from "./schema/__.ts";
import { BookmarkFolder } from "./schema/__.ts";

export interface BookmarkIssue {
  readonly code: "ambiguous-path" | "separator" | "unsupported-node";
  readonly path: string;
  readonly message: string;
}

export const collectAmbiguousPathIssues = (tree: BookmarkTree): readonly BookmarkIssue[] => {
  const issues: BookmarkIssue[] = [];

  const visit = (nodes: BookmarkSection | undefined, path: string): void => {
    let folderNames = HashSet.empty<string>();
    for (const node of nodes ?? []) {
      if (!BookmarkFolder.is(node)) continue;
      const folderPath = `${path}/${node.name}`;
      if (node.name.includes("/")) {
        issues.push({
          code: "ambiguous-path",
          path: folderPath,
          message: "Folder names containing '/' cannot be addressed safely.",
        });
      }
      if (HashSet.has(folderNames, node.name)) {
        issues.push({
          code: "ambiguous-path",
          path: folderPath,
          message: `Sibling bookmark folders named "${node.name}" cannot be addressed safely.`,
        });
      } else {
        folderNames = HashSet.add(folderNames, node.name);
      }
      visit(node.children, folderPath);
    }
  };

  for (const sectionKey of ["bar", "menu", "reading_list", "mobile"] as const) {
    visit(tree[sectionKey], sectionKey);
  }
  return issues;
};

export const ensureUnambiguousPaths = (
  tree: BookmarkTree,
  source: string,
): Effect.Effect<void, UnsupportedBookmarks> => {
  const issues = collectAmbiguousPathIssues(tree);
  return issues.length === 0
    ? Effect.void
    : Effect.fail(new UnsupportedBookmarks({ source, issues }));
};

export class UnsupportedBookmarks extends Data.TaggedError("UnsupportedBookmarks")<{
  readonly source: string;
  readonly issues: readonly BookmarkIssue[];
}> {
  static is = (u: unknown): u is UnsupportedBookmarks =>
    u !== null && typeof u === "object" && "_tag" in u && u._tag === "UnsupportedBookmarks";

  override get message(): string {
    return [
      `Cannot safely mutate bookmarks because ${this.source} contains unsupported constructs:`,
      ...this.issues.map((issue) => `- ${issue.path}: ${issue.message}`),
      "",
      "Resolve the listed unsupported bookmark constructs and retry.",
    ].join("\n");
  }
}

export const separatorIssue = (path: string, detail: string): BookmarkIssue => ({
  code: "separator",
  path,
  message: `Bookmark separators are not supported. ${detail}`,
});

export const unsupportedNodeIssue = (path: string, detail: string): BookmarkIssue => ({
  code: "unsupported-node",
  path,
  message: detail,
});
