/* oxlint-disable no-unsafe-type-assertion, restrict-template-expressions */
import { DateTime, Effect } from "effect";
import * as Fs from "node:fs/promises";
import * as ManagedPaths from "./managed-paths.ts";
import * as Paths from "./paths.ts";

export type SyncOperation = "gc" | "pull" | "push" | "sync";
type OrchestratedOperation = SyncOperation;

interface LockState {
  readonly pid: number;
  readonly operation: OrchestratedOperation;
  readonly resourcePath: string;
  readonly acquiredAt: string;
}

interface Notice<O extends OrchestratedOperation> {
  readonly state: "busy";
  readonly operation: O;
  readonly message: string;
}

export interface SyncNotice extends Notice<SyncOperation> {}

export type OrchestratedSyncResult<A> =
  | { readonly _tag: "completed"; readonly value: A }
  | { readonly _tag: "deferred"; readonly notice: SyncNotice };

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
    try: async () => {
      const raw = await Fs.readFile(path, "utf-8");
      try {
        return JSON.parse(raw) as A;
      } catch (cause) {
        throw new Error(`Failed to parse ${path}: ${cause}`, { cause });
      }
    },
    catch: (e) =>
      hasCode(e, "ENOENT")
        ? undefined
        : e instanceof Error
          ? e
          : new Error(`Failed to read ${path}: ${e}`),
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

export const withOrchestratedSync = <A>(
  yamlPath: string,
  requestedOperation: SyncOperation,
  run: (operation: SyncOperation) => Effect.Effect<A, Error>,
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

    return yield* run(requestedOperation).pipe(
      Effect.map((value) => ({ _tag: "completed", value }) as const),
      Effect.ensuring(clearFile(Paths.defaultSyncLockPath())),
    );
  });
