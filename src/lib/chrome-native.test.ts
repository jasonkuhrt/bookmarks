import { expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Native from "./chrome-native.ts";
import { ChromeBridgeRuntime, type Runtime } from "./chrome-native-runtime.ts";
import * as Patch from "./patch.ts";
import { BookmarkTree, BookmarkLeaf } from "./schema/__.ts";
import * as Targets from "./targets.ts";

const rejectionOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the promise to reject.");
};

const profilePath = "/test/Chrome/Profile 1/Bookmarks";
const instanceId = "12345678-1234-1234-1234-123456789abc";
const before = BookmarkTree.make({
  bar: [BookmarkLeaf.make({ name: "Original", url: "https://example.com/" })],
});
const after = BookmarkTree.make({
  bar: [BookmarkLeaf.make({ name: "Renamed", url: "https://example.com/" })],
});
const makeLayerFor = (boundProfilePath: string, request: Runtime["request"]) =>
  Layer.succeed(ChromeBridgeRuntime, {
    loadBindings: Effect.succeed([{ profilePath: boundProfilePath, instanceId }]),
    saveBindings: () => Effect.die("Unexpected binding write"),
    instances: Effect.succeed([instanceId]),
    request,
    launch: () => Effect.die("Unexpected browser launch"),
  });

const makeLayer = (request: Runtime["request"]) => makeLayerFor(profilePath, request);

const addPatch = Patch.Add({
  url: "https://new.example",
  name: "New",
  path: "bar",
  date: DateTime.unsafeMake("2026-09-27T00:00:00.000Z"),
});

test("native writes include the planning snapshot and verify Chrome's response", async () => {
  const requests: unknown[] = [];
  const layer = makeLayer((id, request) =>
    Effect.sync(() => {
      expect(id).toBe(instanceId);
      requests.push(request);
      return { id: "cli", ok: true, value: after };
    }),
  );
  await Effect.runPromise(Native.writeTree(profilePath, before, after).pipe(Effect.provide(layer)));
  expect(requests).toEqual([
    { id: "cli", operation: "reconcile", expectedTree: before, tree: after },
  ]);
});

test("a stale snapshot rejection never silently retries a write", async () => {
  let calls = 0;
  const layer = makeLayer(() =>
    Effect.sync(() => {
      calls++;
      return { id: "cli", ok: false, error: "Bookmarks changed; retry with a fresh snapshot." };
    }),
  );
  expect(
    await rejectionOf(
      Effect.runPromise(Native.writeTree(profilePath, before, after).pipe(Effect.provide(layer))),
    ),
  ).toContain("Bookmarks changed");
  expect(calls).toBe(1);
});

test("unconfirmed or mismatched writes fail and identical trees cause no request", async () => {
  let calls = 0;
  const layer = makeLayer(() =>
    Effect.sync(() => {
      calls++;
      return { id: "cli", ok: true, value: before };
    }),
  );
  await Effect.runPromise(
    Native.writeTree(profilePath, before, before).pipe(Effect.provide(layer)),
  );
  expect(calls).toBe(0);
  expect(
    await rejectionOf(
      Effect.runPromise(Native.writeTree(profilePath, before, after).pipe(Effect.provide(layer))),
    ),
  ).toContain("did not retain");
  expect(calls).toBe(1);
});

test("paired Targets routes reads and full rewrites through the live bridge without touching Sync metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bookmarks-native-target-"));
  const bookmarksPath = join(directory, "Bookmarks");
  const diskContents = JSON.stringify({
    checksum: "disk-checksum",
    roots: {},
    sync_metadata: "opaque-sync-state",
    version: 1,
  });
  await writeFile(bookmarksPath, diskContents);
  const target = {
    browser: "chrome",
    profile: "profile-1",
    path: bookmarksPath,
    enabled: true,
  } as const;
  let liveTree = before;
  const operations: string[] = [];
  const layer = makeLayerFor(bookmarksPath, (_id, request) =>
    Effect.sync(() => {
      if (
        request === null ||
        typeof request !== "object" ||
        !("operation" in request) ||
        typeof request.operation !== "string"
      ) {
        throw new Error("Missing bridge operation");
      }
      const operation = request.operation;
      operations.push(operation);
      if (operation === "reconcile") liveTree = after;
      return { id: "cli", ok: true, value: liveTree };
    }),
  );

  try {
    const initial = await Effect.runPromise(Targets.readTree(target).pipe(Effect.provide(layer)));
    const requiresRewrite = await Effect.runPromise(
      Targets.requiresFullRewrite(target, [addPatch]).pipe(Effect.provide(layer)),
    );
    await Effect.runPromise(Targets.writeTree(target, after, initial).pipe(Effect.provide(layer)));
    const final = await Effect.runPromise(Targets.readTree(target).pipe(Effect.provide(layer)));

    expect(initial).toEqual(before);
    expect(requiresRewrite).toBe(true);
    expect(final).toEqual(after);
    // The write takes a fresh snapshot, so a bookmark edited after planning is never overwritten.
    expect(operations).toEqual(["snapshot", "snapshot", "reconcile", "snapshot"]);
    expect(await readFile(bookmarksPath, "utf8")).toBe(diskContents);

    liveTree = before;
    expect(
      await rejectionOf(
        Effect.runPromise(Targets.writeTree(target, before, after).pipe(Effect.provide(layer))),
      ),
    ).toContain("changed after the sync planned its write");
    expect(operations.at(-1)).toBe("snapshot");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paired Targets refuses patch writes instead of falling through to the synced disk file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bookmarks-native-patch-"));
  const bookmarksPath = join(directory, "Bookmarks");
  const diskContents = JSON.stringify({
    checksum: "disk-checksum",
    roots: {},
    sync_metadata: "opaque-sync-state",
    version: 1,
  });
  await writeFile(bookmarksPath, diskContents);
  const target = {
    browser: "chrome",
    profile: "profile-1",
    path: bookmarksPath,
    enabled: true,
  } as const;
  let bridgeRequests = 0;
  const layer = makeLayerFor(bookmarksPath, () =>
    Effect.sync(() => {
      bridgeRequests += 1;
      return { id: "cli", ok: true, value: before };
    }),
  );

  try {
    expect(
      await rejectionOf(
        Effect.runPromise(Targets.applyPatches(target, [addPatch]).pipe(Effect.provide(layer))),
      ),
    ).toMatch(/Paired Chrome writes.*bookmarks sync/);
    expect(bridgeRequests).toBe(0);
    expect(await readFile(bookmarksPath, "utf8")).toBe(diskContents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
