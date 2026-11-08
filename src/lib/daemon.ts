/**
 * Launchd-managed watcher daemon lifecycle.
 *
 * The launch agent owns a long-lived watcher process. The watcher queues a
 * sync 60 seconds after the last semantic config-file edit and records runtime
 * state in the managed runtime directory for CLI status and config-file UX.
 */

import { DateTime, Effect, Option, pipe } from "effect";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import {
  type DaemonHeaderState,
  type DaemonPhase,
  isDaemonPhase,
} from "./managed-config-header.ts";
import * as Paths from "./paths.ts";

const LABEL = "com.jasonkuhrt.bookmarks-sync";
/** The launcher's code-signing identifier: Full Disk Access granted to it survives rebuilds. */
const LAUNCHER_IDENTIFIER = "com.jasonkuhrt.bookmarks-sync";
const PLIST_FILENAME = `${LABEL}.plist`;
const FORWARDED_ENVIRONMENT_KEYS = [
  "HOME",
  "PATH",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "BOOKMARKS_CONFIG_DIR",
  "BOOKMARKS_STATE_DIR",
  "BOOKMARKS_YAML_PATH",
  "BOOKMARKS_SCHEMA_PATH",
  "BOOKMARKS_SYNC_BASELINE_PATH",
  "BOOKMARKS_BACKUP_DIR",
  "BOOKMARKS_RUNTIME_DIR",
  "BOOKMARKS_SAFARI_PLIST_PATH",
  "BOOKMARKS_SAFARI_TABS_DB_PATH",
  "BOOKMARKS_CHROME_DATA_DIR",
  "BOOKMARKS_CHROME_BOOKMARKS_PATH",
  "BOOKMARKS_FORCE_BROWSER_RUNNING",
  "BOOKMARKS_DAEMON_BUSY_RETRY_DELAY_MS",
  "BOOKMARKS_DAEMON_SYNC_DELAY_MS",
] as const;

type DaemonOutcome = "deferred" | "failed" | "noop" | "success";

export interface DaemonConfig {
  readonly bunPath: string;
  /** The signed program launchd runs, which holds the Full Disk Access grant. */
  readonly launcherPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly logDir: string;
  readonly runnerPath: string;
  readonly workingDir: string;
}

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

export interface DaemonStatus {
  readonly lastError: string | undefined;
  readonly lastEventAt: Option.Option<DateTime.Utc>;
  readonly lastOutcome: DaemonOutcome | undefined;
  readonly lastSyncAt: Option.Option<DateTime.Utc>;
  readonly nextSyncAt: Option.Option<DateTime.Utc>;
  readonly phase: DaemonPhase;
  readonly pid: number | undefined;
  readonly launcherPath: string;
  readonly plistPath: string;
  readonly running: boolean;
  readonly startedAt: Option.Option<DateTime.Utc>;
  readonly statePath: string;
  readonly yamlPath: string;
}

const homeDir = (): string => process.env["HOME"] ?? "";
const plistDir = (): string => Path.join(homeDir(), "Library/LaunchAgents");
const plistPath = (): string => Path.join(plistDir(), PLIST_FILENAME);
const defaultLogDir = (): string => Path.join(homeDir(), "Library/Logs/bookmarks-sync");
const defaultRunnerPath = (): string =>
  process.env["BOOKMARKS_DAEMON_RUNNER_PATH"] ??
  Path.resolve(import.meta.dirname, "../bin/bookmarks-daemon.ts");
const launcherSourcePath = (): string =>
  Path.resolve(import.meta.dirname, "../launcher/bookmarks-sync.c");
export const defaultLauncherPath = (): string =>
  process.env["BOOKMARKS_DAEMON_LAUNCHER_PATH"] ??
  Path.join(Paths.defaultStateDir(), "bin", "bookmarks-sync");
const defaultCliPath = (): string =>
  process.env["BOOKMARKS_DAEMON_CLI_PATH"] ??
  Path.resolve(import.meta.dirname, "../bin/bookmarks.ts");

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const fileExists = (filePath: string): Effect.Effect<boolean, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await Fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    catch: (error) => new Error(`Failed to inspect ${filePath}: ${messageFromUnknown(error)}`),
  });

const mkdir = (dir: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () => Fs.mkdir(dir, { recursive: true }),
    catch: (error) => new Error(`Failed to create directory ${dir}: ${messageFromUnknown(error)}`),
  }).pipe(Effect.asVoid);

const writeFile = (filePath: string, content: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () => Fs.writeFile(filePath, content, "utf-8"),
    catch: (error) => new Error(`Failed to write ${filePath}: ${messageFromUnknown(error)}`),
  });

const removeFile = (filePath: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () => Fs.rm(filePath, { force: true }),
    catch: (error) => new Error(`Failed to remove ${filePath}: ${messageFromUnknown(error)}`),
  });

const execFileEffect = (cmd: string, args: readonly string[]): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        execFile(cmd, [...args], { encoding: "utf-8" }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      }),
    catch: (error) =>
      new Error(`${cmd} ${args.join(" ")} failed: ${messageFromUnknown(error)}`, {
        cause: error,
      }),
  });

const resolveBunPath = (): Effect.Effect<string, Error> =>
  pipe(
    execFileEffect("which", ["bun"]),
    Effect.map((stdout) => stdout.trim()),
    Effect.catchAll(() => Effect.succeed(process.execPath)),
  );

const forwardedEnvironment = (): Record<string, string> =>
  FORWARDED_ENVIRONMENT_KEYS.reduce<Record<string, string>>(
    (environment, key) => {
      const value = process.env[key];
      if (value) environment[key] = value;
      return environment;
    },
    {
      BOOKMARKS_DAEMON_CLI_PATH: defaultCliPath(),
    },
  );

const statePath = (): string => Paths.defaultDaemonStatePath();

const toUtcOption = (value: string | undefined): Option.Option<DateTime.Utc> =>
  value ? pipe(DateTime.make(value), Option.map(DateTime.toUtc)) : Option.none<DateTime.Utc>();

const readRuntimeState = (): Effect.Effect<DaemonRuntimeState | undefined, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const raw = await Fs.readFile(statePath(), "utf-8");
        return decodeRuntimeState(JSON.parse(raw) as unknown);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    catch: (error) =>
      new Error(`Failed to read daemon state at ${statePath()}: ${messageFromUnknown(error)}`),
  });

export const daemonHeaderStateFromStatus = (status: DaemonStatus): DaemonHeaderState => ({
  status: status.running ? "running" : "stopped",
  phase: status.running ? status.phase : "stopped",
  ...(Option.isSome(status.nextSyncAt)
    ? { nextSyncAt: DateTime.formatIso(status.nextSyncAt.value) }
    : {}),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const decodeRuntimeState = (value: unknown): DaemonRuntimeState => {
  if (!isRecord(value)) {
    throw new Error("Daemon state file is not a JSON object");
  }
  const phase = value["phase"];
  const parsedPhase = typeof phase === "string" ? phase : undefined;
  const pid = value["pid"];
  const startedAt = value["startedAt"];
  const yamlPath = value["yamlPath"];
  if (
    !isDaemonPhase(parsedPhase) ||
    typeof pid !== "number" ||
    typeof startedAt !== "string" ||
    typeof yamlPath !== "string"
  ) {
    throw new Error("Daemon state file is missing required fields");
  }
  if (
    (value["lastError"] !== undefined && typeof value["lastError"] !== "string") ||
    (value["lastEventAt"] !== undefined && typeof value["lastEventAt"] !== "string") ||
    (value["lastOutcome"] !== undefined &&
      value["lastOutcome"] !== "deferred" &&
      value["lastOutcome"] !== "failed" &&
      value["lastOutcome"] !== "noop" &&
      value["lastOutcome"] !== "success") ||
    (value["lastSyncAt"] !== undefined && typeof value["lastSyncAt"] !== "string") ||
    (value["nextSyncAt"] !== undefined && typeof value["nextSyncAt"] !== "string")
  ) {
    throw new Error("Daemon state file has invalid optional fields");
  }

  return {
    phase: parsedPhase,
    pid,
    startedAt,
    yamlPath,
    ...(value["lastError"] ? { lastError: value["lastError"] } : {}),
    ...(value["lastEventAt"] ? { lastEventAt: value["lastEventAt"] } : {}),
    ...(value["lastOutcome"] ? { lastOutcome: value["lastOutcome"] as DaemonOutcome } : {}),
    ...(value["lastSyncAt"] ? { lastSyncAt: value["lastSyncAt"] } : {}),
    ...(value["nextSyncAt"] ? { nextSyncAt: value["nextSyncAt"] } : {}),
  };
};

export const generatePlist = (config: DaemonConfig): string => {
  const environmentEntries = Object.entries(config.environment).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const stdoutLog = Path.join(config.logDir, "bookmarks-sync.log");
  const stderrLog = Path.join(config.logDir, "bookmarks-sync.error.log");
  const environmentBlock =
    environmentEntries.length === 0
      ? ""
      : `    <key>EnvironmentVariables</key>
    <dict>
${environmentEntries
  .map(
    ([key, value]) =>
      `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`,
  )
  .join("\n")}
    </dict>
`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(config.launcherPath)}</string>
        <string>${escapeXml(config.bunPath)}</string>
        <string>${escapeXml(config.runnerPath)}</string>
    </array>
${environmentBlock}    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutLog)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrLog)}</string>
    <key>WorkingDirectory</key>
    <string>${escapeXml(config.workingDir)}</string>
</dict>
</plist>
`;
};

export const defaultConfig = (): Effect.Effect<DaemonConfig, Error> =>
  Effect.gen(function* () {
    const bunPath = yield* resolveBunPath();
    return {
      bunPath,
      launcherPath: defaultLauncherPath(),
      environment: forwardedEnvironment(),
      logDir: defaultLogDir(),
      runnerPath: defaultRunnerPath(),
      workingDir: Path.resolve(import.meta.dirname, "../.."),
    };
  });

const readText = (filePath: string): Effect.Effect<string | undefined, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await Fs.readFile(filePath, "utf-8");
      } catch (error) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    catch: (error) => new Error(`Failed to read ${filePath}: ${messageFromUnknown(error)}`),
  });

/** The first Apple Development identity in the keychain, else ad-hoc signing (`-`). */
const signingIdentity = (): Effect.Effect<string, Error> =>
  pipe(
    execFileEffect("security", ["find-identity", "-v", "-p", "codesigning"]),
    Effect.map((stdout) => /"(Apple Development: [^"]+)"/.exec(stdout)?.[1] ?? "-"),
    Effect.catchAll(() => Effect.succeed("-")),
  );

/**
 * Build and sign the launcher when it is missing or its source changed. Signed with an Apple
 * Development certificate and a fixed identifier, its Full Disk Access grant outlives the
 * rebuild; an ad-hoc signature would tie the grant to this one build.
 */
export const ensureLauncher = (launcherPath: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (process.env["BOOKMARKS_DAEMON_LAUNCHER_PATH"] !== undefined) return;
    const source = yield* readText(launcherSourcePath());
    if (source === undefined) {
      return yield* Effect.fail(new Error(`Missing launcher source ${launcherSourcePath()}`));
    }
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const stampPath = `${launcherPath}.source-sha256`;
    if ((yield* fileExists(launcherPath)) && (yield* readText(stampPath))?.trim() === sourceHash)
      return;

    yield* mkdir(Path.dirname(launcherPath));
    const buildPath = `${launcherPath}.build`;
    yield* execFileEffect("cc", ["-O2", "-o", buildPath, launcherSourcePath()]);
    yield* execFileEffect("codesign", [
      "--force",
      "--sign",
      yield* signingIdentity(),
      "--identifier",
      LAUNCHER_IDENTIFIER,
      buildPath,
    ]);
    yield* Effect.tryPromise({
      try: () => Fs.rename(buildPath, launcherPath),
      catch: (error) =>
        new Error(`Failed to install ${launcherPath}: ${messageFromUnknown(error)}`),
    });
    yield* writeFile(stampPath, `${sourceHash}\n`);
  });

export const start = (config: DaemonConfig): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* mkdir(plistDir());
    yield* mkdir(config.logDir);
    yield* ensureLauncher(config.launcherPath);

    const installedPlistPath = plistPath();
    yield* pipe(
      execFileEffect("launchctl", ["unload", installedPlistPath]),
      Effect.catchAll(() => Effect.void),
    );
    yield* writeFile(installedPlistPath, generatePlist(config));
    yield* execFileEffect("launchctl", ["load", installedPlistPath]);
  });

export const stop = (): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const installedPlistPath = plistPath();
    const exists = yield* fileExists(installedPlistPath);
    if (!exists) {
      return yield* Effect.fail(
        new Error(`Plist not found: ${installedPlistPath}. Is the daemon running?`),
      );
    }

    yield* pipe(
      execFileEffect("launchctl", ["unload", installedPlistPath]),
      Effect.catchAll(() => Effect.void),
    );
    yield* removeFile(installedPlistPath);
    yield* pipe(
      removeFile(statePath()),
      Effect.catchAll(() => Effect.void),
    );
  });

export const status = (): Effect.Effect<DaemonStatus, Error> =>
  Effect.gen(function* () {
    const running = yield* pipe(
      execFileEffect("launchctl", ["list", LABEL]),
      Effect.map(() => true),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    const runtimeState = yield* pipe(
      readRuntimeState(),
      Effect.catchAll(() => Effect.succeed(undefined)),
    );

    return {
      lastError: runtimeState?.lastError,
      lastEventAt: toUtcOption(runtimeState?.lastEventAt),
      lastOutcome: runtimeState?.lastOutcome,
      lastSyncAt: toUtcOption(runtimeState?.lastSyncAt),
      nextSyncAt: toUtcOption(runtimeState?.nextSyncAt),
      phase: running ? (runtimeState?.phase ?? "starting") : "stopped",
      pid: runtimeState?.pid,
      launcherPath: defaultLauncherPath(),
      plistPath: installedPlistPath(),
      running,
      startedAt: toUtcOption(runtimeState?.startedAt),
      statePath: statePath(),
      yamlPath: runtimeState?.yamlPath ?? Paths.defaultYamlPath(),
    };
  });

const installedPlistPath = (): string => plistPath();
