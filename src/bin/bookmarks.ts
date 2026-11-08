#!/usr/bin/env bun
/**
 * bookmarks - Cross-browser bookmark sync from YAML
 *
 * Usage:
 *   bookmarks <command> [options]
 *
 * Commands:
 *   sync        browsers <-> YAML fast path
 *   status      show current state
 *   backup      timestamped backups
 *   gc          clean graveyard
 *   daemon      launchd watcher lifecycle
 *   validate    validate bookmarks.yaml
 */

import {
  Cause,
  Console,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  LogLevel,
  Logger,
  Option,
} from "effect";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BookmarkPatch } from "../lib/patch.ts";

/** Expected CLI exits where the user has already been informed. */
class CliExitError extends Data.TaggedError("CliExitError")<{}> {
  static is = (u: unknown): u is CliExitError =>
    u !== null && typeof u === "object" && "_tag" in u && u._tag === "CliExitError";
}
import * as Daemon from "../lib/daemon.ts";
import * as ChromeNative from "../lib/chrome-native.ts";
import * as ChromeNativeSetup from "../lib/chrome-native-setup.ts";
import * as Doctor from "../lib/doctor.ts";
import { writeManagedConfigHeader } from "../lib/managed-config-header.ts";
import * as ManagedPaths from "../lib/managed-paths.ts";
import * as Paths from "../lib/paths.ts";
import { BookmarksConfig, BookmarkTree } from "../lib/schema/__.ts";
import * as SyncModule from "../lib/sync.ts";
import * as Targets from "../lib/targets.ts";
import { UnsupportedBookmarks } from "../lib/unsupported.ts";
import * as YamlModule from "../lib/yaml.ts";

const JSON_OUTPUT = process.argv.includes("--json");
const REPO_SCHEMA_PATH = join(import.meta.dir, "..", "lib", "bookmarks.schema.json");
const unknownMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${String(value)}`);
};

const USAGE = `
bookmarks - Cross-browser bookmark sync from YAML

Usage:
  bookmarks <command> [options]

Commands:
  bookmarks sync [target...] [--from-yaml] [--dry-run] [--json]
                                                merge, or restore browser from YAML
  bookmarks status [target...] [--json]  show current state
  bookmarks backup [--json]              timestamped backups
  bookmarks gc [--max-age=90d] [--json]  clean graveyard
  bookmarks daemon start|stop|status     launchd watcher lifecycle
  bookmarks doctor [--json]              pre-flight diagnostics
  bookmarks chrome install              install the Chrome connector
  bookmarks chrome pair <target>        pair the loaded extension to a profile
  bookmarks chrome status [--json]      inspect Chrome connections
  bookmarks validate [--json]            validate bookmarks.yaml
`.trim();

interface CliFlags {
  dryRun: boolean;
  fromYaml: boolean;
  json: boolean;
  maxAge: string;
}

const parseArgs = (args: string[]) => {
  const flags: CliFlags = {
    dryRun: false,
    fromYaml: false,
    json: false,
    maxAge: "90d",
  };
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--from-yaml") flags.fromYaml = true;
    else if (arg === "--json") flags.json = true;
    else if (arg.startsWith("--max-age=")) flags.maxAge = arg.slice(10);
    else if (arg === "--max-age" && i + 1 < args.length) {
      const maxAge = args[++i];
      if (maxAge !== undefined) flags.maxAge = maxAge;
    } else positional.push(arg);
  }

  return { flags, positional };
};

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const pathExists = (path: string): Effect.Effect<boolean, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    catch: (e) => new Error(`Failed to inspect ${path}: ${unknownMessage(e)}`),
  });

const emitCliError = (message: string, json: boolean): Effect.Effect<never, CliExitError> =>
  Effect.gen(function* () {
    if (json) {
      yield* printJson({ error: message });
    } else {
      yield* Console.error(message);
    }
    return yield* Effect.fail(new CliExitError());
  });

const resolveManagedSchemaPath = (yamlPath: string): string =>
  process.env["BOOKMARKS_SCHEMA_PATH"] ?? join(dirname(yamlPath), "bookmarks.schema.json");

const ensureManagedFiles = (
  yamlPath: string,
): Effect.Effect<{ readonly yamlPath: string; readonly schemaPath: string }, Error> =>
  Effect.gen(function* () {
    const schemaPath = resolveManagedSchemaPath(yamlPath);

    yield* ManagedPaths.ensureParentDir(yamlPath);
    yield* ManagedPaths.ensureParentDir(schemaPath);

    const schema = yield* Effect.tryPromise({
      try: () => readFile(REPO_SCHEMA_PATH, "utf-8"),
      catch: (e) =>
        new Error(`Failed to read repo schema at ${REPO_SCHEMA_PATH}: ${unknownMessage(e)}`),
    });
    const existingSchema = yield* Effect.tryPromise({
      try: async () => readFile(schemaPath, "utf-8").catch(() => undefined),
      catch: (e) =>
        new Error(`Failed to inspect managed schema at ${schemaPath}: ${unknownMessage(e)}`),
    });

    if (existingSchema !== schema) {
      yield* Effect.tryPromise({
        try: () => writeFile(schemaPath, schema, "utf-8"),
        catch: (e) =>
          new Error(`Failed to write managed schema to ${schemaPath}: ${unknownMessage(e)}`),
      });
    }

    return { yamlPath, schemaPath };
  });

const ensureManagedYamlFile = (yamlPath: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (yield* pathExists(yamlPath)) return;
    yield* YamlModule.save(
      yamlPath,
      BookmarksConfig.make({
        all: BookmarkTree.make({}),
      }),
    );
  });

const parseMaxAge = (
  input: string,
  json: boolean,
): Effect.Effect<Duration.Duration, CliExitError> =>
  Effect.gen(function* () {
    const match = /^(\d+)([mhd])$/.exec(input);
    if (!match) {
      return yield* emitCliError(
        "Invalid --max-age value. Use formats like 30d, 12h, or 45m.",
        json,
      );
    }

    const amount = Number(match[1]);
    const unit = match[2];
    if (unit === "m") return Duration.minutes(amount);
    if (unit === "h") return Duration.hours(amount);
    if (unit === "d") return Duration.days(amount);
    return yield* emitCliError("Invalid --max-age unit. Use m, h, or d.", json);
  });

const serializePatch = (patch: BookmarkPatch) => {
  switch (patch._tag) {
    case "Add":
      return {
        tag: patch._tag,
        url: patch.url,
        name: patch.name,
        path: patch.path,
        date: patch.date.toJSON(),
      };
    case "Remove":
      return {
        tag: patch._tag,
        url: patch.url,
        name: patch.name,
        path: patch.path,
        date: patch.date.toJSON(),
      };
    case "Update":
      return {
        tag: patch._tag,
        url: patch.url,
        oldName: patch.oldName,
        newName: patch.newName,
        fromPath: patch.fromPath,
        toPath: patch.toPath,
        date: patch.date.toJSON(),
      };
    default:
      return assertNever(patch);
  }
};

const formatPatch = (patch: BookmarkPatch): string => {
  switch (patch._tag) {
    case "Add":
      return `+ Add "${patch.name}" -> ${patch.path} (${patch.url})`;
    case "Remove":
      return `- Remove "${patch.name}" from ${patch.path} (${patch.url})`;
    case "Update":
      if (patch.fromPath === patch.toPath) {
        return `~ Rename "${patch.oldName}" -> "${patch.newName}" at ${patch.fromPath} (${patch.url})`;
      }
      if (patch.oldName === patch.newName) {
        return `> Move "${patch.oldName}" ${patch.fromPath} -> ${patch.toPath} (${patch.url})`;
      }
      return `~ Update "${patch.oldName}" at ${patch.fromPath} -> "${patch.newName}" at ${patch.toPath} (${patch.url})`;
    default:
      return assertNever(patch);
  }
};

const printPatchPreview = (label: string, patches: readonly BookmarkPatch[]) =>
  Effect.gen(function* () {
    if (patches.length === 0) return;
    yield* Console.log(`    ${label}:`);
    for (const patch of patches) {
      yield* Console.log(`      ${formatPatch(patch)}`);
    }
  });

const printDryRunPreview = (status: SyncModule.StatusResult) =>
  Effect.gen(function* () {
    if (status.targets.length === 0) return;

    yield* Console.log("  dry-run preview:");

    for (const targetStatus of status.targets) {
      const showBrowser = targetStatus.yamlPatches.length > 0;
      const showYaml = targetStatus.browserPatches.length > 0;

      if (!showBrowser && !showYaml) continue;

      yield* Console.log(`  ${Targets.displayNameOf(targetStatus.target)}`);
      if (showBrowser) {
        yield* Console.log(`    to browser: ${targetStatus.yamlPatches.length}`);
        yield* printPatchPreview("to browser", targetStatus.yamlPatches);
      }
      if (showYaml) {
        yield* Console.log(`    to yaml:    ${targetStatus.browserPatches.length}`);
        yield* printPatchPreview("to yaml", targetStatus.browserPatches);
      }
    }
  });

const serializeSyncResult = (
  command: string,
  yamlPath: string,
  dryRun: boolean,
  result: SyncModule.SyncResult,
) => ({
  command,
  yamlPath,
  dryRun,
  orchestration: result.orchestration ?? null,
  backup: result.backup ?? null,
  applied: result.applied.map(serializePatch),
  graveyarded: result.graveyarded.map(serializePatch),
  targets: result.targets.map((targetResult) => ({
    target: targetResult.target,
    writeMode: targetResult.writeMode ?? "patches",
    applied: targetResult.applied.map(serializePatch),
    graveyarded: targetResult.graveyarded.map(serializePatch),
  })),
});

const serializeStatus = (status: SyncModule.StatusResult) => ({
  yamlPath: status.yamlPath,
  targets: status.targets.map((targetStatus) => ({
    target: targetStatus.target,
    duplicates: {
      yaml: targetStatus.yamlDuplicates,
      browser: targetStatus.browserDuplicates,
    },
    pendingToBrowser: targetStatus.yamlPatches.map(serializePatch),
    pendingToYaml: targetStatus.browserPatches.map(serializePatch),
  })),
});

const serializeDaemonStatus = (status: Daemon.DaemonStatus) => ({
  phase: status.phase,
  pid: status.pid ?? null,
  startedAt: Option.isSome(status.startedAt) ? status.startedAt.value.toJSON() : null,
  lastEventAt: Option.isSome(status.lastEventAt) ? status.lastEventAt.value.toJSON() : null,
  lastSyncAt: Option.isSome(status.lastSyncAt) ? status.lastSyncAt.value.toJSON() : null,
  lastOutcome: status.lastOutcome ?? null,
  lastError: status.lastError ?? null,
  running: status.running,
  nextSyncAt: Option.isSome(status.nextSyncAt) ? status.nextSyncAt.value.toJSON() : null,
  plistPath: status.plistPath,
  statePath: status.statePath,
  yamlPath: status.yamlPath,
});

const printSyncSummary = (
  label: string,
  result: SyncModule.SyncResult,
  options?: { readonly showDetails?: boolean },
) =>
  Effect.gen(function* () {
    if (result.orchestration) {
      yield* Console.log(`\n${label} deferred: ${result.orchestration.message}`);
      return;
    }

    yield* Console.log(
      `\n${label} complete: ${result.applied.length} applied, ${result.graveyarded.length} graveyarded`,
    );
    if (result.backup) {
      yield* Console.log(`  backup: ${result.backup.backupDir}`);
      for (const file of result.backup.files) {
        yield* Console.log(`    wrote ${file}`);
      }
      for (const skipped of result.backup.skipped) {
        yield* Console.log(`    skipped ${skipped}`);
      }
    }
    for (const targetResult of result.targets) {
      yield* Console.log(
        `  ${Targets.displayNameOf(targetResult.target)}: ` +
          `${targetResult.applied.length} applied, ${targetResult.graveyarded.length} graveyarded` +
          (targetResult.writeMode === "rewrite" ? ", exact structural rewrite" : ""),
      );
      if (options?.showDetails) {
        yield* printPatchPreview("apply", targetResult.applied);
        yield* printPatchPreview("graveyard", targetResult.graveyarded);
      }
    }
  });

const printStatus = (status: SyncModule.StatusResult) =>
  Effect.gen(function* () {
    yield* Console.log(`YAML: ${status.yamlPath}`);
    if (status.targets.length === 0) {
      yield* Console.log("No enabled targets configured.");
      return;
    }

    for (const targetStatus of status.targets) {
      yield* Console.log(Targets.displayNameOf(targetStatus.target));
      yield* Console.log(`  path: ${targetStatus.target.path}`);
      if (
        targetStatus.yamlDuplicates.extraPlacements > 0 ||
        targetStatus.browserDuplicates.extraPlacements > 0
      ) {
        yield* Console.log(
          `  duplicate placements (preserved): yaml ${targetStatus.yamlDuplicates.extraPlacements} across ${targetStatus.yamlDuplicates.urlGroups} URLs; browser ${targetStatus.browserDuplicates.extraPlacements} across ${targetStatus.browserDuplicates.urlGroups} URLs`,
        );
      }
      yield* Console.log(`  pending -> browser: ${targetStatus.yamlPatches.length}`);
      yield* printPatchPreview("to browser", targetStatus.yamlPatches);
      yield* Console.log(`  pending -> yaml:    ${targetStatus.browserPatches.length}`);
      yield* printPatchPreview("to yaml", targetStatus.browserPatches);
    }
  });

const printBackupSummary = (result: SyncModule.BackupResult) =>
  Effect.gen(function* () {
    yield* Console.log(`Backups written to ${result.backupDir}`);
    for (const file of result.files) {
      yield* Console.log(`  wrote ${file}`);
    }
    for (const skipped of result.skipped) {
      yield* Console.log(`  skipped ${skipped}`);
    }
  });

const program = Effect.gen(function* () {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    yield* Console.log(USAGE);
    return;
  }

  const { flags, positional } = parseArgs(args);

  switch (command) {
    case "chrome": {
      const [action, selector] = positional;
      if (action === "install") {
        const result = yield* ChromeNativeSetup.installChromeNativeIntegration().pipe(
          Effect.provide(ChromeNativeSetup.ChromeNativeSetupRuntimeLive),
        );
        if (flags.json) yield* printJson(result);
        else {
          yield* Console.log(
            `Chrome connector installed.\nLoad unpacked in chrome://extensions:\n  ${result.extensionDirectory}\nThen run bookmarks chrome pair chrome/<profile>.`,
          );
        }
      } else if (action === "pair") {
        if (!selector)
          return yield* emitCliError("Usage: bookmarks chrome pair chrome/<profile>", flags.json);
        const available = yield* Targets.discoverChromeTargets();
        const selected = yield* Targets.resolveTargetSelectors(available, [selector]);
        if (selected.length !== 1 || !selected[0])
          return yield* emitCliError("Select exactly one Chrome profile to pair.", flags.json);
        const result = yield* ChromeNative.pair(selected[0].path);
        if (flags.json) yield* printJson(result);
        else
          yield* Console.log(
            `Paired ${selector}. bookmarks sync now uses Chrome's live bookmark API.`,
          );
      } else if (action === "status") {
        const result = yield* ChromeNative.status;
        if (flags.json) yield* printJson(result);
        else if (result.length === 0)
          yield* Console.log("No Chrome profile paired. Run bookmarks chrome install.");
        else
          for (const binding of result)
            yield* Console.log(
              `${binding.profilePath}: ${binding.connected ? "connected" : binding.error}`,
            );
      } else
        return yield* emitCliError(
          "Usage: bookmarks chrome install|pair <target>|status",
          flags.json,
        );
      break;
    }
    case "sync": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath());
      const preview =
        flags.dryRun && !flags.fromYaml
          ? yield* SyncModule.status({ yamlPath: managed.yamlPath, requestedTargets: positional })
          : undefined;
      const syncConfig = {
        yamlPath: managed.yamlPath,
        dryRun: flags.dryRun,
        requestedTargets: positional,
      };
      const syncResult = yield* flags.fromYaml
        ? SyncModule.push(syncConfig)
        : SyncModule.sync(syncConfig);
      if (flags.json) {
        yield* printJson({
          ...serializeSyncResult("sync", managed.yamlPath, flags.dryRun, syncResult),
          mode: flags.fromYaml ? "from-yaml" : "merge",
          preview: preview ? serializeStatus(preview) : null,
        });
      } else {
        yield* printSyncSummary(flags.fromYaml ? "Sync from YAML" : "Sync", syncResult, {
          showDetails: flags.fromYaml && flags.dryRun,
        });
        if (preview) yield* printDryRunPreview(preview);
      }
      break;
    }
    case "status": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath());
      const status = yield* SyncModule.status({
        yamlPath: managed.yamlPath,
        requestedTargets: positional,
      });
      if (flags.json) {
        yield* printJson(serializeStatus(status));
      } else {
        yield* printStatus(status);
      }
      break;
    }
    case "backup": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath());
      const backup = yield* SyncModule.backup({
        yamlPath: managed.yamlPath,
        backupDir: Paths.defaultBackupDir(),
      });
      if (flags.json) {
        yield* printJson(backup);
      } else {
        yield* printBackupSummary(backup);
      }
      break;
    }
    case "gc": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath());
      const maxAge = yield* parseMaxAge(flags.maxAge, flags.json);
      const gcResult = yield* SyncModule.gc({
        yamlPath: managed.yamlPath,
        graveyardMaxAge: maxAge,
        requestedTargets: positional,
      });
      if (flags.json) {
        yield* printJson(serializeSyncResult("gc", managed.yamlPath, false, gcResult));
      } else {
        yield* printSyncSummary("GC", gcResult);
      }
      break;
    }
    case "daemon": {
      const subcommand = positional[0];
      if (!subcommand || !["start", "stop", "status"].includes(subcommand)) {
        return yield* emitCliError("Usage: bookmarks daemon start|stop|status", flags.json);
      }
      switch (subcommand) {
        case "start": {
          const managed = yield* ensureManagedFiles(Paths.defaultYamlPath());
          yield* ensureManagedYamlFile(managed.yamlPath);
          const config = yield* Daemon.defaultConfig();
          yield* Daemon.start(config);
          yield* Effect.tryPromise({
            try: () =>
              writeManagedConfigHeader(managed.yamlPath, {
                status: "running",
                phase: "starting",
              }),
            catch: (e) =>
              new Error(
                `Failed to update daemon header in ${managed.yamlPath}: ${unknownMessage(e)}`,
              ),
          });
          if (flags.json) {
            yield* printJson({
              phase: "starting",
              running: true,
              plistPath: "~/Library/LaunchAgents/com.jasonkuhrt.bookmarks-sync.plist",
            });
          } else {
            yield* Console.log(
              "Daemon started. Sync queues 60 seconds after the last bookmarks.yaml edit.",
            );
          }
          break;
        }
        case "stop": {
          const yamlPath = Paths.defaultYamlPath();
          yield* Daemon.stop();
          yield* Effect.tryPromise({
            try: () =>
              writeManagedConfigHeader(yamlPath, {
                status: "stopped",
                phase: "stopped",
              }),
            catch: (e) =>
              new Error(`Failed to update daemon header in ${yamlPath}: ${unknownMessage(e)}`),
          }).pipe(Effect.catchAll(() => Effect.void));
          if (flags.json) {
            yield* printJson({ running: false });
          } else {
            yield* Console.log("Daemon stopped.");
          }
          break;
        }
        case "status": {
          const st = yield* Daemon.status();
          yield* Effect.tryPromise({
            try: () =>
              writeManagedConfigHeader(st.yamlPath, Daemon.daemonHeaderStateFromStatus(st)),
            catch: (e) =>
              new Error(`Failed to update daemon header in ${st.yamlPath}: ${unknownMessage(e)}`),
          }).pipe(Effect.catchAll(() => Effect.void));
          if (flags.json) {
            yield* printJson(serializeDaemonStatus(st));
          } else {
            const formatOptDate = (opt: Option.Option<DateTime.Utc>): string =>
              Option.isSome(opt) ? DateTime.formatIso(opt.value) : "unknown";
            yield* Console.log(`Daemon status:`);
            yield* Console.log(`  Running:    ${st.running ? "yes" : "no"}`);
            yield* Console.log(`  Phase:      ${st.phase}`);
            yield* Console.log(`  PID:        ${st.pid ?? "unknown"}`);
            yield* Console.log(`  Started:    ${formatOptDate(st.startedAt)}`);
            yield* Console.log(`  Last edit:  ${formatOptDate(st.lastEventAt)}`);
            yield* Console.log(`  Last sync:  ${formatOptDate(st.lastSyncAt)}`);
            yield* Console.log(`  Next sync:  ${formatOptDate(st.nextSyncAt)}`);
            yield* Console.log(`  Outcome:    ${st.lastOutcome ?? "unknown"}`);
            yield* Console.log(`  YAML:       ${st.yamlPath}`);
            yield* Console.log(`  State:      ${st.statePath}`);
            yield* Console.log(`  Plist:      ${st.plistPath}`);
            if (st.lastError) {
              yield* Console.log(`  Last error: ${st.lastError}`);
            }
          }
          break;
        }
      }
      break;
    }
    case "doctor": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath());
      const doctorResult = yield* Doctor.runDiagnostics(managed.yamlPath);
      if (flags.json) {
        yield* printJson(doctorResult);
      } else {
        yield* Console.log(Doctor.formatReport(doctorResult));
      }
      if (!doctorResult.allPassed) {
        return yield* Effect.fail(new CliExitError());
      }
      break;
    }
    case "validate": {
      const yamlPath = Paths.defaultYamlPath();
      if (!(yield* pathExists(yamlPath))) {
        return yield* emitCliError(`No bookmarks.yaml found at ${yamlPath}.`, flags.json);
      }

      const managed = yield* ensureManagedFiles(yamlPath);
      yield* YamlModule.load(managed.yamlPath).pipe(
        Effect.flatMap(() =>
          flags.json
            ? printJson({ path: managed.yamlPath, valid: true })
            : Console.log("bookmarks.yaml is valid"),
        ),
        Effect.catchAll((e) =>
          Effect.gen(function* () {
            if (flags.json) {
              yield* printJson({
                path: managed.yamlPath,
                valid: false,
                error: e.message,
              });
            } else {
              yield* Console.error(e.message);
            }
            return yield* Effect.fail(new CliExitError());
          }),
        ),
      );
      break;
    }
    default:
      if (flags.json) {
        return yield* emitCliError(`Unknown command: ${command}`, true);
      }
      yield* Console.error(`Unknown command: ${command}`);
      yield* Console.log(USAGE);
      return yield* Effect.fail(new CliExitError());
  }
});

const runtimeProgram = JSON_OUTPUT
  ? program.pipe(Logger.withMinimumLogLevel(LogLevel.None))
  : program;

const exit = await Effect.runPromiseExit(runtimeProgram);

if (Exit.isFailure(exit)) {
  const err = Cause.squash(exit.cause);
  if (UnsupportedBookmarks.is(err)) {
    if (JSON_OUTPUT) {
      console.error(JSON.stringify({ error: err.message, type: err._tag }, null, 2));
    } else {
      console.error(err.message);
    }
  } else if (!CliExitError.is(err)) {
    if (JSON_OUTPUT) {
      console.error(
        JSON.stringify(
          {
            error: err instanceof Error ? err.message : String(err),
          },
          null,
          2,
        ),
      );
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
  }
  process.exit(1);
}
