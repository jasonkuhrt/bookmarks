import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ChromeBridge from "./chrome-native-runtime.ts";
import * as Doctor from "./doctor.ts";
import {
  BookmarkTree,
  BookmarksConfig,
  ChromeBookmarks,
  ChromeProfileBookmarks,
  SafariBookmarks,
} from "./schema/__.ts";
import { copyChromeBookmarksFixture } from "./test-fixtures.ts";
import * as YamlModule from "./yaml.ts";

// -- Test helpers --

const unpairedRuntime: ChromeBridge.Runtime = {
  loadBindings: Effect.succeed([]),
  saveBindings: () => Effect.die("Unexpected binding write"),
  instances: Effect.die("Unexpected extension discovery"),
  request: () => Effect.die("Unexpected extension request"),
  launch: () => Effect.die("Unexpected browser launch"),
};

const run = <A, E>(effect: Effect.Effect<A, E>, runtime: ChromeBridge.Runtime = unpairedRuntime) =>
  Effect.runPromise(effect.pipe(Effect.provideService(ChromeBridge.ChromeBridgeRuntime, runtime)));

const withDoctorTargets = async (
  options: { readonly unpairedChrome?: boolean; readonly safari?: boolean },
  check: (yamlPath: string, chromePath: string) => Promise<void>,
) => {
  const dir = await mkdtemp(join(tmpdir(), "bookmarks-doctor-pairing-"));
  const chromeDataDir = join(dir, "Chrome");
  const chromePath = join(chromeDataDir, "Work", "Bookmarks");
  const environment = {
    BOOKMARKS_CHROME_DATA_DIR: chromeDataDir,
    BOOKMARKS_SAFARI_PLIST_PATH: join(dir, "Safari", "Bookmarks.plist"),
    BOOKMARKS_FORCE_BROWSER_RUNNING: "Google Chrome,Safari",
    BOOKMARKS_FORCE_FULL_DISK_ACCESS: "1",
  };
  const original = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );

  try {
    Object.assign(process.env, environment);
    const profiles = options.unpairedChrome ? ["Work", "Personal"] : ["Work"];
    await Promise.all(
      profiles.map(async (profile) => {
        await mkdir(join(chromeDataDir, profile), { recursive: true });
        await copyChromeBookmarksFixture(join(chromeDataDir, profile, "Bookmarks"));
      }),
    );
    if (options.safari) {
      await mkdir(join(dir, "Safari"));
      await Bun.write(environment.BOOKMARKS_SAFARI_PLIST_PATH, "fixture");
    }
    const yamlPath = join(dir, "bookmarks.yaml");
    await run(
      YamlModule.save(
        yamlPath,
        BookmarksConfig.make({
          all: BookmarkTree.make({}),
          chrome: ChromeBookmarks.make({
            profiles: Object.fromEntries(
              profiles.map((profile) => [profile.toLowerCase(), ChromeProfileBookmarks.make({})]),
            ),
          }),
          ...(options.safari ? { safari: SafariBookmarks.make({}) } : {}),
        }),
      ),
    );
    await check(yamlPath, chromePath);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
};

const pairedRuntime = (
  profilePath: string,
  response: Effect.Effect<unknown, Error>,
): ChromeBridge.Runtime => ({
  ...unpairedRuntime,
  loadBindings: Effect.succeed([
    { profilePath, instanceId: "12345678-1234-1234-1234-123456789abc" },
  ]),
  request: () => response,
});

const connected = Effect.succeed({ id: "cli", ok: true, value: BookmarkTree.make({}) });

// -- DoctorCheck / DoctorResult types --

describe("DoctorCheck", () => {
  test("has required shape with passing check", () => {
    const check: Doctor.DoctorCheck = {
      name: "test",
      passed: true,
      message: "all good",
    };
    expect(check.name).toBe("test");
    expect(check.passed).toBe(true);
    expect(check.message).toBe("all good");
    expect(check.fix).toBeUndefined();
  });

  test("has optional fix for failing check", () => {
    const check: Doctor.DoctorCheck = {
      name: "test",
      passed: false,
      message: "not good",
      fix: "do this",
    };
    expect(check.passed).toBe(false);
    expect(check.fix).toBe("do this");
  });
});

describe("DoctorResult", () => {
  test("allPassed is true when all checks pass", () => {
    const result: Doctor.DoctorResult = {
      checks: [
        { name: "a", passed: true, message: "ok" },
        { name: "b", passed: true, message: "ok" },
      ],
      allPassed: true,
    };
    expect(result.allPassed).toBe(true);
  });

  test("allPassed is false when any check fails", () => {
    const result: Doctor.DoctorResult = {
      checks: [
        { name: "a", passed: true, message: "ok" },
        { name: "b", passed: false, message: "fail", fix: "fix it" },
      ],
      allPassed: false,
    };
    expect(result.allPassed).toBe(false);
  });
});

// -- formatReport --

describe("formatReport", () => {
  test("uses checkmark for passing checks", () => {
    const result: Doctor.DoctorResult = {
      checks: [{ name: "Full Disk Access", passed: true, message: "granted" }],
      allPassed: true,
    };
    const report = Doctor.formatReport(result);
    expect(report).toContain("\u2713 Full Disk Access: granted");
    expect(report).toContain("All checks passed.");
  });

  test("uses cross for failing checks with fix", () => {
    const result: Doctor.DoctorResult = {
      checks: [
        {
          name: "Safari plist exists",
          passed: false,
          message: "not found",
          fix: "Launch Safari once.",
        },
      ],
      allPassed: false,
    };
    const report = Doctor.formatReport(result);
    expect(report).toContain("\u2717 Safari plist exists: not found");
    expect(report).toContain("Fix: Launch Safari once.");
    expect(report).toContain("Some checks failed.");
  });

  test("mixed pass/fail report", () => {
    const result: Doctor.DoctorResult = {
      checks: [
        { name: "A", passed: true, message: "ok" },
        { name: "B", passed: false, message: "bad", fix: "do X" },
        { name: "C", passed: true, message: "fine" },
      ],
      allPassed: false,
    };
    const report = Doctor.formatReport(result);
    expect(report).toContain("\u2713 A: ok");
    expect(report).toContain("\u2717 B: bad");
    expect(report).toContain("Fix: do X");
    expect(report).toContain("\u2713 C: fine");
  });

  test("failing check without fix omits Fix line", () => {
    const result: Doctor.DoctorResult = {
      checks: [{ name: "X", passed: false, message: "broken" }],
      allPassed: false,
    };
    const report = Doctor.formatReport(result);
    expect(report).toContain("\u2717 X: broken");
    expect(report).not.toContain("Fix:");
  });
});

// -- runDiagnostics --

describe("runDiagnostics", () => {
  test("a connected paired Chrome profile passes while Chrome is running", async () => {
    await withDoctorTargets({}, async (yamlPath, chromePath) => {
      const result = await run(
        Doctor.runDiagnostics(yamlPath),
        pairedRuntime(chromePath, connected),
      );

      expect(result.allPassed).toBe(true);
      expect(result.checks.find((check) => check.name === "Chrome pairing chrome/work")).toEqual({
        name: "Chrome pairing chrome/work",
        passed: true,
        message: "The paired Chrome extension is connected.",
      });
      expect(result.checks.some((check) => check.name === "Google Chrome not running")).toBe(false);
    });
  });

  test("an unavailable paired extension fails with its error instead of requiring Chrome to close", async () => {
    await withDoctorTargets({}, async (yamlPath, chromePath) => {
      const result = await run(
        Doctor.runDiagnostics(yamlPath),
        pairedRuntime(chromePath, Effect.fail(new Error("Extension is disconnected."))),
      );

      expect(result.allPassed).toBe(false);
      expect(result.checks.find((check) => check.name === "Chrome pairing chrome/work")).toEqual({
        name: "Chrome pairing chrome/work",
        passed: false,
        message: "Extension is disconnected.",
        fix: "Open the paired Chrome profile and enable Bookmarks CLI in chrome://extensions; pair the profile again if needed.",
      });
      expect(result.checks.some((check) => check.name === "Google Chrome not running")).toBe(false);
    });
  });

  test("a paired Chrome profile does not exempt an unpaired profile from closing Chrome", async () => {
    await withDoctorTargets({ unpairedChrome: true }, async (yamlPath, chromePath) => {
      const result = await run(
        Doctor.runDiagnostics(yamlPath),
        pairedRuntime(chromePath, connected),
      );

      expect(result.allPassed).toBe(false);
      expect(
        result.checks.find((check) => check.name === "Chrome pairing chrome/work")?.passed,
      ).toBe(true);
      expect(result.checks.find((check) => check.name === "Google Chrome not running")).toEqual({
        name: "Google Chrome not running",
        passed: false,
        message: "Google Chrome is currently running",
        fix: "Close Google Chrome before syncing to avoid data corruption.",
      });
    });
  });

  test("Safari still must close when Chrome is paired", async () => {
    await withDoctorTargets({ safari: true }, async (yamlPath, chromePath) => {
      const result = await run(
        Doctor.runDiagnostics(yamlPath),
        pairedRuntime(chromePath, connected),
      );

      expect(result.allPassed).toBe(false);
      expect(result.checks.find((check) => check.name === "Safari not running")).toEqual({
        name: "Safari not running",
        passed: false,
        message: "Safari is currently running",
        fix: "Close Safari before syncing to avoid data corruption.",
      });
    });
  });

  test("unreadable Chrome pairing configuration fails without aborting the other checks", async () => {
    await withDoctorTargets({ safari: true }, async (yamlPath) => {
      const result = await run(Doctor.runDiagnostics(yamlPath), {
        ...unpairedRuntime,
        loadBindings: Effect.fail(new Error("Pairing configuration is unreadable.")),
      });

      expect(result.allPassed).toBe(false);
      expect(result.checks.find((check) => check.name === "Chrome pairings")).toEqual({
        name: "Chrome pairings",
        passed: false,
        message: "Pairing configuration is unreadable.",
        fix: "Check the Chrome pairing configuration, then pair the profile again.",
      });
      expect(result.checks.find((check) => check.name === "Safari not running")?.passed).toBe(
        false,
      );
    });
  });

  test("reports the actual configured targets and browser processes", async () => {
    await withDoctorTargets({}, async (yamlPath) => {
      const result = await run(Doctor.runDiagnostics(yamlPath));
      const names = result.checks.map((check) => check.name);

      expect(typeof result.allPassed).toBe("boolean");
      expect(names).toContain("YAML source of truth");
      expect(names).toContain("Configured Chrome profiles");
      expect(names).toContain("Enabled targets");
      expect(names).toContain("Discovered target chrome/work exists");
      expect(names).toContain("Google Chrome not running");
    });
  });

  test("surfaces YAML errors without inventing target checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-doctor-invalid-"));
    const yamlPath = join(dir, "bookmarks.yaml");

    try {
      await Bun.write(yamlPath, "targets:\n  chrome:\n    default: [");

      const result = await run(Doctor.runDiagnostics(yamlPath));

      expect(result.allPassed).toBe(false);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]?.name).toBe("YAML source of truth");
      expect(result.checks[0]?.passed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("each check has required fields", async () => {
    await withDoctorTargets({}, async (yamlPath) => {
      const result = await run(Doctor.runDiagnostics(yamlPath));
      for (const check of result.checks) {
        expect(typeof check.name).toBe("string");
        expect(typeof check.passed).toBe("boolean");
        expect(typeof check.message).toBe("string");
        if (check.fix !== undefined) {
          expect(typeof check.fix).toBe("string");
        }
      }
    });
  });
});
