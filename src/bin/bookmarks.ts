#!/usr/bin/env bun
/**
 * bookmarks - Cross-browser bookmark sync from YAML
 *
 * Usage:
 *   bookmarks <command> [options]
 *
 * Commands:
 *   push        YAML -> browsers
 *   pull        browsers -> YAML
 *   sync        bidirectional (pull then push)
 *   status      show current state
 *   backup      timestamped backups
 *   gc          clean graveyard
 *   daemon      launchd lifecycle
 *   validate    schema check only
 */

import { Cause, Console, Data, DateTime, Duration, Effect, Exit, LogLevel, Logger, Option } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { BookmarkPatch } from "../lib/patch.js"

/** Expected CLI exits where the user has already been informed. */
class CliExitError extends Data.TaggedError("CliExitError")<{}> {
  static is = (u: unknown): u is CliExitError =>
    u != null && typeof u === "object" && "_tag" in u && u._tag === "CliExitError"
}
import * as Daemon from "../lib/daemon.js"
import * as Doctor from "../lib/doctor.js"
import * as Paths from "../lib/paths.js"
import * as SyncModule from "../lib/sync.js"
import { UnsupportedBookmarks } from "../lib/unsupported.js"
import * as YamlModule from "../lib/yaml.js"

const JSON_OUTPUT = process.argv.includes("--json")
const REPO_SCHEMA_PATH = join(import.meta.dir, "..", "lib", "bookmarks.schema.json")

const USAGE = `
bookmarks - Cross-browser bookmark sync from YAML

Usage:
  bookmarks <command> [options]

Commands:
  bookmarks push [--dry-run] [--json]    YAML -> browsers
  bookmarks pull [--dry-run] [--json]    browsers -> YAML
  bookmarks sync [--dry-run] [--json]    bidirectional (pull then push)
  bookmarks status [--json]              show current state
  bookmarks backup [--json]              timestamped backups
  bookmarks gc [--max-age=90d] [--json]  clean graveyard
  bookmarks daemon start|stop|status     launchd lifecycle
  bookmarks doctor [--json]              pre-flight diagnostics
  bookmarks validate [--json]            schema check only
`.trim()

interface CliFlags {
  dryRun: boolean
  json: boolean
  maxAge: string
}

const parseArgs = (args: string[]) => {
  const flags: CliFlags = {
    dryRun: false,
    json: false,
    maxAge: "90d",
  }
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--dry-run") flags.dryRun = true
    else if (arg === "--json") flags.json = true
    else if (arg.startsWith("--max-age=")) flags.maxAge = arg.slice(10)
    else if (arg === "--max-age" && i + 1 < args.length) {
      flags.maxAge = args[++i]!
    } else positional.push(arg)
  }

  return { flags, positional }
}

const printJson = (value: unknown) =>
  Console.log(JSON.stringify(value, null, 2))

const emitCliError = (message: string, json: boolean): Effect.Effect<never, CliExitError> =>
  Effect.gen(function* () {
    if (json) {
      yield* printJson({ error: message })
    } else {
      yield* Console.error(message)
    }
    return yield* Effect.fail(new CliExitError())
  })

const resolveManagedSchemaPath = (yamlPath: string): string =>
  process.env["BOOKMARKS_SCHEMA_PATH"] ?? join(dirname(yamlPath), "bookmarks.schema.json")

const ensureManagedFiles = (yamlPath: string): Effect.Effect<{ readonly yamlPath: string; readonly schemaPath: string }, Error> =>
  Effect.gen(function* () {
    const schemaPath = resolveManagedSchemaPath(yamlPath)

    yield* Effect.tryPromise({
      try: () => mkdir(dirname(yamlPath), { recursive: true }),
      catch: (e) => new Error(`Failed to create config directory for ${yamlPath}: ${e}`),
    })
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(schemaPath), { recursive: true }),
      catch: (e) => new Error(`Failed to create schema directory for ${schemaPath}: ${e}`),
    })

    const schema = yield* Effect.tryPromise({
      try: () => readFile(REPO_SCHEMA_PATH, "utf-8"),
      catch: (e) => new Error(`Failed to read repo schema at ${REPO_SCHEMA_PATH}: ${e}`),
    })
    const existingSchema = yield* Effect.tryPromise({
      try: async () => readFile(schemaPath, "utf-8").catch(() => undefined),
      catch: (e) => new Error(`Failed to inspect managed schema at ${schemaPath}: ${e}`),
    })

    if (existingSchema !== schema) {
      yield* Effect.tryPromise({
        try: () => writeFile(schemaPath, schema, "utf-8"),
        catch: (e) => new Error(`Failed to write managed schema to ${schemaPath}: ${e}`),
      })
    }

    return { yamlPath, schemaPath }
  })

const parseMaxAge = (input: string, json: boolean): Effect.Effect<Duration.Duration, CliExitError> =>
  Effect.gen(function* () {
    const match = /^(\d+)([mhd])$/.exec(input)
    if (!match) {
      return yield* emitCliError("Invalid --max-age value. Use formats like 30d, 12h, or 45m.", json)
    }

    const amount = Number(match[1])
    const unit = match[2]
    switch (unit) {
      case "m":
        return Duration.minutes(amount)
      case "h":
        return Duration.hours(amount)
      case "d":
        return Duration.days(amount)
      default:
        return yield* emitCliError("Invalid --max-age unit. Use m, h, or d.", json)
    }
  })

const serializePatch = (patch: BookmarkPatch) => {
  switch (patch._tag) {
    case "Add":
      return { tag: patch._tag, url: patch.url, name: patch.name, path: patch.path, date: patch.date.toJSON() }
    case "Remove":
      return { tag: patch._tag, url: patch.url, path: patch.path, date: patch.date.toJSON() }
    case "Rename":
      return {
        tag: patch._tag,
        url: patch.url,
        oldName: patch.oldName,
        newName: patch.newName,
        date: patch.date.toJSON(),
      }
    case "Move":
      return {
        tag: patch._tag,
        url: patch.url,
        fromPath: patch.fromPath,
        toPath: patch.toPath,
        date: patch.date.toJSON(),
      }
  }
}

const formatPatch = (patch: BookmarkPatch): string => {
  switch (patch._tag) {
    case "Add":
      return `+ Add "${patch.name}" -> ${patch.path} (${patch.url})`
    case "Remove":
      return `- Remove ${patch.url} from ${patch.path}`
    case "Rename":
      return `~ Rename ${patch.url} "${patch.oldName}" -> "${patch.newName}"`
    case "Move":
      return `> Move ${patch.url} ${patch.fromPath} -> ${patch.toPath}`
  }
}

const printPatchPreview = (label: string, patches: readonly BookmarkPatch[]) =>
  Effect.gen(function* () {
    if (patches.length === 0) return
    yield* Console.log(`    ${label}:`)
    for (const patch of patches) {
      yield* Console.log(`      ${formatPatch(patch)}`)
    }
  })

const printDryRunPreview = (
  command: "push" | "pull" | "sync",
  status: SyncModule.StatusResult,
) =>
  Effect.gen(function* () {
    if (status.targets.length === 0) return

    yield* Console.log("  dry-run preview:")

    for (const targetStatus of status.targets) {
      const showBrowser = command !== "pull" && targetStatus.yamlPatches.length > 0
      const showYaml = command !== "push" && targetStatus.browserPatches.length > 0

      if (!showBrowser && !showYaml) continue

      yield* Console.log(`  ${targetStatus.target.browser}/${targetStatus.target.profile}`)
      if (showBrowser) {
        yield* Console.log(`    to browser: ${targetStatus.yamlPatches.length}`)
        yield* printPatchPreview("to browser", targetStatus.yamlPatches)
      }
      if (showYaml) {
        yield* Console.log(`    to yaml:    ${targetStatus.browserPatches.length}`)
        yield* printPatchPreview("to yaml", targetStatus.browserPatches)
      }
    }
  })

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
  applied: result.applied.map(serializePatch),
  graveyarded: result.graveyarded.map(serializePatch),
  targets: result.targets.map((targetResult) => ({
    target: targetResult.target,
    applied: targetResult.applied.map(serializePatch),
    graveyarded: targetResult.graveyarded.map(serializePatch),
  })),
})

const serializeStatus = (status: SyncModule.StatusResult) => ({
  yamlPath: status.yamlPath,
  targets: status.targets.map((targetStatus) => ({
    target: targetStatus.target,
    pendingToBrowser: targetStatus.yamlPatches.map(serializePatch),
    pendingToYaml: targetStatus.browserPatches.map(serializePatch),
  })),
})

const serializeDaemonStatus = (status: Daemon.DaemonStatus) => ({
  running: status.running,
  lastRun: Option.isSome(status.lastRun) ? status.lastRun.value.toJSON() : null,
  nextRun: Option.isSome(status.nextRun) ? status.nextRun.value.toJSON() : null,
  plistPath: status.plistPath,
})

const printSyncSummary = (
  label: string,
  result: SyncModule.SyncResult,
  options?: { readonly showDetails?: boolean },
) =>
  Effect.gen(function* () {
    if (result.orchestration) {
      const verb = result.orchestration.state === "queued" ? "queued" : "deferred"
      yield* Console.log(`\n${label} ${verb}: ${result.orchestration.message}`)
      return
    }

    yield* Console.log(`\n${label} complete: ${result.applied.length} applied, ${result.graveyarded.length} graveyarded`)
    for (const targetResult of result.targets) {
      yield* Console.log(
        `  ${targetResult.target.browser}/${targetResult.target.profile}: ` +
          `${targetResult.applied.length} applied, ${targetResult.graveyarded.length} graveyarded`,
      )
      if (options?.showDetails) {
        yield* printPatchPreview("apply", targetResult.applied)
        yield* printPatchPreview("graveyard", targetResult.graveyarded)
      }
    }
  })

const printStatus = (status: SyncModule.StatusResult) =>
  Effect.gen(function* () {
    yield* Console.log(`YAML: ${status.yamlPath}`)
    if (status.targets.length === 0) {
      yield* Console.log("No enabled targets configured.")
      return
    }

    for (const targetStatus of status.targets) {
      yield* Console.log(`${targetStatus.target.browser}/${targetStatus.target.profile}`)
      yield* Console.log(`  path: ${targetStatus.target.path}`)
      yield* Console.log(`  pending -> browser: ${targetStatus.yamlPatches.length}`)
      yield* printPatchPreview("to browser", targetStatus.yamlPatches)
      yield* Console.log(`  pending -> yaml:    ${targetStatus.browserPatches.length}`)
      yield* printPatchPreview("to yaml", targetStatus.browserPatches)
    }
  })

const printBackupSummary = (result: SyncModule.BackupResult) =>
  Effect.gen(function* () {
    yield* Console.log(`Backups written to ${result.backupDir}`)
    for (const file of result.files) {
      yield* Console.log(`  wrote ${file}`)
    }
    for (const skipped of result.skipped) {
      yield* Console.log(`  skipped ${skipped}`)
    }
  })

const program = Effect.gen(function* () {
  const [command, ...args] = process.argv.slice(2)

  if (!command) {
    yield* Console.log(USAGE)
    return
  }

  const { flags, positional } = parseArgs(args)

  switch (command) {
    case "push": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath())
      const preview = flags.dryRun
        ? yield* SyncModule.status({ yamlPath: managed.yamlPath })
        : undefined
      const pushResult = yield* SyncModule.push({
        yamlPath: managed.yamlPath,
        dryRun: flags.dryRun,
      })
      if (flags.json) {
        yield* printJson({
          ...serializeSyncResult("push", managed.yamlPath, flags.dryRun, pushResult),
          preview: preview ? serializeStatus(preview) : null,
        })
      } else {
        yield* printSyncSummary("Push", pushResult, { showDetails: false })
        if (preview) yield* printDryRunPreview("push", preview)
      }
      break
    }
    case "pull": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath())
      const preview = flags.dryRun
        ? yield* SyncModule.status({ yamlPath: managed.yamlPath })
        : undefined
      const pullResult = yield* SyncModule.pull({
        yamlPath: managed.yamlPath,
        dryRun: flags.dryRun,
      })
      if (flags.json) {
        yield* printJson({
          ...serializeSyncResult("pull", managed.yamlPath, flags.dryRun, pullResult),
          preview: preview ? serializeStatus(preview) : null,
        })
      } else {
        yield* printSyncSummary("Pull", pullResult, { showDetails: false })
        if (preview) yield* printDryRunPreview("pull", preview)
      }
      break
    }
    case "sync": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath())
      const preview = flags.dryRun
        ? yield* SyncModule.status({ yamlPath: managed.yamlPath })
        : undefined
      const syncResult = yield* SyncModule.sync({
        yamlPath: managed.yamlPath,
        dryRun: flags.dryRun,
      })
      if (flags.json) {
        yield* printJson({
          ...serializeSyncResult("sync", managed.yamlPath, flags.dryRun, syncResult),
          preview: preview ? serializeStatus(preview) : null,
        })
      } else {
        yield* printSyncSummary("Sync", syncResult, { showDetails: false })
        if (preview) yield* printDryRunPreview("sync", preview)
      }
      break
    }
    case "status": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath())
      const status = yield* SyncModule.status({
        yamlPath: managed.yamlPath,
      })
      if (flags.json) {
        yield* printJson(serializeStatus(status))
      } else {
        yield* printStatus(status)
      }
      break
    }
    case "backup": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath())
      const backup = yield* SyncModule.backup({
        yamlPath: managed.yamlPath,
        backupDir: Paths.defaultBackupDir(),
      })
      if (flags.json) {
        yield* printJson(backup)
      } else {
        yield* printBackupSummary(backup)
      }
      break
    }
    case "gc": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath())
      const maxAge = yield* parseMaxAge(flags.maxAge, flags.json)
      const gcResult = yield* SyncModule.gc({
        yamlPath: managed.yamlPath,
        graveyardMaxAge: maxAge,
      })
      if (flags.json) {
        yield* printJson(serializeSyncResult("gc", managed.yamlPath, false, gcResult))
      } else {
        yield* printSyncSummary("GC", gcResult)
      }
      break
    }
    case "daemon": {
      const subcommand = positional[0]
      if (!subcommand || !["start", "stop", "status"].includes(subcommand)) {
        return yield* emitCliError("Usage: bookmarks daemon start|stop|status", flags.json)
      }
      switch (subcommand) {
        case "start": {
          const config = yield* Daemon.defaultConfig()
          yield* Daemon.start(config)
          if (flags.json) {
            yield* printJson({ running: true, plistPath: "~/Library/LaunchAgents/com.jasonkuhrt.bookmarks-sync.plist" })
          } else {
            yield* Console.log(`Daemon started (interval: 1h, plist: ~/Library/LaunchAgents/com.jasonkuhrt.bookmarks-sync.plist)`)
          }
          break
        }
        case "stop": {
          yield* Daemon.stop()
          if (flags.json) {
            yield* printJson({ running: false })
          } else {
            yield* Console.log("Daemon stopped and plist removed.")
          }
          break
        }
        case "status": {
          const st = yield* Daemon.status()
          if (flags.json) {
            yield* printJson(serializeDaemonStatus(st))
          } else {
            const formatOptDate = (opt: Option.Option<DateTime.Utc>) =>
              Option.isSome(opt) ? opt.value.toJSON() : "unknown"
            yield* Console.log(`Daemon status:`)
            yield* Console.log(`  Running:  ${st.running ? "yes" : "no"}`)
            yield* Console.log(`  Last run: ${formatOptDate(st.lastRun)}`)
            yield* Console.log(`  Next run: ${formatOptDate(st.nextRun)}`)
            yield* Console.log(`  Plist:    ${st.plistPath}`)
          }
          break
        }
      }
      break
    }
    case "doctor": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath())
      const doctorResult = yield* Doctor.runDiagnostics(managed.yamlPath)
      if (flags.json) {
        yield* printJson(doctorResult)
      } else {
        yield* Console.log(Doctor.formatReport(doctorResult))
      }
      if (!doctorResult.allPassed) {
        return yield* Effect.fail(new CliExitError())
      }
      break
    }
    case "validate": {
      const managed = yield* ensureManagedFiles(Paths.defaultYamlPath())
      yield* YamlModule.load(managed.yamlPath).pipe(
        Effect.flatMap(() =>
          flags.json
            ? printJson({ yamlPath: managed.yamlPath, valid: true })
            : Console.log("bookmarks.yaml is valid"),
        ),
        Effect.catchAll((e) =>
          Effect.gen(function* () {
            if (flags.json) {
              yield* printJson({ yamlPath: managed.yamlPath, valid: false, error: e.message })
            } else {
              yield* Console.error(e.message)
            }
            return yield* Effect.fail(new CliExitError())
          })
        ),
      )
      break
    }
    default:
      if (flags.json) {
        return yield* emitCliError(`Unknown command: ${command}`, true)
      }
      yield* Console.error(`Unknown command: ${command}`)
      yield* Console.log(USAGE)
      return yield* Effect.fail(new CliExitError())
  }
})

const runtimeProgram = JSON_OUTPUT
  ? program.pipe(Logger.withMinimumLogLevel(LogLevel.None))
  : program

Effect.runPromiseExit(runtimeProgram).then((exit) => {
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    if (UnsupportedBookmarks.is(err)) {
      if (JSON_OUTPUT) {
        console.error(JSON.stringify({ error: err.message, type: err._tag }, null, 2))
      } else {
        console.error(err.message)
      }
    } else if (!CliExitError.is(err)) {
      if (JSON_OUTPUT) {
        console.error(JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }, null, 2))
      } else {
        console.error(err)
      }
    }
    process.exit(1)
  }
})
