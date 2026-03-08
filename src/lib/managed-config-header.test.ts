import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyManagedConfigHeader,
  DEFAULT_DAEMON_HEADER_STATE,
  extractDaemonHeaderState,
  formatDaemonHeaderLine,
  parseDaemonHeaderLine,
  readDaemonHeaderState,
  SCHEMA_MODELINE,
  stripManagedConfigHeader,
  writeManagedConfigHeader,
} from "./managed-config-header.ts";

describe("managed config header", () => {
  test("formats and parses machine-managed daemon headers", () => {
    const line = formatDaemonHeaderLine({
      status: "running",
      phase: "queued",
      nextSyncAt: "2026-03-08T13:00:00.000Z",
    });

    expect(line).toBe(
      "# machine-managed: bookmarks daemon status=running; phase=queued; next_sync_at=2026-03-08T13:00:00.000Z",
    );
    expect(parseDaemonHeaderLine(line)).toEqual({
      status: "running",
      phase: "queued",
      nextSyncAt: "2026-03-08T13:00:00.000Z",
    });
  });

  test("applies the managed prologue and strips it back out", () => {
    const raw = `version: 2\nall: {}\n`;
    const withHeader = applyManagedConfigHeader(raw, DEFAULT_DAEMON_HEADER_STATE);

    expect(withHeader).toStartWith(
      "# machine-managed: bookmarks daemon status=stopped; phase=stopped\n",
    );
    expect(withHeader).toContain(`${SCHEMA_MODELINE}\nversion: 2\n`);
    expect(stripManagedConfigHeader(withHeader)).toBe(raw);
    expect(extractDaemonHeaderState(withHeader)).toEqual(DEFAULT_DAEMON_HEADER_STATE);
  });

  test("replaces an existing managed header without duplicating the schema line", () => {
    const raw = [
      "# machine-managed: bookmarks daemon status=stopped; phase=stopped",
      SCHEMA_MODELINE,
      "",
      "version: 2",
      "all: {}",
      "",
    ].join("\n");

    const updated = applyManagedConfigHeader(raw, {
      status: "running",
      phase: "syncing",
    });

    expect(updated).toBe(
      [
        "# machine-managed: bookmarks daemon status=running; phase=syncing",
        SCHEMA_MODELINE,
        "version: 2",
        "all: {}",
        "",
      ].join("\n"),
    );
  });

  test("reads and writes the managed header directly on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-managed-header-"));
    const yamlPath = join(dir, "bookmarks.yaml");

    try {
      await writeFile(
        yamlPath,
        applyManagedConfigHeader("version: 2\nall: {}\n", DEFAULT_DAEMON_HEADER_STATE),
        "utf-8",
      );

      expect(await readDaemonHeaderState(yamlPath)).toEqual(DEFAULT_DAEMON_HEADER_STATE);

      await writeManagedConfigHeader(yamlPath, {
        status: "running",
        phase: "idle",
      });

      const updated = await readFile(yamlPath, "utf-8");
      expect(updated).toStartWith(
        "# machine-managed: bookmarks daemon status=running; phase=idle\n",
      );
      expect(await readDaemonHeaderState(yamlPath)).toEqual({
        status: "running",
        phase: "idle",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing files are a no-op for direct managed-header reads and writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-managed-header-missing-"));
    const yamlPath = join(dir, "missing.yaml");

    try {
      expect(await readDaemonHeaderState(yamlPath)).toBeUndefined();
      await writeManagedConfigHeader(yamlPath, DEFAULT_DAEMON_HEADER_STATE);
      expect(await readDaemonHeaderState(yamlPath)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
