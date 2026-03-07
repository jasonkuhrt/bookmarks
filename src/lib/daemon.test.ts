import { describe, expect, test } from "bun:test";
import { DateTime, Duration, Effect, Option } from "effect";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as StaticDaemon from "./daemon.ts";

type DaemonModule = typeof StaticDaemon;

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);

const writeExecutable = async (path: string, content: string): Promise<void> => {
  await writeFile(path, content, { encoding: "utf-8", mode: 0o755 });
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const setupDaemonEnv = async (): Promise<{
  readonly bunPath: string;
  readonly cleanup: () => Promise<void>;
  readonly homeDir: string;
  readonly module: DaemonModule;
  readonly stateFile: string;
}> => {
  const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-"));
  const homeDir = join(dir, "home");
  const binDir = join(dir, "bin");
  const bunPath = join(binDir, "bun");
  const stateFile = join(dir, "launchctl.state");
  const originalHome = process.env["HOME"];
  const originalPath = process.env["PATH"];

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  await writeExecutable(bunPath, "#!/bin/sh\nexit 0\n");
  await writeExecutable(
    join(binDir, "which"),
    `#!/bin/sh
if [ "$1" = "bun" ]; then
  printf '%s\n' '${bunPath}'
  exit 0
fi
exit 1
`,
  );
  await writeExecutable(
    join(binDir, "launchctl"),
    `#!/bin/sh
case "$1" in
  load)
    printf '%s\n' "$2" > '${stateFile}'
    exit 0
    ;;
  unload)
    rm -f '${stateFile}'
    exit 0
    ;;
  list)
    if [ -f '${stateFile}' ]; then
      printf '%s\n' 'loaded'
      exit 0
    fi
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`,
  );

  process.env["HOME"] = homeDir;
  process.env["PATH"] = `${binDir}:${originalPath ?? ""}`;

  const module = StaticDaemon;

  return {
    bunPath,
    cleanup: async () => {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;

      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;

      await rm(dir, { recursive: true, force: true });
    },
    homeDir,
    module,
    stateFile,
  };
};

describe("daemon", () => {
  test("generatePlist embeds the daemon contract", () => {
    const plist = StaticDaemon.generatePlist({
      interval: Duration.hours(1),
      logDir: "/tmp/test-logs",
      workingDir: "/tmp/test-workdir",
      bunPath: "/usr/local/bin/bun",
    });

    expect(plist).toContain("<integer>3600</integer>");
    expect(plist).toContain("/usr/local/bin/bun");
    expect(plist).toContain("/tmp/test-logs/bookmarks-sync.log");
    expect(plist).toContain("/tmp/test-workdir");
  });

  test("defaultConfig resolves bun from PATH and uses the project root as working directory", async () => {
    const env = await setupDaemonEnv();

    try {
      const config = await run(env.module.defaultConfig());
      expect(config.bunPath).toBe(env.bunPath);
      expect(Math.round(Duration.toSeconds(config.interval))).toBe(3600);
      expect(config.logDir).toBe(join(env.homeDir, "Library/Logs/bookmarks-sync"));
      expect(config.workingDir).toBe(process.cwd());
    } finally {
      await env.cleanup();
    }
  });

  test("start installs the plist and status reports the next scheduled run", async () => {
    const env = await setupDaemonEnv();
    const plistPath = join(env.homeDir, "Library/LaunchAgents/com.jasonkuhrt.bookmarks-sync.plist");
    const logDir = join(env.homeDir, "Library/Logs/bookmarks-sync");
    const config = {
      interval: Duration.minutes(30),
      logDir,
      workingDir: process.cwd(),
      bunPath: env.bunPath,
    };

    try {
      await run(env.module.start(config));

      expect(await exists(plistPath)).toBe(true);
      expect(await exists(env.stateFile)).toBe(true);

      const plist = await readFile(plistPath, "utf-8");
      expect(plist).toContain("<integer>1800</integer>");
      expect(plist).toContain(env.bunPath);

      await writeFile(
        join(logDir, "bookmarks-sync.log"),
        "2026-03-07T01:00:00Z sync complete\nignored line\n",
        "utf-8",
      );

      const status = await run(env.module.status());
      expect(status.running).toBe(true);
      expect(status.plistPath).toBe(plistPath);
      expect(Option.isSome(status.lastRun)).toBe(true);
      expect(Option.isSome(status.nextRun)).toBe(true);

      if (!Option.isSome(status.lastRun) || !Option.isSome(status.nextRun)) {
        throw new Error("Expected daemon status timestamps");
      }

      expect(DateTime.formatIso(status.lastRun.value)).toContain("2026-03-07T01:00:00");
      expect(DateTime.formatIso(status.nextRun.value)).toContain("2026-03-07T01:30:00");
    } finally {
      await env.cleanup();
    }
  });

  test("status falls back cleanly when the daemon is not running", async () => {
    const env = await setupDaemonEnv();

    try {
      const status = await run(env.module.status());
      expect(status.running).toBe(false);
      expect(Option.isNone(status.lastRun)).toBe(true);
      expect(Option.isNone(status.nextRun)).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  test("stop unloads the daemon and removes the installed plist", async () => {
    const env = await setupDaemonEnv();
    const plistPath = join(env.homeDir, "Library/LaunchAgents/com.jasonkuhrt.bookmarks-sync.plist");

    try {
      await run(
        env.module.start({
          interval: Duration.hours(1),
          logDir: join(env.homeDir, "Library/Logs/bookmarks-sync"),
          workingDir: process.cwd(),
          bunPath: env.bunPath,
        }),
      );
      await run(env.module.stop());

      expect(await exists(plistPath)).toBe(false);
      expect(await exists(env.stateFile)).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  test("stop fails when no plist has been installed", async () => {
    const env = await setupDaemonEnv();

    try {
      await expectStopFailure(run(env.module.stop()), "Plist not found");
    } finally {
      await env.cleanup();
    }
  });
});

const expectStopFailure = async (promise: Promise<unknown>, message: string): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected rejection containing "${message}"`);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.message).toContain(message);
  }
};
