import * as Schema from "effect/Schema"

export interface WorkspaceBookmarkNode {
  kind: "bookmark"
  id: string
  title: string
  url: string
  sources?: string[] | undefined
}

export const WorkspaceBookmarkNode: Schema.Schema<WorkspaceBookmarkNode> = Schema.mutable(Schema.Struct({
  kind: Schema.Literal("bookmark"),
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  sources: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
}))

export interface WorkspaceSeparatorNode {
  kind: "separator"
  id: string
  sources?: string[] | undefined
  note?: string | undefined
}

export const WorkspaceSeparatorNode: Schema.Schema<WorkspaceSeparatorNode> = Schema.mutable(Schema.Struct({
  kind: Schema.Literal("separator"),
  id: Schema.String,
  sources: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  note: Schema.optional(Schema.String),
}))

export interface WorkspaceRawNode {
  kind: "raw"
  id: string
  title: string
  nativeKinds: string[]
  sources?: string[] | undefined
  note?: string | undefined
}

export const WorkspaceRawNode: Schema.Schema<WorkspaceRawNode> = Schema.mutable(Schema.Struct({
  kind: Schema.Literal("raw"),
  id: Schema.String,
  title: Schema.String,
  nativeKinds: Schema.mutable(Schema.Array(Schema.String)),
  sources: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  note: Schema.optional(Schema.String),
}))

export interface WorkspaceFolderNode {
  kind: "folder"
  id: string
  title: string
  children: WorkspaceNode[]
  sources?: string[] | undefined
}

export type WorkspaceNode =
  | WorkspaceBookmarkNode
  | WorkspaceFolderNode
  | WorkspaceSeparatorNode
  | WorkspaceRawNode

export const WorkspaceNode: Schema.Schema<WorkspaceNode> = Schema.mutable(Schema.Union(
  WorkspaceBookmarkNode,
  Schema.suspend((): Schema.Schema<WorkspaceFolderNode> => WorkspaceFolderNode),
  WorkspaceSeparatorNode,
  WorkspaceRawNode,
).annotations({ identifier: "WorkspaceNode" }))

export const WorkspaceSection: Schema.Schema<WorkspaceNode[]> = Schema.mutable(Schema.Array(WorkspaceNode))
export type WorkspaceSection = WorkspaceNode[]

export const WorkspaceFolderNode: Schema.Schema<WorkspaceFolderNode> = Schema.mutable(Schema.Struct({
  kind: Schema.Literal("folder"),
  id: Schema.String,
  title: Schema.String,
  children: Schema.mutable(Schema.Array(WorkspaceNode)),
  sources: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
}))

export interface WorkspaceTree {
  bar?: WorkspaceNode[] | undefined
  menu?: WorkspaceNode[] | undefined
  reading_list?: WorkspaceNode[] | undefined
  mobile?: WorkspaceNode[] | undefined
}

export const WorkspaceTree: Schema.Schema<WorkspaceTree> = Schema.mutable(Schema.Struct({
  bar: Schema.optional(WorkspaceSection),
  menu: Schema.optional(WorkspaceSection),
  reading_list: Schema.optional(WorkspaceSection),
  mobile: Schema.optional(WorkspaceSection),
}))

export interface WorkspaceTarget {
  browser: string
  profile?: string | undefined
  path: string
  enabled?: boolean | undefined
}

export const WorkspaceTarget: Schema.Schema<WorkspaceTarget> = Schema.mutable(Schema.Struct({
  browser: Schema.String,
  profile: Schema.optional(Schema.String),
  path: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
}))

export interface WorkspaceScopedTrees {
  global: WorkspaceTree
  profiles: Record<string, WorkspaceTree>
}

export const WorkspaceScopedTrees: Schema.Schema<WorkspaceScopedTrees> = Schema.mutable(Schema.Struct({
  global: WorkspaceTree,
  profiles: Schema.Record({ key: Schema.String, value: WorkspaceTree }),
}))

export interface WorkspaceFile {
  version: 1
  snapshotId: string
  importedAt: string
  targets: Record<string, WorkspaceTarget>
  inbox: Record<string, WorkspaceTree>
  publish: WorkspaceScopedTrees
  archive: WorkspaceScopedTrees
  quarantine: WorkspaceScopedTrees
}

export const WorkspaceFile: Schema.Schema<WorkspaceFile> = Schema.mutable(Schema.Struct({
  version: Schema.Literal(1),
  snapshotId: Schema.String,
  importedAt: Schema.String,
  targets: Schema.Record({ key: Schema.String, value: WorkspaceTarget }),
  inbox: Schema.Record({ key: Schema.String, value: WorkspaceTree }),
  publish: WorkspaceScopedTrees,
  archive: WorkspaceScopedTrees,
  quarantine: WorkspaceScopedTrees,
}))
