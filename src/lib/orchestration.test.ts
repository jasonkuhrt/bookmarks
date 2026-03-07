import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Paths from "./paths.ts";
import * as Orchestration from "./orchestration.ts";

const ORIGINAL_RUNTIME_DIR = process.env["BOOKMARKS_RUNTIME_DIR"];

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect);

const expectMissing = async (path: string): Promise<void> => {
  try {
    await access(path);
    throw new Error(`Expected ${path} to be missing`);
  } catch (error) {
    if (error instanceof Error && error.message === `Expected ${path} to be missing`) {
      throw error;
    }
  }
};

const expectFailure = async (promise: Promise<unknown>, message: string): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected rejection containing "${message}"`);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error(`Expected Error, received ${String(error)}`, { cause: error });
    }
    expect(error.message).toContain(message);
  }
};

afterEach(async () => {
  const runtimeDir = process.env["BOOKMARKS_RUNTIME_DIR"];

  if (ORIGINAL_RUNTIME_DIR === undefined) {
    delete process.env["BOOKMARKS_RUNTIME_DIR"];
  } else {
    process.env["BOOKMARKS_RUNTIME_DIR"] = ORIGINAL_RUNTIME_DIR;
  }

  if (runtimeDir) {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

describe("withOrchestratedSync", () => {
  test("executes the requested operation when no lock exists", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "bookmarks-runtime-"));
    process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;

    let executedOperation: Orchestration.SyncOperation | undefined;

    const result = await run(
      Orchestration.withOrchestratedSync("/tmp/bookmarks.yaml", "pull", (operation) => {
        executedOperation = operation;
        return Effect.succeed("done");
      }),
    );

    expect(result).toEqual({ _tag: "completed", value: "done" });
    expect(executedOperation).toBe("pull");
  });

  test("returns a busy notice when another sync holds the lock", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "bookmarks-runtime-"));
    process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;

    await writeFile(
      Paths.defaultSyncLockPath(),
      JSON.stringify({
        pid: process.pid,
        operation: "sync",
        resourcePath: "/tmp/bookmarks.yaml",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    let invoked = false;

    const result = await run(
      Orchestration.withOrchestratedSync("/tmp/bookmarks.yaml", "sync", () => {
        invoked = true;
        return Effect.succeed("done");
      }),
    );

    expect(invoked).toBe(false);
    expect(result._tag).toBe("deferred");
    if (result._tag === "deferred") {
      expect(result.notice.state).toBe("busy");
      expect(result.notice.message).toContain("already running");
    }
  });

  test("removes stale locks before executing", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "bookmarks-runtime-"));
    process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;

    await writeFile(
      Paths.defaultSyncLockPath(),
      JSON.stringify({
        pid: 999_999,
        operation: "sync",
        resourcePath: "/tmp/bookmarks.yaml",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = await run(
      Orchestration.withOrchestratedSync("/tmp/bookmarks.yaml", "pull", () =>
        Effect.succeed("done"),
      ),
    );

    expect(result).toEqual({ _tag: "completed", value: "done" });
    await expectMissing(Paths.defaultSyncLockPath());
  });

  test("treats malformed lock files as stale state and rewrites them", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "bookmarks-runtime-"));
    process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;

    await writeFile(Paths.defaultSyncLockPath(), "{not-json", "utf-8");

    const result = await run(
      Orchestration.withOrchestratedSync("/tmp/bookmarks.yaml", "sync", () =>
        Effect.succeed("done"),
      ),
    );

    expect(result).toEqual({ _tag: "completed", value: "done" });
    await expectMissing(Paths.defaultSyncLockPath());
  });

  test("clears the lock when the wrapped operation fails", async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "bookmarks-runtime-"));
    process.env["BOOKMARKS_RUNTIME_DIR"] = runtimeDir;

    await expectFailure(
      run(
        Orchestration.withOrchestratedSync("/tmp/bookmarks.yaml", "sync", () =>
          Effect.fail(new Error("boom")),
        ),
      ),
      "boom",
    );

    await expectMissing(Paths.defaultSyncLockPath());
  });
});
