import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { DateTime, Effect, Schema } from "effect"
import * as Yaml from "yaml"
import * as Chrome from "./chrome.js"
import * as ManagedPaths from "./managed-paths.js"
import * as Patch from "./patch.js"
import * as Paths from "./paths.js"
import * as Permissions from "./permissions.js"
import * as Safari from "./safari.js"
import { BookmarkFolder, BookmarkLeaf, type BookmarkNode, BookmarkTree } from "./schema/__.js"
import {
  WorkspaceFile as WorkspaceFileSchema,
  type WorkspaceFile,
  type WorkspaceNode,
  type WorkspaceScopedTrees,
  type WorkspaceTarget,
  type WorkspaceTree,
} from "./schema/workspace.js"
import * as Targets from "./targets.js"
import type {
  ImportLock,
  ImportedTargetSnapshot,
  WorkspaceNextAction,
  WorkspaceNextResult,
  WorkspacePlan,
  WorkspacePlanBlocker,
  WorkspacePlanTarget,
} from "./workspace-types.js"
import * as YamlModule from "./yaml.js"

export interface WorkspaceBackupResult {
  readonly backupDir: string
  readonly files: readonly string[]
  readonly skipped: readonly string[]
}

export interface WorkspaceImportResult {
  readonly workspacePath: string
  readonly importLockPath: string
  readonly snapshotId: string
  readonly targets: readonly string[]
  readonly backup: WorkspaceBackupResult | null
}

export interface WorkspaceValidationResult {
  readonly workspacePath: string
  readonly valid: boolean
  readonly errors: readonly string[]
}

export interface WorkspacePublishResult {
  readonly plan: WorkspacePlan
  readonly backup: WorkspaceBackupResult
  readonly publishedTargets: readonly string[]
}

const WORKSPACE_MODELINE = "# bookmarks-workspace: version=1\n"
const sectionKeys = ["favorites_bar", "other", "reading_list", "mobile"] as const

const emptyTree = (): WorkspaceTree => ({})
const emptyScopedTrees = (): WorkspaceScopedTrees => ({ global: {}, profiles: {} })

const exists = (path: string): Effect.Effect<boolean, Error> =>
  Effect.tryPromise({
    try: () => Fs.access(path).then(() => true, () => false),
    catch: (e) => new Error(`Failed to inspect ${path}: ${e}`),
  })

const readJsonFile = <A>(path: string): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: async () => JSON.parse(await Fs.readFile(path, "utf-8")) as A,
    catch: (e) => new Error(`Failed to read ${path}: ${e}`),
  })

const writeJsonFile = (path: string, value: unknown): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* ManagedPaths.ensureParentDir(path)
    yield* Effect.tryPromise({
      try: () => Fs.writeFile(path, JSON.stringify(value, null, 2), "utf-8"),
      catch: (e) => new Error(`Failed to write ${path}: ${e}`),
    })
  })

const sanitizeTree = (tree: WorkspaceTree): WorkspaceTree => {
  const next: WorkspaceTree = {}
  for (const key of sectionKeys) {
    const nodes = tree[key]
    if (nodes && nodes.length > 0) next[key] = nodes
  }
  return next
}

const sanitizeScopedTrees = (scopedTrees: WorkspaceScopedTrees): WorkspaceScopedTrees => ({
  global: sanitizeTree(scopedTrees.global),
  profiles: Object.fromEntries(
    Object.entries(scopedTrees.profiles)
      .map(([targetId, tree]) => [targetId, sanitizeTree(tree)] as const)
      .filter(([, tree]) => countNodes(tree) > 0),
  ),
})

const countNodes = (tree: WorkspaceTree): number => {
  const countSection = (nodes: readonly WorkspaceNode[] | undefined): number =>
    (nodes ?? []).reduce((total, node) =>
      total + 1 + (node.kind === "folder" ? countSection(node.children) : 0), 0)
  return sectionKeys.reduce((total, key) => total + countSection(tree[key]), 0)
}

const countInboxNodes = (inbox: Readonly<Record<string, WorkspaceTree>>): number =>
  Object.values(inbox).reduce((total, tree) => total + countNodes(tree), 0)

const countScopedNodes = (scopedTrees: WorkspaceScopedTrees): number =>
  countNodes(scopedTrees.global)
  + Object.values(scopedTrees.profiles).reduce((total, tree) => total + countNodes(tree), 0)

const workspaceFiles = () => ({
  workspacePath: Paths.defaultWorkspacePath(),
  importLockPath: Paths.defaultImportLockPath(),
  planPath: Paths.defaultPublishPlanPath(),
})

const workspaceHash = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex")

const runCommandAction = (command: string, message: string): WorkspaceNextAction => ({
  kind: "run_command",
  command,
  message,
})

const editFileAction = (path: string, message: string): WorkspaceNextAction => ({
  kind: "edit_file",
  path,
  message,
})

const doneAction = (message: string): WorkspaceNextAction => ({
  kind: "done",
  message,
})

const targetToDescriptor = (target: WorkspaceTarget): Targets.TargetDescriptor => ({
  browser: target.browser,
  profile: target.profile,
  path: target.path,
  enabled: target.enabled ?? true,
})

const normalizeWorkspaceDocument = (value: unknown): Effect.Effect<unknown, Error> =>
  Effect.try({
    try: () => {
      if (value == null || typeof value !== "object") return value
      if ("publish" in value) return value
      if (!("canonical" in value)) return value

      const legacy = value as {
        version: 1
        snapshotId: string
        importedAt: string
        targets: Record<string, WorkspaceTarget>
        inbox: Record<string, WorkspaceTree>
        canonical: WorkspaceTree
        archive: WorkspaceTree
        quarantine: WorkspaceTree
      }

      return {
        version: legacy.version,
        snapshotId: legacy.snapshotId,
        importedAt: legacy.importedAt,
        targets: legacy.targets,
        inbox: legacy.inbox,
        publish: { global: legacy.canonical ?? {}, profiles: {} },
        archive: { global: legacy.archive ?? {}, profiles: {} },
        quarantine: { global: legacy.quarantine ?? {}, profiles: {} },
      } satisfies WorkspaceFile
    },
    catch: (e) => new Error(`Failed to normalize workspace document: ${e}`),
  })

const makeSnapshotId = (): string =>
  `snap_${DateTime.formatIso(DateTime.unsafeNow()).replaceAll(/[:.-]/g, "")}`

const nonEmptyOrUndefined = <A>(items: A[]): [A, ...A[]] | undefined =>
  items.length > 0 ? [items[0]!, ...items.slice(1)] : undefined

export const load = (path = Paths.defaultWorkspacePath()): Effect.Effect<WorkspaceFile, Error> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => Fs.readFile(path, "utf-8"),
      catch: (e) => new Error(`Failed to read ${path}: ${e}`),
    })
    const parsed = yield* Effect.try({
      try: () => Yaml.parse(raw) as unknown,
      catch: (e) => new Error(`Failed to parse ${path}: ${e}`),
    })
    const normalized = yield* normalizeWorkspaceDocument(parsed)
    return yield* Schema.decodeUnknown(WorkspaceFileSchema)(normalized).pipe(
      Effect.mapError((e) => new Error(`Workspace validation failed: ${e.message}`)),
    )
  })

export const save = (path: string, workspace: WorkspaceFile): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const normalizedWorkspace: WorkspaceFile = {
      ...workspace,
      inbox: Object.fromEntries(
        Object.entries(workspace.inbox)
          .map(([targetId, tree]) => [targetId, sanitizeTree(tree)] as const)
          .filter(([, tree]) => countNodes(tree) > 0),
      ),
      publish: sanitizeScopedTrees(workspace.publish),
      archive: sanitizeScopedTrees(workspace.archive),
      quarantine: sanitizeScopedTrees(workspace.quarantine),
    }
    const encoded = yield* Schema.encode(WorkspaceFileSchema)(normalizedWorkspace).pipe(
      Effect.mapError((e) => new Error(`Failed to encode workspace: ${e.message}`)),
    )
    const yaml = WORKSPACE_MODELINE + Yaml.stringify(encoded, { indent: 2 })
    yield* ManagedPaths.ensureParentDir(path)
    yield* Effect.tryPromise({
      try: () => Fs.writeFile(path, yaml, "utf-8"),
      catch: (e) => new Error(`Failed to write ${path}: ${e}`),
    })
  })

export const loadImportLock = (path = Paths.defaultImportLockPath()): Effect.Effect<ImportLock, Error> =>
  readJsonFile<ImportLock>(path)

const saveImportLock = (path: string, value: ImportLock): Effect.Effect<void, Error> =>
  writeJsonFile(path, value)

export const loadPlan = (path = Paths.defaultPublishPlanPath()): Effect.Effect<WorkspacePlan, Error> =>
  readJsonFile<WorkspacePlan>(path)

const savePlan = (path: string, value: WorkspacePlan): Effect.Effect<void, Error> =>
  writeJsonFile(path, value)

const backupArtifacts = (
  label: string,
  candidates: readonly { readonly label: string; readonly path: string }[],
): Effect.Effect<WorkspaceBackupResult, Error> =>
  Effect.gen(function* () {
    const backupDir = Paths.defaultBackupDir()
    const timestamp = DateTime.formatIso(DateTime.unsafeNow())
      .replaceAll(":", "-")
      .replaceAll(".", "-")
    const files: string[] = []
    const skipped: string[] = []

    yield* ManagedPaths.ensureDir(backupDir)

    for (const candidate of candidates) {
      const candidateExists = yield* exists(candidate.path)
      if (!candidateExists) {
        skipped.push(candidate.label)
        continue
      }

      const destination = Path.join(
        backupDir,
        `${timestamp}--${label}--${candidate.label.replaceAll("/", "--")}--${Path.basename(candidate.path)}`,
      )
      yield* Effect.tryPromise({
        try: () => Fs.copyFile(candidate.path, destination),
        catch: (e) => new Error(`Failed to back up ${candidate.path}: ${e}`),
      })
      files.push(destination)
    }

    return { backupDir, files, skipped }
  })

const loadOptionalWorkspaceTargets = (): Effect.Effect<Readonly<Record<string, WorkspaceTarget>> | undefined, Error> =>
  Effect.gen(function* () {
    const workspacePath = Paths.defaultWorkspacePath()
    if (!(yield* exists(workspacePath))) return undefined
    return (yield* load(workspacePath)).targets
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

const loadOptionalYamlTargets = (): Effect.Effect<Readonly<Record<string, WorkspaceTarget>> | undefined, Error> =>
  Effect.gen(function* () {
    const yamlPath = Paths.defaultYamlPath()
    if (!(yield* exists(yamlPath))) return undefined
    const config = yield* YamlModule.load(yamlPath)
    const targets = Object.fromEntries(
      Targets.listTargets(config).map((target) => [
        Targets.keyOf(target),
        {
          browser: target.browser,
          profile: target.profile,
          path: target.path,
          enabled: target.enabled,
        } satisfies WorkspaceTarget,
      ]),
    )
    return targets
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

const discoverTargets = (): Effect.Effect<Readonly<Record<string, WorkspaceTarget>>, Error> =>
  Targets.discoverTargets().pipe(
    Effect.map((targets) =>
      Object.fromEntries(
        targets.map((target) => [
          Targets.keyOf(target),
          {
            browser: target.browser,
            profile: target.profile,
            path: target.path,
            enabled: target.enabled,
          } satisfies WorkspaceTarget,
        ]),
      ),
    ),
  )

const mergeTargetRegistries = (
  ...registries: ReadonlyArray<Readonly<Record<string, WorkspaceTarget>> | undefined>
): Readonly<Record<string, WorkspaceTarget>> =>
  Object.assign({}, ...registries.filter((registry): registry is Readonly<Record<string, WorkspaceTarget>> => registry !== undefined))

const resolveTargets = (requestedTargetIds: readonly string[]): Effect.Effect<Readonly<Record<string, WorkspaceTarget>>, Error> =>
  Effect.gen(function* () {
    const discoveredTargets = yield* discoverTargets()
    const yamlTargets = yield* loadOptionalYamlTargets()
    const workspaceTargets = yield* loadOptionalWorkspaceTargets()
    const registry = mergeTargetRegistries(discoveredTargets, yamlTargets, workspaceTargets)

    if (Object.keys(registry).length === 0) {
      return yield* Effect.fail(new Error(
        "No bookmark targets were discovered or configured. Install a supported browser profile or add explicit targets to bookmarks.yaml.",
      ))
    }

    const resolvedDescriptors = yield* Targets.resolveTargetSelectors(
      Object.values(registry).map(targetToDescriptor),
      requestedTargetIds,
    )

    return Object.fromEntries(
      resolvedDescriptors.map((descriptor) => {
        const key = Targets.keyOf(descriptor)
        return [key, registry[key]!]
      }),
    )
  })

const importTarget = (
  targetId: string,
  target: WorkspaceTarget,
): Effect.Effect<ImportedTargetSnapshot, Error> => {
  switch (target.browser) {
    case "chrome":
      return Chrome.importBookmarks(target.path, targetId)
    case "safari":
      return Safari.importBookmarks(target.path, targetId)
    default:
      return Effect.fail(new Error(`Unsupported import target ${targetId}`))
  }
}

const walkTree = (
  tree: WorkspaceTree,
  visit: (node: WorkspaceNode, path: readonly string[]) => void,
): void => {
  const walkSection = (nodes: readonly WorkspaceNode[] | undefined, parentPath: readonly string[]) => {
    for (const node of nodes ?? []) {
      const path = parentPath.concat(node.kind === "folder" || node.kind === "bookmark" || node.kind === "raw"
        ? node.title
        : node.id)
      visit(node, path)
      if (node.kind === "folder") walkSection(node.children, path)
    }
  }

  for (const key of sectionKeys) walkSection(tree[key], [key])
}

const walkScopedTrees = (
  scopedTrees: WorkspaceScopedTrees,
  visit: (node: WorkspaceNode, path: readonly string[]) => void,
): void => {
  walkTree(scopedTrees.global, (node, path) => visit(node, ["global", ...path]))
  for (const [targetId, tree] of Object.entries(scopedTrees.profiles)) {
    walkTree(tree, (node, path) => visit(node, ["profiles", targetId, ...path]))
  }
}

const validateAgainstImportLock = (
  workspace: WorkspaceFile,
  importLock: ImportLock,
): readonly string[] => {
  const errors: string[] = []
  const allOccurrences = new Set(
    Object.values(importLock.targets).flatMap((target) => target.occurrences.map((occurrence) => occurrence.id)),
  )
  const seenNodeIds = new Set<string>()

  for (const targetId of Object.keys(workspace.inbox)) {
    if (!workspace.targets[targetId]) {
      errors.push(`Inbox target ${targetId} is not present in workspace.targets`)
    }
  }

  for (const collection of [workspace.publish, workspace.archive, workspace.quarantine]) {
    for (const targetId of Object.keys(collection.profiles)) {
      if (!workspace.targets[targetId]) {
        errors.push(`Scoped tree target ${targetId} is not present in workspace.targets`)
      }
    }
  }

  const validateTree = (tree: WorkspaceTree, label: string) => {
    walkTree(tree, (node, path) => {
      if (seenNodeIds.has(node.id)) {
        errors.push(`Duplicate workspace node id ${node.id} at ${label}/${path.join("/")}`)
      } else {
        seenNodeIds.add(node.id)
      }

      for (const source of node.sources ?? []) {
        if (!allOccurrences.has(source)) {
          errors.push(`Unknown source occurrence ${source} referenced at ${label}/${path.join("/")}`)
        }
      }
    })
  }

  for (const [targetId, tree] of Object.entries(workspace.inbox)) {
    validateTree(tree, `inbox/${targetId}`)
  }

  const validateScoped = (scopedTrees: WorkspaceScopedTrees, label: string) => {
    walkScopedTrees(scopedTrees, (node, path) => {
      if (seenNodeIds.has(node.id)) {
        errors.push(`Duplicate workspace node id ${node.id} at ${label}/${path.join("/")}`)
      } else {
        seenNodeIds.add(node.id)
      }

      for (const source of node.sources ?? []) {
        if (!allOccurrences.has(source)) {
          errors.push(`Unknown source occurrence ${source} referenced at ${label}/${path.join("/")}`)
        }
      }
    })
  }

  validateScoped(workspace.publish, "publish")
  validateScoped(workspace.archive, "archive")
  validateScoped(workspace.quarantine, "quarantine")

  return errors
}

export const validate = (): Effect.Effect<WorkspaceValidationResult, Error> =>
  Effect.gen(function* () {
    const { workspacePath, importLockPath } = workspaceFiles()
    const workspace = yield* load(workspacePath)
    const importLock = yield* loadImportLock(importLockPath)
    const errors = validateAgainstImportLock(workspace, importLock)
    return {
      workspacePath,
      valid: errors.length === 0,
      errors,
    }
  })

const mergeBookmarkTrees = (base: BookmarkTree, overlay: BookmarkTree): BookmarkTree =>
  BookmarkTree.make({
    favorites_bar: nonEmptyOrUndefined([...(base.favorites_bar ?? []), ...(overlay.favorites_bar ?? [])]),
    other: nonEmptyOrUndefined([...(base.other ?? []), ...(overlay.other ?? [])]),
    reading_list: nonEmptyOrUndefined([...(base.reading_list ?? []), ...(overlay.reading_list ?? [])]),
    mobile: nonEmptyOrUndefined([...(base.mobile ?? []), ...(overlay.mobile ?? [])]),
  })

const convertTreeForPublish = (
  tree: WorkspaceTree,
  locationRoot: readonly string[],
  targetId?: string,
  seededUrls = new Map<string, string>(),
): { readonly tree: BookmarkTree; readonly blockers: readonly WorkspacePlanBlocker[]; readonly seenUrls: ReadonlyMap<string, string> } => {
  const blockers: WorkspacePlanBlocker[] = []
  const seenUrls = new Map(seededUrls)

  const convertSection = (
    nodes: WorkspaceNode[] | undefined,
    parentPath: readonly string[],
  ): BookmarkNode[] => {
    const next: BookmarkNode[] = []

    for (const node of nodes ?? []) {
      const location = parentPath.concat(
        node.kind === "folder" || node.kind === "bookmark" || node.kind === "raw"
          ? node.title
          : node.id,
      ).join("/")

      switch (node.kind) {
        case "bookmark": {
          const first = seenUrls.get(node.url)
          if (first) {
            blockers.push({
              code: "duplicate-url",
              location,
              message: `Duplicate URL "${node.url}" also appears at ${first}.`,
              ...(targetId ? { targetId } : {}),
            })
            continue
          }
          seenUrls.set(node.url, location)
          next.push(BookmarkLeaf.make({ name: node.title, url: node.url }))
          continue
        }
        case "folder": {
          next.push(BookmarkFolder.make({
            name: node.title,
            children: convertSection(node.children, parentPath.concat(node.title)),
          }))
          continue
        }
        case "separator":
          blockers.push({
            code: "unsupported-node",
            location,
            message: "Separators are imported for review but cannot be published yet.",
            ...(targetId ? { targetId } : {}),
          })
          continue
        case "raw":
          blockers.push({
            code: "unsupported-node",
            location,
            message: `Raw node "${node.title}" must be resolved before publish.`,
            ...(targetId ? { targetId } : {}),
          })
          continue
      }
    }

    return next
  }

  const bookmarkTree = BookmarkTree.make({
    favorites_bar: nonEmptyOrUndefined(convertSection(tree.favorites_bar, [...locationRoot, "favorites_bar"])),
    other: nonEmptyOrUndefined(convertSection(tree.other, [...locationRoot, "other"])),
    reading_list: nonEmptyOrUndefined(convertSection(tree.reading_list, [...locationRoot, "reading_list"])),
    mobile: nonEmptyOrUndefined(convertSection(tree.mobile, [...locationRoot, "mobile"])),
  })

  return { tree: bookmarkTree, blockers, seenUrls }
}

const planSummary = (
  workspace: WorkspaceFile,
  blockers: readonly WorkspacePlanBlocker[],
  targets: WorkspacePlan["targets"],
): WorkspacePlan["summary"] => ({
  inboxItems: countInboxNodes(workspace.inbox),
  canonicalItems: countScopedNodes(workspace.publish),
  archiveItems: countScopedNodes(workspace.archive),
  quarantineItems: countScopedNodes(workspace.quarantine),
  targetCount: targets.length,
  readyTargetCount: targets.filter((target) => target.status === "ready").length,
  blockerCount: blockers.length,
})

const buildPlan = (
  workspace: WorkspaceFile,
  workspacePath: string,
  workspaceHashValue: string,
  requestedTargetIds: readonly string[],
): Effect.Effect<{ readonly plan: WorkspacePlan; readonly publishTrees: Readonly<Record<string, BookmarkTree>> }, Error> =>
  Effect.gen(function* () {
    const blockers: WorkspacePlanBlocker[] = []
    const inboxItems = countInboxNodes(workspace.inbox)
    if (inboxItems > 0) {
      blockers.push({
        code: "review-inbox",
        message: `${inboxItems} inbox item(s) remain unresolved.`,
      })
    }

    const quarantineItems = countScopedNodes(workspace.quarantine)
    if (quarantineItems > 0) {
      blockers.push({
        code: "review-quarantine",
        message: `${quarantineItems} quarantined item(s) remain unresolved.`,
      })
    }

    const convertedGlobal = convertTreeForPublish(workspace.publish.global, ["publish", "global"])
    blockers.push(...convertedGlobal.blockers)

    const selectedTargets = yield* Targets.resolveTargetSelectors(
      Object.values(workspace.targets).map(targetToDescriptor),
      requestedTargetIds,
    )

    const targets: WorkspacePlanTarget[] = []
    const publishTrees: Record<string, BookmarkTree> = {}
    for (const descriptor of selectedTargets) {
      const targetId = Targets.keyOf(descriptor)
      const target = workspace.targets[targetId]!
      const targetBlockers: WorkspacePlanBlocker[] = []
      const targetEnabled = target.enabled ?? true
      if (targetEnabled) {
        const convertedProfile = convertTreeForPublish(
          workspace.publish.profiles[targetId] ?? emptyTree(),
          ["publish", "profiles", targetId],
          targetId,
          new Map(convertedGlobal.seenUrls),
        )
        targetBlockers.push(...convertedProfile.blockers)
        publishTrees[targetId] = mergeBookmarkTrees(convertedGlobal.tree, convertedProfile.tree)
      }

      if (targetEnabled && !(yield* exists(target.path))) {
        targetBlockers.push({
          code: "target-unavailable",
          targetId,
          location: target.path,
          message: `Configured target is unavailable at ${target.path}.`,
        })
      }

      if (targetEnabled && Targets.requiresFullDiskAccess(targetToDescriptor(target))) {
        const fullDiskAccess = yield* Permissions.checkFullDiskAccess()
        if (!fullDiskAccess) {
          targetBlockers.push({
            code: "permission-denied",
            targetId,
            location: target.path,
            message: `Full Disk Access is required for ${targetId}.`,
          })
        }
      }

      if (targetEnabled && (yield* Permissions.checkBrowserRunning(Targets.processNameOf(target.browser)))) {
        targetBlockers.push({
          code: "browser-running",
          targetId,
          message: `${Targets.processNameOf(target.browser)} is currently running.`,
        })
      }

      blockers.push(...targetBlockers)
      targets.push({
        targetId,
        browser: target.browser,
        profile: target.profile,
        path: target.path,
        enabled: targetEnabled,
        writeMode: "rewrite",
        status: !targetEnabled
          ? "disabled"
          : targetBlockers.length > 0 || blockers.some((blocker) => !blocker.targetId)
            ? "blocked"
            : "ready",
        blockers: targetBlockers,
      })
    }

    const plan: WorkspacePlan = {
      version: 1,
      generatedAt: DateTime.formatIso(DateTime.unsafeNow()),
      publishedAt: null,
      workspaceHash: workspaceHashValue,
      workspacePath,
      snapshotId: workspace.snapshotId,
      summary: planSummary(workspace, blockers, targets),
      blockers,
      targets,
    }

    return { plan, publishTrees }
  })

export const plan = (): Effect.Effect<WorkspacePlan, Error> =>
  planFor([])

export const planFor = (requestedTargetIds: readonly string[]): Effect.Effect<WorkspacePlan, Error> =>
  Effect.gen(function* () {
    const { workspacePath, importLockPath, planPath } = workspaceFiles()
    const rawWorkspace = yield* Effect.tryPromise({
      try: () => Fs.readFile(workspacePath, "utf-8"),
      catch: (e) => new Error(`Failed to read ${workspacePath}: ${e}`),
    })
    const workspace = yield* load(workspacePath)
    yield* loadImportLock(importLockPath)
    const { valid, errors } = yield* validate()
    if (!valid) {
      return yield* Effect.fail(new Error(errors.join("\n")))
    }
    const built = yield* buildPlan(workspace, workspacePath, workspaceHash(rawWorkspace), requestedTargetIds)
    yield* savePlan(planPath, built.plan)
    return built.plan
  })

const plansEqual = (
  left: BookmarkTree,
  right: BookmarkTree,
): Effect.Effect<boolean, Error> =>
  Effect.gen(function* () {
    const forward = yield* Patch.generatePatches(left, right, "right", undefined, "left")
    if (forward.length > 0) return false
    const reverse = yield* Patch.generatePatches(right, left, "left", undefined, "right")
    return reverse.length === 0
  })

export const publish = (): Effect.Effect<WorkspacePublishResult, Error> =>
  publishTo([])

export const publishTo = (requestedTargetIds: readonly string[]): Effect.Effect<WorkspacePublishResult, Error> =>
  Effect.gen(function* () {
    const { workspacePath, importLockPath, planPath } = workspaceFiles()
    const rawWorkspace = yield* Effect.tryPromise({
      try: () => Fs.readFile(workspacePath, "utf-8"),
      catch: (e) => new Error(`Failed to read ${workspacePath}: ${e}`),
    })
    const workspace = yield* load(workspacePath)
    yield* loadImportLock(importLockPath)
    const validation = yield* validate()
    if (!validation.valid) {
      return yield* Effect.fail(new Error(validation.errors.join("\n")))
    }

    const built = yield* buildPlan(workspace, workspacePath, workspaceHash(rawWorkspace), requestedTargetIds)
    if (built.plan.blockers.length > 0) {
      return yield* Effect.fail(new Error(built.plan.blockers.map((blocker) => blocker.message).join("\n")))
    }

    yield* savePlan(planPath, built.plan)

    const backup = yield* backupArtifacts("workspace-publish", [
      { label: "workspace", path: workspacePath },
      { label: "import-lock", path: importLockPath },
      { label: "publish-plan", path: planPath },
      ...built.plan.targets
        .filter((target) => target.status === "ready")
        .map((target) => ({ label: target.targetId, path: target.path })),
    ])

    const publishedTargets: string[] = []
    for (const target of built.plan.targets.filter((target) => target.status === "ready")) {
      const publishTree = built.publishTrees[target.targetId]!
      const descriptor = targetToDescriptor(workspace.targets[target.targetId]!)
      yield* Targets.writeTree(descriptor, publishTree)
      const readBack = yield* Targets.readTree(descriptor)
      const verified = yield* plansEqual(readBack, publishTree)
      if (!verified) {
        return yield* Effect.fail(new Error(`Post-publish verification failed for ${target.targetId}`))
      }
      publishedTargets.push(target.targetId)
    }

    const publishedPlan: WorkspacePlan = {
      ...built.plan,
      publishedAt: DateTime.formatIso(DateTime.unsafeNow()),
    }
    yield* savePlan(planPath, publishedPlan)

    return {
      plan: publishedPlan,
      backup,
      publishedTargets,
    }
  })

export const importState = (
  requestedTargetIds: readonly string[],
): Effect.Effect<WorkspaceImportResult, Error> =>
  Effect.gen(function* () {
    const { workspacePath, importLockPath, planPath } = workspaceFiles()
    const targets = yield* resolveTargets(requestedTargetIds)
    const existingArtifacts = [
      { label: "workspace", path: workspacePath },
      { label: "import-lock", path: importLockPath },
      { label: "publish-plan", path: planPath },
    ]
    const backup = yield* backupArtifacts("workspace-import", existingArtifacts)
    const snapshotId = makeSnapshotId()
    const importedAt = DateTime.formatIso(DateTime.unsafeNow())
    const inbox: Record<string, WorkspaceTree> = {}
    const lockTargets: Record<string, ImportLock["targets"][string]> = {}

    for (const [targetId, target] of Object.entries(targets)) {
      const snapshot = yield* importTarget(targetId, target)
      inbox[targetId] = sanitizeTree(snapshot.tree)
      lockTargets[targetId] = {
        browser: target.browser,
        profile: target.profile,
        path: target.path,
        importedAt,
        occurrences: snapshot.occurrences,
      }
    }

    const workspace: WorkspaceFile = {
      version: 1,
      snapshotId,
      importedAt,
      targets,
      inbox,
      publish: emptyScopedTrees(),
      archive: emptyScopedTrees(),
      quarantine: emptyScopedTrees(),
    }

    const importLock: ImportLock = {
      version: 1,
      snapshotId,
      importedAt,
      targets: lockTargets,
    }

    yield* save(workspacePath, workspace)
    yield* saveImportLock(importLockPath, importLock)
    yield* Effect.tryPromise({
      try: () => Fs.rm(planPath, { force: true }),
      catch: (e) => new Error(`Failed to remove ${planPath}: ${e}`),
    })

    return {
      workspacePath,
      importLockPath,
      snapshotId,
      targets: Object.keys(targets),
      backup: backup.files.length > 0 ? backup : null,
    }
  })

export const next = (): Effect.Effect<WorkspaceNextResult, Error> =>
  Effect.gen(function* () {
    const { workspacePath, planPath } = workspaceFiles()
    if (!(yield* exists(workspacePath))) {
      return {
        state: "needs_import",
        summary: {
          inboxItems: 0,
          canonicalItems: 0,
          archiveItems: 0,
          quarantineItems: 0,
          targetCount: 0,
          readyTargetCount: 0,
          blockerCount: 0,
        },
        blockers: [],
        nextAction: runCommandAction("bookmarks import", "Import current browser state into a workspace."),
      }
    }

    const rawWorkspace = yield* Effect.tryPromise({
      try: () => Fs.readFile(workspacePath, "utf-8"),
      catch: (e) => new Error(`Failed to read ${workspacePath}: ${e}`),
    })
    const workspace = yield* load(workspacePath)
    const validation = yield* validate()
    const summaryBase = {
      inboxItems: countInboxNodes(workspace.inbox),
      canonicalItems: countScopedNodes(workspace.publish),
      archiveItems: countScopedNodes(workspace.archive),
      quarantineItems: countScopedNodes(workspace.quarantine),
      targetCount: Object.keys(workspace.targets).length,
      readyTargetCount: 0,
      blockerCount: validation.errors.length,
    }

    if (!validation.valid) {
      return {
        state: "has_blockers",
        summary: summaryBase,
        blockers: validation.errors.map((message) => ({ code: "unsupported-node", message })),
        nextAction: editFileAction(workspacePath, "Fix invalid workspace references before planning a publish."),
      }
    }

    if (summaryBase.inboxItems > 0 || summaryBase.quarantineItems > 0) {
      return {
        state: "needs_review",
        summary: summaryBase,
        blockers: [],
        nextAction: editFileAction(workspacePath, "Review inbox and quarantine items in workspace.yaml."),
      }
    }

    const built = yield* buildPlan(workspace, workspacePath, workspaceHash(rawWorkspace), [])
    const planExists = yield* exists(planPath)
    const savedPlan = planExists
      ? yield* loadPlan(planPath).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      : undefined

    if (built.plan.blockers.length > 0) {
      const requiresWorkspaceEdit = built.plan.blockers.some((blocker) =>
        blocker.code === "duplicate-url" || blocker.code === "unsupported-node" || blocker.code === "review-inbox"
        || blocker.code === "review-quarantine"
      )

      return {
        state: "has_blockers",
        summary: built.plan.summary,
        blockers: built.plan.blockers,
        nextAction: requiresWorkspaceEdit
          ? editFileAction(workspacePath, "Resolve publish blockers before publishing.")
          : runCommandAction("bookmarks plan --json", "Resolve environment blockers before publishing."),
      }
    }

    if (!savedPlan || savedPlan.workspaceHash !== built.plan.workspaceHash) {
      return {
        state: "needs_plan",
        summary: built.plan.summary,
        blockers: [],
        nextAction: runCommandAction("bookmarks plan", "Generate a fresh publish plan for the current workspace."),
      }
    }

    if (savedPlan.publishedAt) {
      return {
        state: "done",
        summary: built.plan.summary,
        blockers: [],
        nextAction: doneAction("Workspace has been published. Re-import when you want to refresh from browsers."),
      }
    }

    return {
      state: "ready_to_publish",
      summary: built.plan.summary,
      blockers: [],
      nextAction: runCommandAction("bookmarks publish", "Publish the curated workspace back to configured targets."),
    }
  })
