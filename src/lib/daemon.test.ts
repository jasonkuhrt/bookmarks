import { describe, expect, test } from "bun:test";
import { serialize } from "@plist/binary.serialize";
import { DateTime, Effect, Option } from "effect";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ReadingList from "./reading-list.ts";
import * as StaticDaemon from "./daemon.ts";
import * as Safari from "./safari.ts";
import * as Fingerprint from "./fingerprint.ts";
import { readDaemonHeaderState } from "./managed-config-header.ts";
import { BookmarkLeaf, BookmarkTree, BookmarksConfig, ReadingListItem } from "./schema/__.ts";
import * as Targets from "./targets.ts";
import * as YamlModule from "./yaml.ts";

interface RuntimeStateView {
  readonly lastError?: string;
  readonly lastOutcome?: string;
  readonly phase?: string;
}

const readRuntimeState = async (path: string): Promise<RuntimeStateView> => {
  if (!(await exists(path))) return {};
  const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const text = (key: string): string | undefined => {
    const value: unknown = Reflect.get(parsed, key);
    return typeof value === "string" ? value : undefined;
  };
  const lastError = text("lastError");
  const lastOutcome = text("lastOutcome");
  const phase = text("phase");
  return {
    ...(lastError === undefined ? {} : { lastError }),
    ...(lastOutcome === undefined ? {} : { lastOutcome }),
    ...(phase === undefined ? {} : { phase }),
  };
};

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

/** A Chrome Bookmarks file whose bar holds `bar`, with Chrome Sync's metadata blob. */
const chromeFile = (
  bar: readonly { readonly name: string; readonly url: string }[],
  syncMetadata = "",
) =>
  JSON.stringify({
    checksum: "",
    version: 1,
    sync_metadata: syncMetadata,
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "Bookmarks Bar",
        id: "1",
        guid: "bar",
        date_added: "0",
        date_modified: "0",
        children: bar.map((bookmark, index) => ({
          type: "url",
          id: String(index + 10),
          guid: `leaf-${index}`,
          date_added: "0",
          ...bookmark,
        })),
      },
      other: {
        type: "folder",
        name: "Other Bookmarks",
        id: "2",
        guid: "other",
        date_added: "0",
        date_modified: "0",
        children: [],
      },
      synced: {
        type: "folder",
        name: "Mobile Bookmarks",
        id: "3",
        guid: "mobile",
        date_added: "0",
        date_modified: "0",
        children: [],
      },
    },
  });

/** A Safari plist whose bar holds one bookmark to a.example, titled `title`. */
const safariFile = (title: string, read?: boolean) =>
  new Uint8Array(
    serialize({
      Children: [
        {
          WebBookmarkType: "WebBookmarkTypeList",
          Title: "BookmarksBar",
          Children: [
            {
              WebBookmarkType: "WebBookmarkTypeLeaf",
              URLString: "https://a.example/",
              URIDictionary: { title },
            },
          ],
        },
        ...(read === undefined
          ? []
          : [
              {
                WebBookmarkType: "WebBookmarkTypeList",
                Title: "com.apple.ReadingList",
                Children: [
                  {
                    WebBookmarkType: "WebBookmarkTypeLeaf",
                    URLString: "https://article.example/",
                    URIDictionary: { title: "Article" },
                    ReadingList: read ? { DateLastViewed: new Date("2026-01-01T00:00:00Z") } : {},
                  },
                ],
              },
            ]),
      ],
    }),
  );

const setupDaemonEnv = async (): Promise<{
  readonly bunPath: string;
  readonly launcherPath: string;
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
  const originalConfigDir = process.env["BOOKMARKS_CONFIG_DIR"];
  const originalLauncherPath = process.env["BOOKMARKS_DAEMON_LAUNCHER_PATH"];
  const launcherPath = join(binDir, "bookmarks-sync");
  const originalStateDir = process.env["BOOKMARKS_STATE_DIR"];

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
  // These tests check the paths derived from HOME, under the sandbox the test preload set up.
  delete process.env["BOOKMARKS_CONFIG_DIR"];
  delete process.env["BOOKMARKS_STATE_DIR"];
  // A prebuilt launcher: these tests check the plist and launchctl calls, not the build.
  process.env["BOOKMARKS_DAEMON_LAUNCHER_PATH"] = launcherPath;

  return {
    bunPath,
    launcherPath,
    cleanup: async () => {
      if (originalLauncherPath === undefined) delete process.env["BOOKMARKS_DAEMON_LAUNCHER_PATH"];
      else process.env["BOOKMARKS_DAEMON_LAUNCHER_PATH"] = originalLauncherPath;
      if (originalConfigDir === undefined) delete process.env["BOOKMARKS_CONFIG_DIR"];
      else process.env["BOOKMARKS_CONFIG_DIR"] = originalConfigDir;
      if (originalStateDir === undefined) delete process.env["BOOKMARKS_STATE_DIR"];
      else process.env["BOOKMARKS_STATE_DIR"] = originalStateDir;

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
      launcherPath: "/state/bin/bookmarks-sync",
      environment: {
        BOOKMARKS_DAEMON_CLI_PATH: "/repo/src/bin/bookmarks.ts",
        BOOKMARKS_YAML_PATH: "/tmp/bookmarks.yaml",
        PATH: "/usr/bin:/bin",
      },
      logDir: "/tmp/test-logs",
      runnerPath: "/repo/src/bin/bookmarks-daemon.ts",
      workingDir: "/tmp/test-workdir",
    });

    // launchd runs the launcher, which holds Full Disk Access and runs bun as its child.
    expect(plist).toMatch(
      /<string>\/state\/bin\/bookmarks-sync<\/string>\s*<string>\/usr\/local\/bin\/bun<\/string>\s*<string>\/repo\/src\/bin\/bookmarks-daemon.ts<\/string>/,
    );
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).not.toContain("StartInterval");
  });

  test("the launcher is built and signed once, runs its arguments as a child, and keeps their exit status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-launcher-"));
    const launcherPath = join(dir, "bin", "bookmarks-sync");
    const original = process.env["BOOKMARKS_DAEMON_LAUNCHER_PATH"];
    delete process.env["BOOKMARKS_DAEMON_LAUNCHER_PATH"];

    try {
      await run(StaticDaemon.ensureLauncher(launcherPath));
      const built = await stat(launcherPath);
      await run(StaticDaemon.ensureLauncher(launcherPath));
      expect((await stat(launcherPath)).mtimeMs).toBe(built.mtimeMs);

      const signature = Bun.spawnSync(["codesign", "-dr", "-", launcherPath]);
      expect(signature.stdout.toString() + signature.stderr.toString()).toContain(
        'identifier "com.jasonkuhrt.bookmarks-sync"',
      );
      const child = Bun.spawnSync([launcherPath, "/bin/sh", "-c", "echo from-child; exit 7"]);
      expect(child.stdout.toString()).toBe("from-child\n");
      expect(child.exitCode).toBe(7);
    } finally {
      if (original === undefined) delete process.env["BOOKMARKS_DAEMON_LAUNCHER_PATH"];
      else process.env["BOOKMARKS_DAEMON_LAUNCHER_PATH"] = original;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

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
      launcherPath: env.launcherPath,
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
          launcherPath: env.launcherPath,
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
      launcherPath: "/state/bin/bookmarks-sync",
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

  const syncDoneReply = {
    orchestration: null,
    applied: [],
    graveyarded: [],
    targets: [],
    yamlChanged: false,
    waiting: [],
  };
  const syncDone = JSON.stringify(syncDoneReply);

  /**
   * A stand-in CLI: each `sync` appends a line to its log, runs the script for its turn (the
   * sync's own reads and writes, or a browser's edit while it runs), and prints the next
   * scripted reply.
   */
  const writeFakeCli = async (
    dir: string,
    replies: readonly string[],
    scripts: readonly string[] = [],
  ): Promise<{ readonly path: string; readonly syncs: () => Promise<number> }> => {
    const path = join(dir, "fake-cli.ts");
    const logPath = join(dir, "syncs.log");
    await writeFile(
      path,
      `import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
const logPath = ${JSON.stringify(logPath)};
const replies = ${JSON.stringify(replies)};
const [command] = process.argv.slice(2);
if (command !== "sync") {
  console.error(JSON.stringify({ error: "unexpected command " + command }));
  process.exit(1);
}
const previous = existsSync(logPath) ? await readFile(logPath, "utf-8") : "";
await writeFile(logPath, previous + "sync\\n", "utf-8");
const turn = previous.split("\\n").length - 1;
${scripts.map((script, turn) => `if (turn === ${turn}) {\n${script}\n}`).join("\n")}
const reply = replies[Math.min(turn, replies.length - 1)];
if (reply.startsWith("fail:")) {
  console.error(JSON.stringify({ error: reply.slice(5) }));
  process.exit(1);
}
console.log(reply);
`,
      "utf-8",
    );
    return {
      path,
      syncs: async () =>
        (await exists(logPath)) ? (await readFile(logPath, "utf-8")).split("\n").length - 1 : 0,
    };
  };

  const startWatcher = async (
    dir: string,
    cliPath: string,
    env: Readonly<Record<string, string>> = {},
  ) => {
    const yamlPath = join(dir, "bookmarks.yaml");
    if (!(await exists(yamlPath))) {
      await run(YamlModule.save(yamlPath, BookmarksConfig.make({ all: BookmarkTree.make({}) })));
    }
    return Bun.spawn([bunBinary, daemonRunnerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOOKMARKS_DAEMON_CLI_PATH: cliPath,
        BOOKMARKS_RUNTIME_DIR: join(dir, "runtime"),
        BOOKMARKS_YAML_PATH: yamlPath,
        ...env,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
  };

  const stopWatcher = async (proc: ReturnType<typeof Bun.spawn>) => {
    proc.kill("SIGTERM");
    await proc.exited;
  };

  test("watcher syncs at startup and after a YAML edit, but not after its own header writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-yaml-"));
    try {
      const cli = await writeFakeCli(dir, [syncDone]);
      const proc = await startWatcher(dir, cli.path, { BOOKMARKS_DAEMON_SYNC_DELAY_MS: "150" });
      try {
        await waitFor(async () => (await cli.syncs()) === 1);
        await waitFor(async () => {
          const header = await readDaemonHeaderState(join(dir, "bookmarks.yaml"));
          return header?.phase === "idle";
        });

        await appendFile(join(dir, "bookmarks.yaml"), "# one user edit\n", "utf-8");
        await waitFor(async () => (await cli.syncs()) === 2);
        await waitFor(
          async () =>
            (await readRuntimeState(join(dir, "runtime", "daemon.state.json"))).phase === "idle",
        );
        await Bun.sleep(400);
        expect(await cli.syncs()).toBe(2);
      } finally {
        await stopWatcher(proc);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("watcher syncs when Chrome's or Safari's bookmarks change, not when only their metadata does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-browsers-"));
    const chromeDataDir = join(dir, "Chrome");
    const chromePath = join(chromeDataDir, "Default", "Bookmarks");
    const safariPath = join(dir, "Safari", "Bookmarks.plist");
    // Browsers save through a temporary file they rename over the real one.
    const replace = async (path: string, contents: string | Uint8Array) => {
      await writeFile(`${path}.tmp`, contents);
      await rename(`${path}.tmp`, path);
    };

    try {
      await mkdir(join(chromeDataDir, "Default"), { recursive: true });
      await mkdir(join(dir, "Safari"), { recursive: true });
      await writeFile(
        join(chromeDataDir, "Local State"),
        JSON.stringify({ profile: { info_cache: { Default: {} } } }),
      );
      await writeFile(chromePath, chromeFile([{ name: "A", url: "https://a.example/" }], "one"));
      await writeFile(safariPath, safariFile("A"));
      const cli = await writeFakeCli(dir, [syncDone]);
      const proc = await startWatcher(dir, cli.path, {
        BOOKMARKS_DAEMON_SYNC_DELAY_MS: "100",
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
      });
      try {
        await waitFor(async () => (await cli.syncs()) === 1);
        await Bun.sleep(300);

        await replace(chromePath, chromeFile([{ name: "A", url: "https://a.example/" }], "two"));
        await Bun.sleep(600);
        expect(await cli.syncs()).toBe(1);

        await replace(chromePath, chromeFile([{ name: "B", url: "https://a.example/" }], "two"));
        await waitFor(async () => (await cli.syncs()) === 2);

        await Bun.sleep(300);
        await replace(safariPath, safariFile("Renamed in Safari"));
        await waitFor(async () => (await cli.syncs()) === 3);
        await replace(safariPath, safariFile("Renamed in Safari", false));
        await waitFor(async () => (await cli.syncs()) === 4);
        await replace(safariPath, safariFile("Renamed in Safari", true));
        await waitFor(async () => (await cli.syncs()) === 5);
        await replace(safariPath, safariFile("Renamed in Safari", false));
        await waitFor(async () => (await cli.syncs()) === 6);
      } finally {
        await stopWatcher(proc);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("watcher syncs again for a browser edit the sync never read, though no event reports it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-unread-edit-"));
    const chromeDataDir = join(dir, "Chrome");
    const chromePath = join(chromeDataDir, "Default", "Bookmarks");
    // The profile's file links to one outside its folder: an edit there raises no event.
    const realPath = join(dir, "elsewhere", "Bookmarks");
    const chrome = { browser: "chrome", profile: "default", path: chromePath } as const;
    const a = { name: "A", url: "https://a.example/" };
    const b = { name: "B", url: "https://b.example/" };
    const fingerprintOf = async (bar: readonly (typeof a)[]) => {
      await writeFile(realPath, chromeFile(bar));
      return Fingerprint.ofTree(await run(Targets.readFileTree(chrome)));
    };
    const read = (fingerprint: string) =>
      JSON.stringify({
        ...syncDoneReply,
        snapshot: { files: [{ path: chromePath, fingerprints: [fingerprint] }] },
      });

    try {
      await mkdir(join(chromeDataDir, "Default"), { recursive: true });
      await mkdir(join(dir, "elsewhere"));
      await writeFile(
        join(chromeDataDir, "Local State"),
        JSON.stringify({ profile: { info_cache: { Default: {} } } }),
      );
      await symlink(realPath, chromePath);
      const withB = await fingerprintOf([a, b]);
      const withoutB = await fingerprintOf([a]);
      // The first sync reads A, and Chrome saves B before the sync ends.
      const cli = await writeFakeCli(
        dir,
        [read(withoutB), read(withB)],
        [`await writeFile(${JSON.stringify(realPath)}, ${JSON.stringify(chromeFile([a, b]))});`],
      );
      const proc = await startWatcher(dir, cli.path, {
        BOOKMARKS_DAEMON_SYNC_DELAY_MS: "100",
        BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
      });
      try {
        await waitFor(async () => (await cli.syncs()) === 2);
        await Bun.sleep(400);
        expect(await cli.syncs()).toBe(2);
      } finally {
        await stopWatcher(proc);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("watcher queues no second sync for the sync's own writes, and still syncs a later edit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-own-writes-"));
    const yamlPath = join(dir, "bookmarks.yaml");
    const safariPath = join(dir, "Safari", "Bookmarks.plist");
    const safari = { browser: "safari", path: safariPath } as const;
    const safariFingerprint = async () =>
      Fingerprint.ofState(await run(Safari.readState(safari.path)));

    try {
      await mkdir(join(dir, "Safari"), { recursive: true });
      await writeFile(safariPath, safariFile("A"));
      const read = await safariFingerprint();
      await writeFile(safariPath, safariFile("Renamed by the sync"));
      const written = await safariFingerprint();
      await writeFile(safariPath, safariFile("A"));
      await run(YamlModule.save(yamlPath, BookmarksConfig.make({ all: BookmarkTree.make({}) })));
      const yamlWritten = await run(
        YamlModule.render(
          BookmarksConfig.make({
            all: BookmarkTree.make({
              bar: [BookmarkLeaf.make({ name: "Renamed by the sync", url: "https://a.example/" })],
            }),
          }),
        ),
      );
      // The sync writes the YAML and Safari's plist, then takes a while to finish.
      const cli = await writeFakeCli(
        dir,
        [
          JSON.stringify({
            ...syncDoneReply,
            yamlChanged: true,
            snapshot: {
              files: [
                { path: yamlPath, fingerprints: [Fingerprint.ofText(yamlWritten)] },
                { path: safariPath, fingerprints: [read, written] },
              ],
            },
          }),
          syncDone,
        ],
        [
          `const { rename } = await import("node:fs/promises");
await writeFile(${JSON.stringify(yamlPath)}, ${JSON.stringify(yamlWritten)});
await writeFile(${JSON.stringify(`${safariPath}.tmp`)}, Buffer.from(${JSON.stringify(Buffer.from(safariFile("Renamed by the sync")).toString("base64"))}, "base64"));
await rename(${JSON.stringify(`${safariPath}.tmp`)}, ${JSON.stringify(safariPath)});
await Bun.sleep(500);`,
        ],
      );
      const proc = await startWatcher(dir, cli.path, {
        BOOKMARKS_DAEMON_SYNC_DELAY_MS: "150",
        BOOKMARKS_SAFARI_PLIST_PATH: safariPath,
      });
      try {
        await waitFor(async () => (await cli.syncs()) === 1);
        await waitFor(
          async () =>
            (await readRuntimeState(join(dir, "runtime", "daemon.state.json"))).phase === "idle",
        );
        await Bun.sleep(600);
        expect(await cli.syncs()).toBe(1);

        await appendFile(yamlPath, "# a later edit\n", "utf-8");
        await waitFor(async () => (await cli.syncs()) === 2);
      } finally {
        await stopWatcher(proc);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Reading List stamps schedule read-only changes and suppress the sync's own stamps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-reading-list-"));
    const configDir = join(dir, "config");
    const runtimeDir = join(dir, "runtime");
    const instanceId = "12345678-1234-1234-1234-123456789abc";
    const stamp = join(runtimeDir, `${instanceId}.reading-list`);
    const unread = ReadingList.fingerprint([
      ReadingListItem.make({ name: "A", url: "https://a.example/", read: false }),
    ]);
    const read = ReadingList.fingerprint([
      ReadingListItem.make({ name: "A", url: "https://a.example/", read: true }),
    ]);
    try {
      await mkdir(configDir, { recursive: true });
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(
        join(configDir, "chrome-bridge.json"),
        JSON.stringify([{ profilePath: join(dir, "Bookmarks"), instanceId }]),
      );
      await writeFile(stamp, unread + "\n");
      const cli = await writeFakeCli(
        dir,
        [
          JSON.stringify({
            ...syncDoneReply,
            snapshot: {
              files: [{ path: stamp, fingerprints: [unread, read], finalFingerprint: read }],
            },
          }),
          syncDone,
        ],
        [
          `await writeFile(${JSON.stringify(stamp)}, ${JSON.stringify(read + "\n")}); await Bun.sleep(250);`,
        ],
      );
      const proc = await startWatcher(dir, cli.path, {
        BOOKMARKS_CONFIG_DIR: configDir,
        BOOKMARKS_DAEMON_SYNC_DELAY_MS: "100",
      });
      try {
        await waitFor(
          async () =>
            (await readRuntimeState(join(runtimeDir, "daemon.state.json"))).phase === "idle",
        );
        await Bun.sleep(350);
        expect(await cli.syncs()).toBe(1);
        await writeFile(stamp, unread + "\n");
        await waitFor(async () => (await cli.syncs()) === 2);
        await Bun.sleep(350);
        expect(await cli.syncs()).toBe(2);
      } finally {
        await stopWatcher(proc);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("watcher retries a sync another sync held off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-busy-"));
    try {
      const busy = JSON.stringify({
        orchestration: {
          state: "busy",
          operation: "sync",
          message: "Another bookmarks sync is already running",
        },
        applied: [],
        graveyarded: [],
        targets: [],
      });
      const cli = await writeFakeCli(dir, [busy, syncDone]);
      const proc = await startWatcher(dir, cli.path, {
        BOOKMARKS_DAEMON_BUSY_RETRY_DELAY_MS: "100",
      });
      try {
        await waitFor(async () => (await cli.syncs()) === 2);
        await waitFor(async () => {
          const runtimeState = await readRuntimeState(join(dir, "runtime", "daemon.state.json"));
          return runtimeState.phase === "idle" && runtimeState.lastOutcome === "noop";
        });
      } finally {
        await stopWatcher(proc);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("watcher waits while a browser kept the sync from writing, and syncs once it quits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-waiting-"));
    try {
      const waiting = JSON.stringify({
        orchestration: null,
        applied: [],
        graveyarded: [],
        targets: [],
        yamlChanged: true,
        waiting: [{ target: { browser: "safari" }, browser: "Safari", pending: 1 }],
      });
      const statePath = join(dir, "runtime", "daemon.state.json");

      const openCli = await writeFakeCli(join(dir), [waiting]);
      const open = await startWatcher(dir, openCli.path, {
        BOOKMARKS_DAEMON_BROWSER_EXIT_POLL_MS: "50",
        BOOKMARKS_FORCE_BROWSER_RUNNING: "Safari",
      });
      try {
        await waitFor(async () => (await readRuntimeState(statePath)).phase === "waiting");
        await Bun.sleep(300);
        expect(await openCli.syncs()).toBe(1);
        expect((await readRuntimeState(statePath)).phase).toBe("waiting");
      } finally {
        await stopWatcher(open);
      }

      const closedDir = join(dir, "closed");
      await mkdir(closedDir);
      const closedCli = await writeFakeCli(closedDir, [waiting, syncDone]);
      const closed = await startWatcher(closedDir, closedCli.path, {
        BOOKMARKS_DAEMON_BROWSER_EXIT_POLL_MS: "50",
        BOOKMARKS_DAEMON_SYNC_DELAY_MS: "60000",
        BOOKMARKS_FORCE_BROWSER_RUNNING: "",
      });
      try {
        await waitFor(async () => (await closedCli.syncs()) === 2);
        await waitFor(
          async () =>
            (await readRuntimeState(join(closedDir, "runtime", "daemon.state.json"))).phase ===
            "idle",
        );
      } finally {
        await stopWatcher(closed);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("watcher recovers from a transient CLI failure without another edit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-transient-error-"));
    try {
      const cli = await writeFakeCli(dir, ["fail:temporary Chrome bridge failure", syncDone]);
      const proc = await startWatcher(dir, cli.path, {
        BOOKMARKS_DAEMON_ERROR_RETRY_DELAY_MS: "100",
      });
      try {
        await waitFor(async () => (await cli.syncs()) === 2);
        await waitFor(async () => {
          const runtimeState = await readRuntimeState(join(dir, "runtime", "daemon.state.json"));
          return (
            runtimeState.phase === "idle" &&
            runtimeState.lastOutcome === "noop" &&
            runtimeState.lastError === undefined
          );
        });
      } finally {
        await stopWatcher(proc);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("watcher writes a stopped header and removes runtime state on shutdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-daemon-shutdown-"));
    try {
      const cli = await writeFakeCli(dir, [syncDone]);
      const proc = await startWatcher(dir, cli.path);
      try {
        await waitFor(async () => (await cli.syncs()) === 1);
        await waitFor(async () => {
          const header = await readDaemonHeaderState(join(dir, "bookmarks.yaml"));
          return header?.status === "running" && header.phase === "idle";
        });
      } finally {
        await stopWatcher(proc);
      }

      expect(await readDaemonHeaderState(join(dir, "bookmarks.yaml"))).toEqual({
        status: "stopped",
        phase: "stopped",
      });
      expect(await exists(join(dir, "runtime", "daemon.state.json"))).toBe(false);
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
