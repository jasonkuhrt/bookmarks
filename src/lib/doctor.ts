/**
 * Doctor — pre-flight diagnostics for bookmark sync.
 *
 * Runs independent checks against the actual configured targets and produces a
 * checklist-style report.
 * Read-only — no side effects.
 */

import { Effect } from "effect"
import * as Paths from "./paths.js"
import * as Permissions from "./permissions.js"
import * as Targets from "./targets.js"
import * as YamlModule from "./yaml.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DoctorCheck {
  readonly name: string
  readonly passed: boolean
  readonly message: string
  readonly fix?: string | undefined
}

export interface DoctorResult {
  readonly checks: readonly DoctorCheck[]
  readonly allPassed: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pass = (name: string, message: string): DoctorCheck => ({
  name,
  passed: true,
  message,
})

const fail = (name: string, message: string, fix: string): DoctorCheck => ({
  name,
  passed: false,
  message,
  fix,
})

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

const checkFullDiskAccess = (): Effect.Effect<DoctorCheck> =>
  Effect.map(Permissions.checkFullDiskAccess(), (ok) =>
    ok
      ? pass("Full Disk Access for Safari targets", "Terminal has Full Disk Access for the configured Safari targets")
      : fail(
          "Full Disk Access for Safari targets",
          "Terminal lacks Full Disk Access",
          "Open System Settings > Privacy & Security > Full Disk Access and enable your terminal app.",
        ),
  )

const checkYamlValid = (yamlPath: string): Effect.Effect<DoctorCheck> =>
  YamlModule.load(yamlPath).pipe(
    Effect.map(() => pass("YAML source of truth", `bookmarks.yaml is valid at ${yamlPath}`)),
    Effect.catchAll((e) =>
      Effect.succeed(
        fail(
          "YAML source of truth",
          `bookmarks.yaml invalid: ${e.message}`,
          "Run 'bookmarks validate' for detailed errors, then fix bookmarks.yaml.",
        ),
      ),
    ),
  )

const checkEnabledTargets = (targets: readonly Targets.TargetDescriptor[]): DoctorCheck =>
  targets.length > 0
    ? pass(
        "Enabled targets",
        `Found ${targets.length} enabled target${targets.length === 1 ? "" : "s"}.`,
      )
    : fail(
        "Enabled targets",
        "No enabled targets are configured in bookmarks.yaml.",
        "Add at least one enabled target under targets: before syncing.",
      )

const checkConfiguredTarget = (target: Targets.TargetDescriptor): Effect.Effect<DoctorCheck> =>
  Effect.map(Permissions.checkTargetAvailable(target.path), (ok) =>
    ok
      ? pass(
          `Configured target ${Targets.displayNameOf(target)} exists`,
          `Found configured target at ${target.path}`,
        )
      : fail(
          `Configured target ${Targets.displayNameOf(target)} exists`,
          `Configured target not found at ${target.path}`,
          `Update bookmarks.yaml with a valid path for ${Targets.displayNameOf(target)} or create the target file before syncing.`,
        ),
  )

const checkBrowserNotRunning = (browser: string): Effect.Effect<DoctorCheck> =>
  Effect.map(Permissions.checkBrowserRunning(browser), (running) =>
    running
      ? fail(
          `${browser} not running`,
          `${browser} is currently running`,
          `Close ${browser} before syncing to avoid data corruption.`,
        )
      : pass(`${browser} not running`, `${browser} is not running`),
  )

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all diagnostic checks and return a structured result.
 * Each check is independent — all run even if some fail.
 */
export const runDiagnostics = (yamlPath?: string): Effect.Effect<DoctorResult> => {
  const resolvedYamlPath = yamlPath ?? Paths.defaultYamlPath()

  return Effect.gen(function* () {
    const yamlCheck = yield* checkYamlValid(resolvedYamlPath)
    const config = yield* YamlModule.load(resolvedYamlPath).pipe(
      Effect.option,
    )

    if (config._tag === "None") {
      return {
        checks: [yamlCheck],
        allPassed: false,
      }
    }

    const enabledTargets = Targets.listEnabledTargets(config.value)
    const needsFullDiskAccess = enabledTargets.some((target) => Targets.requiresFullDiskAccess(target))
    const browserChecks = [...new Set(enabledTargets.map((target) => Targets.processNameOf(target.browser)))]

    const checks = yield* Effect.all(
      [
        Effect.succeed(yamlCheck),
        Effect.succeed(checkEnabledTargets(enabledTargets)),
        ...(needsFullDiskAccess ? [checkFullDiskAccess()] : []),
        ...enabledTargets.map((target) => checkConfiguredTarget(target)),
        ...browserChecks.map((browser) => checkBrowserNotRunning(browser)),
      ],
      { concurrency: "unbounded" },
    )

    return {
      checks,
      allPassed: checks.every((check) => check.passed),
    }
  })
}

/**
 * Format a DoctorResult as a human-readable checklist string.
 */
export const formatReport = (result: DoctorResult): string => {
  const lines = result.checks.map((c) => {
    const icon = c.passed ? "\u2713" : "\u2717"
    const line = `${icon} ${c.name}: ${c.message}`
    if (!c.passed && c.fix) {
      return `${line}\n  Fix: ${c.fix}`
    }
    return line
  })

  const summary = result.allPassed
    ? "\nAll checks passed."
    : "\nSome checks failed. See fix instructions above."

  return [...lines, summary].join("\n")
}
