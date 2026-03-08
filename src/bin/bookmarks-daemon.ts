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
import * as Paths from "../lib/paths.ts";

const DEFAULT_SYNC_DELAY_MS = 60_000;
const BUSY_RETRY_DELAY_MS = 5_000;

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

const hasPendingChanges = (statusResult: Record<string, unknown>): boolean => {
  const targets = statusResult["targets"];
  if (!Array.isArray(targets)) return false;

  return targets.some((target) => {
    if (!isRecord(target)) return false;
    const pendingToBrowser = target["pendingToBrowser"];
    const pendingToYaml = target["pendingToYaml"];
    return (
      (Array.isArray(pendingToBrowser) && pendingToBrowser.length > 0) ||
      (Array.isArray(pendingToYaml) && pendingToYaml.length > 0)
    );
  });
};

const isDeferredSync = (syncResult: Record<string, unknown>): boolean => {
  const orchestration = syncResult["orchestration"];
  return (
    isRecord(orchestration) &&
    orchestration["state"] === "busy" &&
    typeof orchestration["message"] === "string"
  );
};

const readComparableConfigText = async (yamlPath: string): Promise<string> => {
  const raw = await Fs.readFile(yamlPath, "utf-8");
  return stripManagedConfigHeader(raw);
};

const daemonSyncDelayMs = (): number => {
  const raw = process.env["BOOKMARKS_DAEMON_SYNC_DELAY_MS"];
  if (!raw) return DEFAULT_SYNC_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SYNC_DELAY_MS;
};

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
  let state: DaemonRuntimeState = {
    phase: "starting",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    yamlPath,
  };
  let lastComparableText = await readComparableConfigText(yamlPath).catch(() => "");
  let lastSettledComparableText = lastComparableText;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;

  const persistState = async (nextState: DaemonRuntimeState): Promise<void> => {
    state = pruneUndefined(nextState);
    await writeRuntimeState(state);
    try {
      await writeManagedConfigHeader(yamlPath, daemonHeaderStateFromRuntime(state));
    } catch (error) {
      console.error(`Failed to update bookmarks.yaml header: ${messageFromUnknown(error)}`);
    }
  };

  const updateState = async (patch: DaemonRuntimePatch): Promise<DaemonRuntimeState> => {
    const nextState =
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Runtime patches are merged onto a fully-populated state object before undefined fields are pruned.
      pruneUndefined({
        ...state,
        ...patch,
      }) as DaemonRuntimeState;
    await persistState(nextState);
    return nextState;
  };

  const scheduleSync = async (
    requestedDelayMs: number,
    eventAt = state.lastEventAt ?? new Date().toISOString(),
  ) => {
    if (queueTimer) clearTimeout(queueTimer);
    const nextSyncAt = new Date(Date.now() + requestedDelayMs).toISOString();
    await updateState({
      lastError: undefined,
      lastEventAt: eventAt,
      nextSyncAt,
      phase: "queued",
    });
    queueTimer = setTimeout(() => {
      queueTimer = undefined;
      void flushQueue();
    }, requestedDelayMs);
  };

  const flushQueue = async (): Promise<void> => {
    await updateState({
      lastError: undefined,
      nextSyncAt: undefined,
      phase: "syncing",
    });

    try {
      const currentComparableText = await readComparableConfigText(yamlPath);
      lastComparableText = currentComparableText;

      if (currentComparableText === lastSettledComparableText) {
        await updateState({
          lastOutcome: "noop",
          phase: "idle",
        });
        return;
      }

      const statusResult = await runCliJson(["status", "--json"]);
      if (!hasPendingChanges(statusResult)) {
        lastSettledComparableText = currentComparableText;
        await updateState({
          lastOutcome: "noop",
          phase: "idle",
        });
        return;
      }

      const syncResult = await runCliJson(["sync", "--json"]);
      if (isDeferredSync(syncResult)) {
        await scheduleSync(BUSY_RETRY_DELAY_MS);
        await updateState({ lastOutcome: "deferred" });
        return;
      }

      const syncedComparableText = await readComparableConfigText(yamlPath);
      lastComparableText = syncedComparableText;
      lastSettledComparableText = syncedComparableText;
      await updateState({
        lastError: undefined,
        lastOutcome: "success",
        lastSyncAt: new Date().toISOString(),
        phase: "idle",
      });
    } catch (error) {
      await updateState({
        lastError: messageFromUnknown(error),
        lastOutcome: "failed",
        phase: "error",
      });
    }
  };

  const onWatchedChange = async (fileName: string | null) => {
    if (fileName !== null && fileName !== Path.basename(yamlPath)) return;

    const comparableText = await readComparableConfigText(yamlPath).catch(() => undefined);
    if (comparableText !== undefined && comparableText === lastComparableText) return;
    if (comparableText !== undefined) lastComparableText = comparableText;
    await scheduleSync(delayMs);
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

  const watcher = watch(Path.dirname(yamlPath), { persistent: true }, (_, fileName) => {
    const normalizedFileName =
      fileName === null ? null : typeof fileName === "string" ? fileName : String(fileName);
    void (async () => {
      try {
        await onWatchedChange(normalizedFileName);
      } catch (error) {
        await recordWatcherError(error);
      }
    })();
  });

  const cleanup = async (exitCode: number) => {
    watcher.close();
    if (queueTimer) clearTimeout(queueTimer);
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

  return forever();
};

try {
  await runWatcherProcess();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
