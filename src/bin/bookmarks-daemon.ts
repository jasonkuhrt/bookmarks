#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { watch } from "node:fs";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import {
  DEFAULT_DAEMON_HEADER_STATE,
  type DaemonPhase,
  stripManagedConfigHeader,
  writeManagedConfigHeader,
} from "../lib/managed-config-header.ts";
import { Effect } from "effect";
import * as Paths from "../lib/paths.ts";
import * as Permissions from "../lib/permissions.ts";
import * as Targets from "../lib/targets.ts";

const DEFAULT_SYNC_DELAY_MS = 60_000;
const BUSY_RETRY_DELAY_MS = 5_000;
const BROWSER_EXIT_POLL_MS = 5_000;
const ERROR_RETRY_INITIAL_DELAY_MS = 5_000;
const ERROR_RETRY_MAX_DELAY_MS = 5 * 60_000;

type DaemonOutcome = "deferred" | "failed" | "noop" | "success";

interface DaemonRuntimeState {
  readonly lastError?: string;
  readonly lastEventAt?: string;
  readonly lastOutcome?: DaemonOutcome;
  readonly lastSyncAt?: string;
  readonly nextSyncAt?: string;
  readonly phase: DaemonPhase;
  readonly pid: number;
  readonly startedAt: string;
  readonly yamlPath: string;
}

type DaemonRuntimePatch = {
  readonly [K in keyof DaemonRuntimeState]?: DaemonRuntimeState[K] | undefined;
};

const defaultCliPath = (): string =>
  process.env["BOOKMARKS_DAEMON_CLI_PATH"] ?? Path.resolve(import.meta.dirname, "./bookmarks.ts");

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const pruneUndefined = <T extends object>(value: T): T =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Undefined values are removed while preserving the original key/value types.
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

const statePath = (): string => Paths.defaultDaemonStatePath();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Browsers whose open window kept a sync from writing their bookmarks. */
const waitingBrowsers = (syncResult: Record<string, unknown>): ReadonlySet<string> => {
  const waiting = syncResult["waiting"];
  if (!Array.isArray(waiting)) return new Set();
  return new Set(
    waiting.flatMap((entry) =>
      isRecord(entry) && typeof entry["browser"] === "string" ? [entry["browser"]] : [],
    ),
  );
};

const changedAnything = (syncResult: Record<string, unknown>): boolean => {
  const applied = syncResult["applied"];
  return syncResult["yamlChanged"] === true || (Array.isArray(applied) && applied.length > 0);
};

const isDeferredSync = (syncResult: Record<string, unknown>): boolean => {
  const orchestration = syncResult["orchestration"];
  return (
    isRecord(orchestration) &&
    orchestration["state"] === "busy" &&
    typeof orchestration["message"] === "string"
  );
};

const readComparableConfigText = async (yamlPath: string): Promise<string | undefined> => {
  try {
    return stripManagedConfigHeader(await Fs.readFile(yamlPath, "utf-8"));
  } catch {
    return undefined;
  }
};

const daemonSyncDelayMs = (): number => {
  const raw = process.env["BOOKMARKS_DAEMON_SYNC_DELAY_MS"];
  if (!raw) return DEFAULT_SYNC_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SYNC_DELAY_MS;
};

const daemonBusyRetryDelayMs = (): number => {
  const raw = process.env["BOOKMARKS_DAEMON_BUSY_RETRY_DELAY_MS"];
  if (!raw) return BUSY_RETRY_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : BUSY_RETRY_DELAY_MS;
};

const daemonErrorRetryInitialDelayMs = (): number => {
  const raw = process.env["BOOKMARKS_DAEMON_ERROR_RETRY_DELAY_MS"];
  if (!raw) return ERROR_RETRY_INITIAL_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ERROR_RETRY_INITIAL_DELAY_MS;
};

const daemonBrowserExitPollMs = (): number => {
  const raw = process.env["BOOKMARKS_DAEMON_BROWSER_EXIT_POLL_MS"];
  if (!raw) return BROWSER_EXIT_POLL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : BROWSER_EXIT_POLL_MS;
};

/** The bookmark files of every discovered browser target, which a browser edit rewrites. */
const browserBookmarkFiles = async (): Promise<readonly string[]> => {
  try {
    const targets = await Effect.runPromise(Targets.discoverTargets());
    return targets.map((target) => target.path);
  } catch (error) {
    console.error(`Failed to discover browser bookmark files: ${messageFromUnknown(error)}`);
    return [];
  }
};

const isBrowserRunning = (browser: string): Promise<boolean> =>
  Effect.runPromise(Permissions.checkBrowserRunning(browser));

const execFileResult = async (
  cmd: string,
  args: readonly string[],
  options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}> =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      {
        cwd: options?.cwd,
        encoding: "utf-8",
        env: options?.env,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stderr, stdout });
          return;
        }
        if (typeof error === "object" && "code" in error) {
          resolve({
            exitCode: typeof error.code === "number" ? error.code : 1,
            stderr,
            stdout,
          });
          return;
        }
        reject(error);
      },
    );
  });

const runCliJson = async (args: readonly string[]): Promise<Record<string, unknown>> => {
  const cliPath = defaultCliPath();
  const result = await execFileResult(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
  });
  const text =
    result.exitCode === 0 ? result.stdout.trim() : result.stderr.trim() || result.stdout.trim();

  if (result.exitCode !== 0) {
    throw new Error(text || `${Path.basename(cliPath)} ${args.join(" ")} failed`);
  }
  if (!text) {
    throw new Error(`${Path.basename(cliPath)} ${args.join(" ")} returned no JSON output`);
  }

  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${Path.basename(cliPath)} ${args.join(" ")} returned non-object JSON`);
  }
  return parsed;
};

const writeRuntimeState = async (state: DaemonRuntimeState): Promise<void> => {
  await Fs.mkdir(Paths.defaultRuntimeDir(), { recursive: true });
  await Fs.writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
};

const daemonHeaderStateFromRuntime = (state: DaemonRuntimeState) => ({
  status: "running" as const,
  phase: state.phase,
  ...(state.nextSyncAt ? { nextSyncAt: state.nextSyncAt } : {}),
});

const forever = (): Promise<never> => new Promise(() => undefined);

const runWatcherProcess = async (): Promise<never> => {
  const yamlPath = Paths.defaultYamlPath();
  const delayMs = daemonSyncDelayMs();
  const busyRetryDelayMs = daemonBusyRetryDelayMs();
  const errorRetryInitialDelayMs = daemonErrorRetryInitialDelayMs();
  const browserExitPollMs = daemonBrowserExitPollMs();
  let state: DaemonRuntimeState = {
    phase: "starting",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    yamlPath,
  };
  let lastComparableText = (await readComparableConfigText(yamlPath)) ?? "";
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  let browserExitTimer: ReturnType<typeof setInterval> | undefined;
  let flushInProgress = false;
  let errorRetryCount = 0;
  let stateWriteQueue: Promise<unknown> | undefined;

  interface ScheduleRequest {
    readonly delayMs: number;
    readonly eventAt: string;
    readonly preserveError: boolean;
    readonly supersedesPending: boolean;
  }

  let pendingSchedule: ScheduleRequest | undefined;

  const persistState = async (nextState: DaemonRuntimeState): Promise<void> => {
    state = pruneUndefined(nextState);
    await writeRuntimeState(state);
    try {
      await writeManagedConfigHeader(yamlPath, daemonHeaderStateFromRuntime(state));
    } catch (error) {
      console.error(`Failed to update bookmarks.yaml header: ${messageFromUnknown(error)}`);
    }
  };

  const updateState = (patch: DaemonRuntimePatch): Promise<DaemonRuntimeState> => {
    const previousWrite = stateWriteQueue;
    const write = (async () => {
      try {
        await previousWrite;
      } catch {
        // The earlier writer already surfaced its own failure.
      }
      const nextState =
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Runtime patches are merged onto a fully-populated state object before undefined fields are pruned.
        pruneUndefined({
          ...state,
          ...patch,
        }) as DaemonRuntimeState;
      await persistState(nextState);
      return nextState;
    })();
    stateWriteQueue = write;
    return write;
  };

  const deferSchedule = (request: ScheduleRequest): void => {
    if (request.supersedesPending || pendingSchedule === undefined) {
      pendingSchedule = request;
    }
  };

  const stopWaitingForBrowsers = (): void => {
    if (browserExitTimer) clearInterval(browserExitTimer);
    browserExitTimer = undefined;
  };

  const armSchedule = async (request: ScheduleRequest): Promise<void> => {
    if (queueTimer) clearTimeout(queueTimer);
    stopWaitingForBrowsers();
    const nextSyncAt = new Date(Date.now() + request.delayMs).toISOString();
    await updateState({
      lastError: request.preserveError ? state.lastError : undefined,
      lastEventAt: request.eventAt,
      nextSyncAt,
      phase: "queued",
    });
    queueTimer = setTimeout(() => {
      queueTimer = undefined;
      void flushQueue();
    }, request.delayMs);
  };

  const scheduleSync = async (
    requestedDelayMs: number,
    eventAt = state.lastEventAt ?? new Date().toISOString(),
    preserveError = false,
    supersedesPending = true,
  ) => {
    const request: ScheduleRequest = {
      delayMs: requestedDelayMs,
      eventAt,
      preserveError,
      supersedesPending,
    };
    if (flushInProgress) {
      deferSchedule(request);
      return;
    }
    await armSchedule(request);
  };

  /** Sync again once every browser that kept the last sync from writing has quit. */
  const waitForBrowsersToQuit = async (browsers: ReadonlySet<string>): Promise<void> => {
    await updateState({ phase: "waiting" });
    browserExitTimer = setInterval(() => {
      void (async () => {
        const stillRunning = await Promise.all([...browsers].map(isBrowserRunning));
        if (stillRunning.some(Boolean) || browserExitTimer === undefined) return;
        stopWaitingForBrowsers();
        await scheduleSync(0, new Date().toISOString(), false, false);
      })();
    }, browserExitPollMs);
  };

  const flushQueue = async (): Promise<void> => {
    if (flushInProgress) {
      deferSchedule({
        delayMs: 0,
        eventAt: state.lastEventAt ?? new Date().toISOString(),
        preserveError: state.lastOutcome === "failed",
        supersedesPending: false,
      });
      return;
    }
    flushInProgress = true;

    try {
      await updateState({
        nextSyncAt: undefined,
        phase: "syncing",
      });

      const syncResult = await runCliJson(["sync", "--json"]);
      // The sync's own YAML write is not an edit to sync again.
      lastComparableText = (await readComparableConfigText(yamlPath)) ?? lastComparableText;
      if (isDeferredSync(syncResult)) {
        errorRetryCount = 0;
        await updateState({ lastOutcome: "deferred" });
        await scheduleSync(busyRetryDelayMs, undefined, false, false);
        return;
      }

      errorRetryCount = 0;
      await watchBrowserFiles();
      await updateState({
        lastError: undefined,
        lastOutcome: changedAnything(syncResult) ? "success" : "noop",
        lastSyncAt: new Date().toISOString(),
        phase: "idle",
      });
      const waiting = waitingBrowsers(syncResult);
      if (waiting.size > 0 && pendingSchedule === undefined) await waitForBrowsersToQuit(waiting);
    } catch (error) {
      const message = messageFromUnknown(error);
      await updateState({
        lastError: message,
        lastOutcome: "failed",
        phase: "error",
      });
      const retryDelayMs = Math.min(
        errorRetryInitialDelayMs * 2 ** Math.min(errorRetryCount, 16),
        ERROR_RETRY_MAX_DELAY_MS,
      );
      errorRetryCount += 1;
      await scheduleSync(retryDelayMs, undefined, true, false);
    } finally {
      flushInProgress = false;
      const schedule = pendingSchedule;
      pendingSchedule = undefined;
      if (schedule !== undefined) await armSchedule(schedule);
    }
  };

  const onYamlChange = async () => {
    const comparableText = await readComparableConfigText(yamlPath);
    // The daemon's own header updates leave the bookmarks unchanged.
    if (comparableText !== undefined && comparableText === lastComparableText) return;
    if (comparableText !== undefined) lastComparableText = comparableText;
    errorRetryCount = 0;
    await scheduleSync(delayMs);
  };

  const onBrowserChange = async () => {
    errorRetryCount = 0;
    await scheduleSync(delayMs, new Date().toISOString());
  };

  const recordWatcherError = async (error: unknown) => {
    const message = messageFromUnknown(error);
    console.error(`Daemon watcher error: ${message}`);
    try {
      await updateState({
        lastError: message,
        lastOutcome: "failed",
        phase: "error",
      });
    } catch {
      // Best effort: an I/O failure here is already being surfaced to stderr.
    }
  };

  /** Watch a file through its folder, so the watch survives the file being replaced by a rename. */
  const watchFile = (filePath: string, onChange: () => Promise<void>) =>
    watch(Path.dirname(filePath), { persistent: true }, (_, fileName) => {
      const name =
        fileName === null ? null : typeof fileName === "string" ? fileName : String(fileName);
      if (name !== null && name !== Path.basename(filePath)) return;
      void (async () => {
        try {
          await onChange();
        } catch (error) {
          await recordWatcherError(error);
        }
      })();
    });

  const watchers = [watchFile(yamlPath, onYamlChange)];
  const watchedBrowserFiles = new Set<string>();
  /**
   * Watch every browser bookmark file not watched yet. Runs at start and after each sync, so a
   * new Chrome profile, or a file macOS only lets the daemon see once it has Full Disk Access,
   * is picked up without a restart.
   */
  const watchBrowserFiles = async () => {
    for (const filePath of await browserBookmarkFiles()) {
      if (watchedBrowserFiles.has(filePath)) continue;
      try {
        watchers.push(watchFile(filePath, onBrowserChange));
        watchedBrowserFiles.add(filePath);
      } catch (error) {
        console.error(`Failed to watch ${filePath}: ${messageFromUnknown(error)}`);
      }
    }
  };
  await watchBrowserFiles();

  const cleanup = async (exitCode: number) => {
    for (const watcher of watchers) watcher.close();
    if (queueTimer) clearTimeout(queueTimer);
    stopWaitingForBrowsers();
    try {
      await writeManagedConfigHeader(yamlPath, DEFAULT_DAEMON_HEADER_STATE);
    } catch {
      // Best effort cleanup on exit.
    }
    try {
      await Fs.rm(statePath(), { force: true });
    } catch {
      // Best effort cleanup on exit.
    }
    process.exit(exitCode);
  };

  process.once("SIGINT", () => {
    void cleanup(0);
  });
  process.once("SIGTERM", () => {
    void cleanup(0);
  });

  await persistState({
    ...state,
    phase: "idle",
  });
  // Changes made while the daemon was down have no event left to wait for.
  await scheduleSync(0, new Date().toISOString());

  return forever();
};

try {
  await runWatcherProcess();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
