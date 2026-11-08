import { Effect, Schedule, Schema } from "effect";
import * as Path from "node:path";
import * as Chrome from "./chrome.ts";
import type { BookmarkTree } from "./schema/__.ts";
import { ChromeBridgeRuntime } from "./chrome-native-runtime.ts";
import { NativeResponseSchema, protocolVersion } from "./chrome-native-protocol.ts";
import { canonicalTree } from "./chrome-native-tree.ts";

const normalizeTree = (tree: BookmarkTree) =>
  JSON.stringify({ bar: tree.bar ?? [], menu: tree.menu ?? [], mobile: tree.mobile ?? [] });
export const treesEqual = (left: BookmarkTree, right: BookmarkTree) =>
  normalizeTree(left) === normalizeTree(right);

export const normalizeDesiredTree = (profilePath: string, tree: BookmarkTree) =>
  Effect.gen(function* () {
    if (!(yield* isPaired(profilePath))) return tree;
    return yield* Effect.try({
      try: () => canonicalTree(tree),
      catch: () =>
        new Error("Chrome bookmarks contain an invalid HTTP(S) URL. Correct it before syncing."),
    });
  });

export const bindingFor = (profilePath: string) =>
  Effect.gen(function* () {
    const runtime = yield* ChromeBridgeRuntime;
    const bindings = yield* runtime.loadBindings;
    return bindings.find((binding) => binding.profilePath === Path.resolve(profilePath));
  });

export const isPaired = (profilePath: string) =>
  bindingFor(profilePath).pipe(Effect.map((binding) => binding !== undefined));

const requestTree = (
  instanceId: string,
  operation: "snapshot" | "reconcile",
  expectedTree?: BookmarkTree,
  tree?: BookmarkTree,
) =>
  Effect.gen(function* () {
    const runtime = yield* ChromeBridgeRuntime;
    // Each socket carries one request, so this ID is scoped to the connection by the host.
    const response = yield* runtime.request(instanceId, {
      id: "cli",
      operation,
      ...(expectedTree ? { expectedTree } : {}),
      ...(tree ? { tree } : {}),
    });
    const decoded = yield* Schema.decodeUnknown(NativeResponseSchema)(response).pipe(
      Effect.mapError((error) => new Error(`Invalid Chrome bridge response: ${error.message}`)),
    );
    if (!decoded.ok) return yield* Effect.fail(new Error(decoded.error));
    return decoded.value;
  });

const requireBinding = (profilePath: string) =>
  Effect.gen(function* () {
    const binding = yield* bindingFor(profilePath);
    if (!binding)
      return yield* Effect.fail(
        new Error(
          "Chrome is not paired. Run bookmarks chrome install, load the companion extension, then bookmarks chrome pair chrome/<profile>.",
        ),
      );
    return binding;
  });

const isDisconnected = (error: Error): boolean =>
  "code" in error && (error.code === "ECONNREFUSED" || error.code === "ENOENT");

export const readTree = (profilePath: string) =>
  Effect.gen(function* () {
    const binding = yield* requireBinding(profilePath);
    return yield* requestTree(binding.instanceId, "snapshot").pipe(
      Effect.catchAll((failure) =>
        !isDisconnected(failure)
          ? Effect.fail(failure)
          : Effect.gen(function* () {
              const runtime = yield* ChromeBridgeRuntime;
              yield* runtime.launch(profilePath);
              return yield* requestTree(binding.instanceId, "snapshot").pipe(
                Effect.retry({
                  schedule: Schedule.intersect(Schedule.spaced("300 millis"), Schedule.recurs(30)),
                  while: isDisconnected,
                }),
                Effect.mapError(
                  (error) =>
                    new Error(
                      `Chrome bookmarks extension is unavailable. Open the paired profile and enable Bookmarks CLI in chrome://extensions. ${error.message}`,
                    ),
                ),
              );
            }),
      ),
    );
  });

export const writeTree = (profilePath: string, expectedTree: BookmarkTree, tree: BookmarkTree) =>
  Effect.gen(function* () {
    const binding = yield* requireBinding(profilePath);
    const desiredTree = yield* normalizeDesiredTree(profilePath, tree);
    if (treesEqual(expectedTree, desiredTree)) return;
    const result = yield* requestTree(binding.instanceId, "reconcile", expectedTree, desiredTree);
    if (!treesEqual(result, desiredTree))
      return yield* Effect.fail(
        new Error(
          "Chrome did not retain the requested bookmark layout. The baseline was not advanced; inspect status before retrying.",
        ),
      );
  });

/** Pair only after comparing the extension's live content with the selected profile's disk snapshot. */
export const pair = (profilePath: string) =>
  Effect.gen(function* () {
    const runtime = yield* ChromeBridgeRuntime;
    const diskTree = yield* Chrome.readBookmarks(profilePath);
    const instances = yield* runtime.instances;
    const matches: string[] = [];
    for (const instanceId of instances) {
      const snapshot = yield* requestTree(instanceId, "snapshot").pipe(Effect.option);
      if (snapshot._tag === "Some" && treesEqual(snapshot.value, diskTree))
        matches.push(instanceId);
    }
    if (matches.length !== 1)
      return yield* Effect.fail(
        new Error(
          `Expected exactly one extension matching this Chrome profile; found ${matches.length}. Keep the intended profile open, load Bookmarks CLI, and retry pairing after Chrome saves its bookmarks.`,
        ),
      );
    const instanceId = matches[0];
    if (!instanceId) return yield* Effect.fail(new Error("No matching Chrome extension."));
    const bindings = yield* runtime.loadBindings;
    const binding = { profilePath: Path.resolve(profilePath), instanceId };
    if (
      bindings.some(
        (existing) =>
          existing.instanceId === instanceId && existing.profilePath !== binding.profilePath,
      )
    )
      return yield* Effect.fail(
        new Error("This extension is already paired to another Chrome profile."),
      );
    yield* runtime.saveBindings([
      ...bindings.filter((existing) => existing.profilePath !== binding.profilePath),
      binding,
    ]);
    return { ...binding, version: protocolVersion };
  });

export const status = Effect.gen(function* () {
  const runtime = yield* ChromeBridgeRuntime;
  const bindings = yield* runtime.loadBindings;
  return yield* Effect.forEach(bindings, (binding) =>
    requestTree(binding.instanceId, "snapshot").pipe(
      Effect.map(() => ({ ...binding, connected: true, error: null })),
      Effect.catchAll((error) =>
        Effect.succeed({ ...binding, connected: false, error: error.message }),
      ),
    ),
  );
});
