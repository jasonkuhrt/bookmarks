import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ManagedPaths from "./managed-paths.ts";

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);
const runError = async <A>(effect: Effect.Effect<A, Error>): Promise<Error> => {
  try {
    await run(effect);
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected Error, received ${String(error)}`, { cause: error });
  }

  throw new Error("Expected effect to fail");
};

describe("managed paths", () => {
  test("ensureDir materializes a broken symlink ancestor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-managed-paths-"));
    const symlinkPath = join(dir, "managed");
    const targetPath = join(dir, "missing", "target");
    const backupsPath = join(symlinkPath, "backups");

    try {
      await symlink(targetPath, symlinkPath);

      await run(ManagedPaths.ensureDir(backupsPath));

      const targetStat = await lstat(targetPath);
      expect(targetStat.isDirectory()).toBe(true);

      const backupsStat = await lstat(backupsPath);
      expect(backupsStat.isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ensureParentDir materializes a broken symlink ancestor for file writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-managed-paths-"));
    const symlinkPath = join(dir, "managed");
    const targetPath = join(dir, "missing", "target");
    const filePath = join(symlinkPath, "bookmarks.yaml");

    try {
      await symlink(targetPath, symlinkPath);

      await run(ManagedPaths.ensureParentDir(filePath));
      await Bun.write(filePath, "version: 1\n");

      const targetStat = await lstat(targetPath);
      expect(targetStat.isDirectory()).toBe(true);
      expect(await Bun.file(filePath).text()).toBe("version: 1\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ensureDir materializes a direct symlink target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-managed-paths-"));
    const symlinkPath = join(dir, "managed");
    const targetPath = join(dir, "missing", "target");

    try {
      await symlink(targetPath, symlinkPath);

      await run(ManagedPaths.ensureDir(symlinkPath));

      const targetStat = await lstat(targetPath);
      expect(targetStat.isDirectory()).toBe(true);
      const symlinkStat = await lstat(symlinkPath);
      expect(symlinkStat.isSymbolicLink()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ensureDir fails when the path already exists as a regular file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-managed-paths-"));
    const filePath = join(dir, "not-a-directory");

    try {
      await writeFile(filePath, "hi");
      const error = await runError(ManagedPaths.ensureDir(filePath));
      expect(error.message).toContain(`Failed to create directory ${filePath}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ensureDir creates a plain missing directory tree without symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bookmarks-managed-paths-"));
    const nestedPath = join(dir, "plain", "nested", "dir");

    try {
      await run(ManagedPaths.ensureDir(nestedPath));
      const stat = await lstat(nestedPath);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
