import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Doctor from "./doctor.js"
import { BookmarkTree, BookmarksConfig, TargetProfile } from "./schema/__.js"
import { copyChromeBookmarksFixture } from "./test-fixtures.js"
import * as YamlModule from "./yaml.js"

// -- Test helpers --

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

// -- DoctorCheck / DoctorResult types --

describe("DoctorCheck", () => {
  test("has required shape with passing check", () => {
    const check: Doctor.DoctorCheck = {
      name: "test",
      passed: true,
      message: "all good",
    }
    expect(check.name).toBe("test")
    expect(check.passed).toBe(true)
    expect(check.message).toBe("all good")
    expect(check.fix).toBeUndefined()
  })

  test("has optional fix for failing check", () => {
    const check: Doctor.DoctorCheck = {
      name: "test",
      passed: false,
      message: "not good",
      fix: "do this",
    }
    expect(check.passed).toBe(false)
    expect(check.fix).toBe("do this")
  })
})

describe("DoctorResult", () => {
  test("allPassed is true when all checks pass", () => {
    const result: Doctor.DoctorResult = {
      checks: [
        { name: "a", passed: true, message: "ok" },
        { name: "b", passed: true, message: "ok" },
      ],
      allPassed: true,
    }
    expect(result.allPassed).toBe(true)
  })

  test("allPassed is false when any check fails", () => {
    const result: Doctor.DoctorResult = {
      checks: [
        { name: "a", passed: true, message: "ok" },
        { name: "b", passed: false, message: "fail", fix: "fix it" },
      ],
      allPassed: false,
    }
    expect(result.allPassed).toBe(false)
  })
})

// -- formatReport --

describe("formatReport", () => {
  test("uses checkmark for passing checks", () => {
    const result: Doctor.DoctorResult = {
      checks: [{ name: "Full Disk Access", passed: true, message: "granted" }],
      allPassed: true,
    }
    const report = Doctor.formatReport(result)
    expect(report).toContain("\u2713 Full Disk Access: granted")
    expect(report).toContain("All checks passed.")
  })

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
    }
    const report = Doctor.formatReport(result)
    expect(report).toContain("\u2717 Safari plist exists: not found")
    expect(report).toContain("Fix: Launch Safari once.")
    expect(report).toContain("Some checks failed.")
  })

  test("mixed pass/fail report", () => {
    const result: Doctor.DoctorResult = {
      checks: [
        { name: "A", passed: true, message: "ok" },
        { name: "B", passed: false, message: "bad", fix: "do X" },
        { name: "C", passed: true, message: "fine" },
      ],
      allPassed: false,
    }
    const report = Doctor.formatReport(result)
    expect(report).toContain("\u2713 A: ok")
    expect(report).toContain("\u2717 B: bad")
    expect(report).toContain("Fix: do X")
    expect(report).toContain("\u2713 C: fine")
  })

  test("failing check without fix omits Fix line", () => {
    const result: Doctor.DoctorResult = {
      checks: [
        { name: "X", passed: false, message: "broken" },
      ],
      allPassed: false,
    }
    const report = Doctor.formatReport(result)
    expect(report).toContain("\u2717 X: broken")
    expect(report).not.toContain("Fix:")
  })
})

// -- runDiagnostics --

describe("runDiagnostics", () => {
  test("reports the actual configured targets and browser processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-doctor-"))
    const yamlPath = join(dir, "bookmarks.yaml")
    const chromePath = join(dir, "Chrome-Bookmarks.json")

    try {
      await copyChromeBookmarksFixture(chromePath)
      await run(YamlModule.save(yamlPath, BookmarksConfig.make({
        targets: {
          chrome: {
            work: TargetProfile.make({ path: chromePath }),
          },
        },
        base: BookmarkTree.make({}),
      })))

      const result = await run(Doctor.runDiagnostics(yamlPath))
      const names = result.checks.map((check) => check.name)

      expect(typeof result.allPassed).toBe("boolean")
      expect(names).toContain("YAML source of truth")
      expect(names).toContain("Enabled targets")
      expect(names).toContain("Configured target chrome/work exists")
      expect(names).toContain("Google Chrome not running")
      expect(names).not.toContain("Safari plist exists")
      expect(names).not.toContain("Chrome default profile exists")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("surfaces YAML errors without inventing target checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-doctor-invalid-"))
    const yamlPath = join(dir, "bookmarks.yaml")

    try {
      await Bun.write(yamlPath, "targets:\n  chrome:\n    default: [")

      const result = await run(Doctor.runDiagnostics(yamlPath))

      expect(result.allPassed).toBe(false)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0]?.name).toBe("YAML source of truth")
      expect(result.checks[0]?.passed).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("each check has required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-doctor-shape-"))
    const yamlPath = join(dir, "bookmarks.yaml")
    const chromePath = join(dir, "Chrome-Bookmarks.json")

    try {
      await copyChromeBookmarksFixture(chromePath)
      await run(YamlModule.save(yamlPath, BookmarksConfig.make({
        targets: {
          chrome: {
            default: TargetProfile.make({ path: chromePath }),
          },
        },
        base: BookmarkTree.make({}),
      })))

      const result = await run(Doctor.runDiagnostics(yamlPath))
      for (const check of result.checks) {
        expect(typeof check.name).toBe("string")
        expect(typeof check.passed).toBe("boolean")
        expect(typeof check.message).toBe("string")
        if (check.fix !== undefined) {
          expect(typeof check.fix).toBe("string")
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
