/* oxlint-disable no-unsafe-type-assertion, no-unnecessary-condition, restrict-template-expressions */
import { Data, DateTime, Effect } from "effect";
import * as Fs from "node:fs/promises";
import * as ManagedPaths from "./managed-paths.ts";
import * as Paths from "./paths.ts";

export type SyncOperation = "gc" | "pull" | "push" | "sync";
export type WorkspaceOperation = "publish";
type OrchestratedOperation = SyncOperation | WorkspaceOperation;

interface LockState {
  readonly pid: number;
  readonly operation: OrchestratedOperation;
  readonly resourcePath: string;
  readonly acquiredAt: string;
}

interface SyncQueueState {
  readonly operation: SyncOperation;
  readonly yamlPath: string;
  readonly blockers: readonly string[];
  readonly queuedAt: string;
}

interface WorkspaceQueueState {
  readonly operation: WorkspaceOperation;
  readonly workspacePath: string;
  readonly requestedTargetIds: readonly string[];
  readonly blockers: readonly string[];
  readonly queuedAt: string;
}

interface Notice<O extends OrchestratedOperation> {
  readonly state: "busy" | "queued";
  readonly operation: O;
  readonly message: string;
  readonly blockers?: readonly string[];
}

export interface SyncNotice extends Notice<SyncOperation> {}

export interface WorkspacePublishNotice extends Notice<WorkspaceOperation> {}

export type OrchestratedSyncResult<A> =
  | { readonly _tag: "completed"; readonly value: A }
  | { readonly _tag: "deferred"; readonly notice: SyncNotice };

export type OrchestratedWorkspacePublishResult<A> =
  | { readonly _tag: "completed"; readonly value: A }
  | { readonly _tag: "deferred"; readonly notice: WorkspacePublishNotice };

export class TemporarySyncBlocker extends Data.TaggedError("TemporarySyncBlocker")<{
  readonly blockers: readonly string[];
}> {
  static is = (u: unknown): u is TemporarySyncBlocker =>
    u !== null && typeof u === "object" && "_tag" in u && u._tag === "TemporarySyncBlocker";
}

const combineOperations = (left: SyncOperation, right: SyncOperation): SyncOperation =>
  left === right ? left : "sync";

const formatBlockers = (blockers: readonly string[]): string =>
  blockers.length <= 1
    ? (blockers[0] ?? "the configured browser")
    : `${blockers.slice(0, -1).join(", ")} and ${blockers.at(-1)}`;

const isLivePid = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const ensureRuntimeDir = (): Effect.Effect<void, Error> =>
  ManagedPaths.ensureDir(Paths.defaultRuntimeDir());

const clearFile = (path: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => Fs.rm(path, { force: true }),
    catch: (e) => new Error(`Failed to remove ${path}: ${e}`),
  }).pipe(
    Effect.catchAll(() => Effect.void),
    Effect.asVoid,
  );

const readJsonFile = <A>(path: string): Effect.Effect<A | undefined, Error> =>
  Effect.tryPromise({
    try: async () => JSON.parse(await Fs.readFile(path, "utf-8")) as A,
    catch: (e) => {
      if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT")
        return undefined;
      throw e;
    },
  }).pipe(
    Effect.catchAll((e) => {
      if (e === undefined) return Effect.succeed(undefined);
      return clearFile(path).pipe(Effect.flatMap(() => Effect.succeed(undefined)));
    }),
  );

const writeJsonFile = (path: string, value: unknown, flag?: "wx"): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () => Fs.writeFile(path, JSON.stringify(value, null, 2), flag ? { flag } : undefined),
    catch: (e) => new Error(`Failed to write ${path}: ${e}`, { cause: e }),
  });

const acquireLock = <O extends OrchestratedOperation>(
  requestedOperation: O,
  resourcePath: string,
  busyMessage: string,
): Effect.Effect<
  { readonly acquired: true } | { readonly acquired: false; readonly notice: Notice<O> },
  Error
> =>
  Effect.gen(function* () {
    yield* ensureRuntimeDir();

    const lockPath = Paths.defaultSyncLockPath();
    const nextLock: LockState = {
      pid: process.pid,
      operation: requestedOperation,
      resourcePath,
      acquiredAt: DateTime.formatIso(DateTime.unsafeNow()),
    };

    const attemptCreate = () =>
      writeJsonFile(lockPath, nextLock, "wx").pipe(
        Effect.map(() => ({ _tag: "created" }) as const),
        Effect.catchAll((error) => {
          if (hasCode(error.cause, "EEXIST") || error.message.includes("EEXIST")) {
            return Effect.succeed({ _tag: "exists" } as const);
          }
          return Effect.fail(error);
        }),
      );

    const firstAttempt = yield* attemptCreate();
    if (firstAttempt._tag === "created") {
      return { acquired: true };
    }

    const existingLock = yield* readJsonFile<LockState>(lockPath);
    if (existingLock && isLivePid(existingLock.pid)) {
      return {
        acquired: false,
        notice: {
          state: "busy",
          operation: requestedOperation,
          message: `${busyMessage} (pid ${existingLock.pid}).`,
        },
      };
    }

    yield* clearFile(lockPath);

    const secondAttempt = yield* attemptCreate();
    if (secondAttempt._tag === "created") {
      return { acquired: true };
    }

    return {
      acquired: false,
      notice: {
        state: "busy",
        operation: requestedOperation,
        message: busyMessage,
      },
    };
  });

const readPendingQueue = (): Effect.Effect<SyncQueueState | undefined, Error> =>
  readJsonFile<SyncQueueState>(Paths.defaultSyncQueuePath());

const clearPendingQueue = (): Effect.Effect<void> => clearFile(Paths.defaultSyncQueuePath());

const writePendingQueue = (
  operation: SyncOperation,
  yamlPath: string,
  blockers: readonly string[],
): Effect.Effect<SyncNotice, Error> =>
  Effect.gen(function* () {
    const queue: SyncQueueState = {
      operation,
      yamlPath,
      blockers,
      queuedAt: DateTime.formatIso(DateTime.unsafeNow()),
    };

    yield* ensureRuntimeDir();
    yield* writeJsonFile(Paths.defaultSyncQueuePath(), queue);

    return {
      state: "queued",
      operation,
      blockers,
      message: `${operation} is queued until ${formatBlockers(blockers)} ${blockers.length === 1 ? "closes" : "close"}.`,
    };
  });

const readPendingWorkspacePublishQueue = (): Effect.Effect<
  WorkspaceQueueState | undefined,
  Error
> => readJsonFile<WorkspaceQueueState>(Paths.defaultWorkspacePublishQueuePath());

const clearPendingWorkspacePublishQueue = (): Effect.Effect<void> =>
  clearFile(Paths.defaultWorkspacePublishQueuePath());

const writePendingWorkspacePublishQueue = (
  workspacePath: string,
  requestedTargetIds: readonly string[],
  blockers: readonly string[],
): Effect.Effect<WorkspacePublishNotice, Error> =>
  Effect.gen(function* () {
    const queue: WorkspaceQueueState = {
      operation: "publish",
      workspacePath,
      requestedTargetIds: [...new Set(requestedTargetIds)],
      blockers,
      queuedAt: DateTime.formatIso(DateTime.unsafeNow()),
    };

    yield* ensureRuntimeDir();
    yield* writeJsonFile(Paths.defaultWorkspacePublishQueuePath(), queue);

    return {
      state: "queued",
      operation: "publish",
      blockers,
      message: `publish is queued until ${formatBlockers(blockers)} ${blockers.length === 1 ? "closes" : "close"}.`,
    };
  });

export const withOrchestratedSync = <A>(
  yamlPath: string,
  requestedOperation: SyncOperation,
  run: (operation: SyncOperation) => Effect.Effect<A, Error | TemporarySyncBlocker>,
): Effect.Effect<OrchestratedSyncResult<A>, Error> =>
  Effect.gen(function* () {
    const lock = yield* acquireLock(
      requestedOperation,
      yamlPath,
      "Another bookmarks sync is already running",
    );
    if (!lock.acquired) {
      return { _tag: "deferred", notice: lock.notice } as const;
    }

    try {
      const pendingQueue = yield* readPendingQueue();
      const operation = pendingQueue
        ? combineOperations(pendingQueue.operation, requestedOperation)
        : requestedOperation;

      const outcome = yield* run(operation).pipe(
        Effect.map((value) => ({ _tag: "completed", value }) as const),
        Effect.catchAll((error) => {
          if (TemporarySyncBlocker.is(error)) {
            return writePendingQueue(operation, yamlPath, error.blockers).pipe(
              Effect.map((notice) => ({ _tag: "deferred", notice }) as const),
            );
          }

          return clearPendingQueue().pipe(Effect.flatMap(() => Effect.fail(error)));
        }),
      );

      if (outcome._tag === "completed") {
        yield* clearPendingQueue();
      }

      return outcome;
    } finally {
      yield* clearFile(Paths.defaultSyncLockPath());
    }
  });

export const withOrchestratedWorkspacePublish = <A>(
  workspacePath: string,
  requestedTargetIds: readonly string[],
  run: (requestedTargetIds: readonly string[]) => Effect.Effect<A, Error | TemporarySyncBlocker>,
): Effect.Effect<OrchestratedWorkspacePublishResult<A>, Error> =>
  Effect.gen(function* () {
    const lock = yield* acquireLock(
      "publish",
      workspacePath,
      "Another bookmarks publish is already running",
    );
    if (!lock.acquired) {
      return { _tag: "deferred", notice: lock.notice } as const;
    }

    try {
      const pendingQueue = yield* readPendingWorkspacePublishQueue();
      const targetIds = [
        ...new Set([...(pendingQueue?.requestedTargetIds ?? []), ...requestedTargetIds]),
      ];

      const outcome = yield* run(targetIds).pipe(
        Effect.map((value) => ({ _tag: "completed", value }) as const),
        Effect.catchAll((error) => {
          if (TemporarySyncBlocker.is(error)) {
            return writePendingWorkspacePublishQueue(workspacePath, targetIds, error.blockers).pipe(
              Effect.map((notice) => ({ _tag: "deferred", notice }) as const),
            );
          }

          return clearPendingWorkspacePublishQueue().pipe(Effect.flatMap(() => Effect.fail(error)));
        }),
      );

      if (outcome._tag === "completed") {
        yield* clearPendingWorkspacePublishQueue();
      }

      return outcome;
    } finally {
      yield* clearFile(Paths.defaultSyncLockPath());
    }
  });
