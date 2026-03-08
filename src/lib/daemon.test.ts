import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Option } from "effect";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as StaticDaemon from "./daemon.ts";
import { readDaemonHeaderState, SCHEMA_MODELINE } from "./managed-config-header.ts";
import { BookmarkTree, BookmarksConfig } from "./schema/__.ts";
import * as YamlModule from "./yaml.ts";

type DaemonModule = typeof StaticDaemon;

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);
const bunBinary = Bun.which("bun") ?? process.execPath;
const daemonRunnerPath = join(process.cwd(), "src", "bin", "bookmarks-daemon.ts");

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

const waitFor = async (
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
  pollMs = 25,
): Promise<void> => {
  const startedAt = Date.now();
  const poll = async (): Promise<void> => {
    if (await predicate()) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }
    await Bun.sleep(pollMs);
    await poll();
  };

  await poll();
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
  const originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
  const originalXdgStateHome = process.env["XDG_STATE_HOME"];

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
  process.env["XDG_CONFIG_HOME"] = join(homeDir, ".config");
  process.env["XDG_STATE_HOME"] = join(homeDir, ".local", "state");

  return {
    bunPath,
    cleanup: async () => {
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;

      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;

      if (originalXdgConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;

      if (originalXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = originalXdgStateHome;

      await rm(dir, { recursive: true, force: true });
    },
    homeDir,
    module: StaticDaemon,
    stateFile,
  };
};

describe("daemon", () => {
  test("generatePlist embeds the watcher daemon contract", () => {
    const plist = StaticDaemon.generatePlist({
      bunPath: "/usr/local/bin/bun",
      environment: {
        BOOKMARKS_DAEMON_CLI_PATH: "/repo/src/bin/bookmarks.ts",
        BOOKMARKS_YAML_PATH: "/tmp/bookmarks.yaml",
        PATH: "/usr/bin:/bin",
      },
      logDir: "/tmp/test-logs",
      runnerPath: "/repo/src/bin/bookmarks-daemon.ts",
      workingDir: "/tmp/test-workdir",
    });

    expect(plist).toContain("/usr/local/bin/bun");
    expect(plist).toContain("/repo/src/bin/bookmarks-daemon.ts");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).not.toContain("StartInterval");
  });

  test("defaultConfig resolves bun from PATH and points launchd at the daemon runner", async () => {
    const env = await setupDaemonEnv();

    try {
      const config = await run(env.module.defaultConfig());
      expect(config.bunPath).toBe(env.bunPath);
      expect(config.logDir).toBe(join(env.homeDir, "Library/Logs/bookmarks-sync"));
      expect(config.runnerPath).toBe(join(process.cwd(), "src", "bin", "bookmarks-daemon.ts"));
      expect(config.environment["BOOKMARKS_DAEMON_CLI_PATH"]).toBe(
        join(process.cwd(), "src", "bin", "bookmarks.ts"),
      );
    } finally {
      await env.cleanup();
    }
  });

  test("start installs the watcher plist and status reports a starting daemon without runtime state", async () => {
    const env = await setupDaemonEnv();
    const plistPath = join(env.homeDir, "Library/LaunchAgents/com.jasonkuhrt.bookmarks-sync.plist");
    const config = {
      bunPath: env.bunPath,
      environment: {
        BOOKMARKS_DAEMON_CLI_PATH: join(process.cwd(), "src", "bin", "bookmarks.ts"),
        PATH: process.env["PATH"] ?? "",
      },
      logDir: join(env.homeDir, "Library/Logs/bookmarks-sync"),
      runnerPath: join(process.cwd(), "src", "bin", "bookmarks-daemon.ts"),
      workingDir: process.cwd(),
    };

    try {
      await run(env.module.start(config));

      expect(await exists(plistPath)).toBe(true);
      expect(await exists(env.stateFile)).toBe(true);

      const plist = await readFile(plistPath, "utf-8");
      expect(plist).toContain(config.runnerPath);
      expect(plist).toContain(config.environment["BOOKMARKS_DAEMON_CLI_PATH"]);

      const status = await run(env.module.status());
      expect(status.running).toBe(true);
      expect(status.phase).toBe("starting");
      expect(status.plistPath).toBe(plistPath);
      expect(status.yamlPath).toBe(join(env.homeDir, ".config", "bookmarks", "bookmarks.yaml"));
      expect(Option.isNone(status.lastSyncAt)).toBe(true);
      expect(Option.isNone(status.nextSyncAt)).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  test("status reads runtime state details when the watcher has reported them", async () => {
    const env = await setupDaemonEnv();
    const runtimeDir = join(env.homeDir, ".local", "state", "bookmarks", "runtime");
    const daemonStatePath = join(runtimeDir, "daemon.state.json");

    try {
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(
        env.stateFile,
        join(env.homeDir, "Library/LaunchAgents/com.jasonkuhrt.bookmarks-sync.plist"),
        "utf-8",
      );
      await writeFile(
        daemonStatePath,
        JSON.stringify(
          {
            pid: 12345,
            phase: "queued",
            startedAt: "2026-03-08T10:00:00.000Z",
            lastEventAt: "2026-03-08T10:01:00.000Z",
            lastSyncAt: "2026-03-08T10:02:00.000Z",
            nextSyncAt: "2026-03-08T10:03:00.000Z",
            lastOutcome: "success",
            yamlPath: "/tmp/bookmarks.yaml",
          },
          null,
          2,
        ),
        "utf-8",
      );

      const status = await run(env.module.status());
      expect(status.running).toBe(true);
      expect(status.phase).toBe("queued");
      expect(status.pid).toBe(12345);
      expect(status.lastOutcome).toBe("success");
      expect(status.yamlPath).toBe("/tmp/bookmarks.yaml");

      if (
        !Option.isSome(status.startedAt) ||
        !Option.isSome(status.lastEventAt) ||
        !Option.isSome(status.lastSyncAt) ||
        !Option.isSome(status.nextSyncAt)
      ) {
        throw new Error("Expected daemon timestamps to be populated");
      }

      expect(DateTime.formatIso(status.startedAt.value)).toContain("2026-03-08T10:00:00");
      expect(DateTime.formatIso(status.nextSyncAt.value)).toContain("2026-03-08T10:03:00");
    } finally {
      await env.cleanup();
    }
  });

  test("status falls back cleanly when the daemon is not running", async () => {
    const env = await setupDaemonEnv();

    try {
      const status = await run(env.module.status());
      expect(status.running).toBe(false);
      expect(status.phase).toBe("stopped");
      expect(Option.isNone(status.lastEventAt)).toBe(true);
      expect(Option.isNone(status.lastSyncAt)).toBe(true);
      expect(Option.isNone(status.nextSyncAt)).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  test("status ignores malformed runtime state files and falls back to starting", async () => {
    const env = await setupDaemonEnv();
    const runtimeDir = join(env.homeDir, ".local", "state", "bookmarks", "runtime");
    const daemonStatePath = join(runtimeDir, "daemon.state.json");

    try {
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(
        env.stateFile,
        join(env.homeDir, "Library/LaunchAgents/com.jasonkuhrt.bookmarks-sync.plist"),
        "utf-8",
      );
      await writeFile(daemonStatePath, '{"phase":"queued"}', "utf-8");

      const status = await run(env.module.status());
      expect(status.running).toBe(true);
      expect(status.phase).toBe("starting");
      expect(status.lastOutcome).toBeUndefined();
    } finally {
      await env.cleanup();
    }
  });

  test("stop unloads the daemon and removes plist and runtime state", async () => {
    const env = await setupDaemonEnv();
    const plistPath = join(env.homeDir, "Library/LaunchAgents/com.jasonkuhrt.bookmarks-sync.plist");
    const runtimeDir = join(env.homeDir, ".local", "state", "bookmarks", "runtime");
    const daemonStatePath = join(runtimeDir, "daemon.state.json");

    try {
      await run(
        env.module.start({
          bunPath: env.bunPath,
          environment: {
            BOOKMARKS_DAEMON_CLI_PATH: join(process.cwd(), "src", "bin", "bookmarks.ts"),
            PATH: process.env["PATH"] ?? "",
          },
          logDir: join(env.homeDir, "Library/Logs/bookmarks-sync"),
          runnerPath: join(process.cwd(), "src", "bin", "bookmarks-daemon.ts"),
          workingDir: process.cwd(),
        }),
      );
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(daemonStatePath, "{}", "utf-8");

      await run(env.module.stop());

      expect(await exists(plistPath)).toBe(false);
      expect(await exists(env.stateFile)).toBe(false);
      expect(await exists(daemonStatePath)).toBe(false);
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

  test("daemonHeaderStateFromStatus maps queued next-sync state into the managed header format", () => {
    const header = StaticDaemon.daemonHeaderStateFromStatus({
      lastError: undefined,
      lastEventAt: Option.none(),
      lastOutcome: "noop",
      lastSyncAt: Option.none(),
      nextSyncAt: Option.some(DateTime.unsafeMake("2026-03-08T10:03:00.000Z")),
      phase: "queued",
      pid: 123,
      plistPath: "/tmp/com.example.plist",
      running: true,
      startedAt: Option.none(),
      statePath: "/tmp/daemon.state.json",
      yamlPath: "/tmp/bookmarks.yaml",
    });

    expect(header).toEqual({
      status: "running",
      phase: "queued",
      nextSyncAt: "2026-03-08T10:03:00.000Z",
    });
  });

  test("watcher queues a delayed sync and updates the managed header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-watch-"));
    const yamlPath = join(dir, "bookmarks.yaml");
    const runtimeDir = join(dir, "runtime");
    const pendingPath = join(dir, "pending.flag");
    const syncLogPath = join(dir, "sync.log");
    const fakeCliPath = join(dir, "fake-cli.ts");

    try {
      await run(
        YamlModule.save(
          yamlPath,
          BookmarksConfig.make({
            all: BookmarkTree.make({}),
          }),
        ),
      );

      await writeFile(
        fakeCliPath,
        `import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
const pendingPath = ${JSON.stringify(pendingPath)};
const syncLogPath = ${JSON.stringify(syncLogPath)};
const [command] = process.argv.slice(2);
if (command === "status") {
  const pending = existsSync(pendingPath);
  console.log(JSON.stringify({
    yamlPath: process.env["BOOKMARKS_YAML_PATH"],
    targets: pending ? [{ pendingToBrowser: [{}], pendingToYaml: [] }] : [],
  }));
  process.exit(0);
}
if (command === "sync") {
  const previous = existsSync(syncLogPath) ? await readFile(syncLogPath, "utf-8") : "";
  await writeFile(syncLogPath, previous + "sync\\n", "utf-8");
  await rm(pendingPath, { force: true });
  console.log(JSON.stringify({
    orchestration: null,
    applied: [],
    graveyarded: [],
    targets: [],
  }));
  process.exit(0);
}
console.error(JSON.stringify({ error: "unexpected command" }));
process.exit(1);
`,
        "utf-8",
      );

      const proc = Bun.spawn([bunBinary, daemonRunnerPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BOOKMARKS_DAEMON_CLI_PATH: fakeCliPath,
          BOOKMARKS_DAEMON_SYNC_DELAY_MS: "150",
          BOOKMARKS_RUNTIME_DIR: runtimeDir,
          BOOKMARKS_YAML_PATH: yamlPath,
        },
        stderr: "pipe",
        stdout: "pipe",
      });

      try {
        await waitFor(async () => {
          const contents = await readFile(yamlPath, "utf-8");
          return contents.startsWith(
            "# machine-managed: bookmarks daemon status=running; phase=idle\n",
          );
        });

        const initialContents = await readFile(yamlPath, "utf-8");
        expect(initialContents).toContain(`${SCHEMA_MODELINE}\nversion: 2\n`);
        expect(await exists(syncLogPath)).toBe(false);

        await writeFile(pendingPath, "pending", "utf-8");
        await appendFile(yamlPath, "# user edit\n", "utf-8");

        await waitFor(async () => {
          const contents = await readFile(yamlPath, "utf-8");
          return contents.startsWith(
            "# machine-managed: bookmarks daemon status=running; phase=queued;",
          );
        });

        await Bun.sleep(75);
        expect(await exists(syncLogPath)).toBe(false);

        await waitFor(async () => {
          if (!(await exists(syncLogPath))) return false;
          return (await readFile(syncLogPath, "utf-8")) === "sync\n";
        });
        await waitFor(async () => {
          const contents = await readFile(yamlPath, "utf-8");
          return contents.startsWith(
            "# machine-managed: bookmarks daemon status=running; phase=idle\n",
          );
        });
      } finally {
        proc.kill("SIGTERM");
        await proc.exited;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("watcher returns to idle without syncing when the queued edit produces no pending work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-noop-"));
    const yamlPath = join(dir, "bookmarks.yaml");
    const runtimeDir = join(dir, "runtime");
    const syncLogPath = join(dir, "sync.log");
    const fakeCliPath = join(dir, "fake-cli.ts");

    try {
      await run(
        YamlModule.save(
          yamlPath,
          BookmarksConfig.make({
            all: BookmarkTree.make({}),
          }),
        ),
      );

      await writeFile(
        fakeCliPath,
        `import { writeFile } from "node:fs/promises";
const syncLogPath = ${JSON.stringify(syncLogPath)};
const [command] = process.argv.slice(2);
if (command === "status") {
  console.log(JSON.stringify({
    yamlPath: process.env["BOOKMARKS_YAML_PATH"],
    targets: [],
  }));
  process.exit(0);
}
if (command === "sync") {
  await writeFile(syncLogPath, "unexpected\\n", "utf-8");
  console.log(JSON.stringify({ orchestration: null, applied: [], graveyarded: [], targets: [] }));
  process.exit(0);
}
console.error(JSON.stringify({ error: "unexpected command" }));
process.exit(1);
`,
        "utf-8",
      );

      const proc = Bun.spawn([bunBinary, daemonRunnerPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BOOKMARKS_DAEMON_CLI_PATH: fakeCliPath,
          BOOKMARKS_DAEMON_SYNC_DELAY_MS: "120",
          BOOKMARKS_RUNTIME_DIR: runtimeDir,
          BOOKMARKS_YAML_PATH: yamlPath,
        },
        stderr: "pipe",
        stdout: "pipe",
      });

      try {
        await waitFor(async () => {
          const contents = await readFile(yamlPath, "utf-8");
          return contents.startsWith(
            "# machine-managed: bookmarks daemon status=running; phase=idle\n",
          );
        });

        await appendFile(yamlPath, "# no-op edit\n", "utf-8");

        await waitFor(async () => {
          const contents = await readFile(yamlPath, "utf-8");
          return contents.startsWith(
            "# machine-managed: bookmarks daemon status=running; phase=queued;",
          );
        });
        await waitFor(async () => {
          const contents = await readFile(yamlPath, "utf-8");
          return contents.startsWith(
            "# machine-managed: bookmarks daemon status=running; phase=idle\n",
          );
        });

        expect(await exists(syncLogPath)).toBe(false);
      } finally {
        proc.kill("SIGTERM");
        await proc.exited;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("watcher writes a stopped header and removes runtime state on shutdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-shutdown-"));
    const yamlPath = join(dir, "bookmarks.yaml");
    const runtimeDir = join(dir, "runtime");
    const daemonStatePath = join(runtimeDir, "daemon.state.json");

    try {
      await run(
        YamlModule.save(
          yamlPath,
          BookmarksConfig.make({
            all: BookmarkTree.make({}),
          }),
        ),
      );

      const proc = Bun.spawn([bunBinary, daemonRunnerPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BOOKMARKS_RUNTIME_DIR: runtimeDir,
          BOOKMARKS_YAML_PATH: yamlPath,
        },
        stderr: "pipe",
        stdout: "pipe",
      });

      try {
        await waitFor(async () => {
          const header = await readDaemonHeaderState(yamlPath);
          return header?.status === "running" && header.phase === "idle";
        });
      } finally {
        proc.kill("SIGTERM");
        await proc.exited;
      }

      expect(await readDaemonHeaderState(yamlPath)).toEqual({
        status: "stopped",
        phase: "stopped",
      });
      expect(await exists(daemonStatePath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
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
