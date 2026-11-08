import { Effect, Schedule, Schema } from "effect";
import * as Path from "node:path";
import * as Chrome from "./chrome.ts";
import { TargetState, type BookmarkTree } from "./schema/__.ts";
import { ChromeBridgeRuntime } from "./chrome-native-runtime.ts";
import { NativeResponseSchema, protocolVersion } from "./chrome-native-protocol.ts";
import * as ReadingList from "./reading-list.ts";
import * as Canonical from "./canonical.ts";

const normalizeTree = (tree: BookmarkTree) =>
  JSON.stringify({ bar: tree.bar ?? [], menu: tree.menu ?? [], mobile: tree.mobile ?? [] });
export const treesEqual = (left: BookmarkTree, right: BookmarkTree) =>
  normalizeTree(left) === normalizeTree(right);

const webUrlsIn = (nodes: BookmarkTree["bar"]): readonly string[] =>
  (nodes ?? []).flatMap((node) =>
    node._tag === "BookmarkLeaf"
      ? /^https?:/i.test(node.url)
        ? [node.url]
        : []
      : webUrlsIn(node.children),
  );

const isParseable = (url: string): boolean => URL.canParse(url);

/** Chrome refuses an unparseable web URL, so a tree bound for Chrome fails before any write. */
export const normalizeDesiredTree = (profilePath: string, tree: BookmarkTree) =>
  Effect.gen(function* () {
    if (!(yield* isPaired(profilePath))) return tree;
    const invalid = [tree.bar, tree.menu, tree.mobile]
      .flatMap(webUrlsIn)
      .find((url) => !isParseable(url));
    if (invalid !== undefined)
      return yield* Effect.fail(
        new Error(
          `Chrome bookmarks contain an invalid HTTP(S) URL (${invalid}). Correct it before syncing.`,
        ),
      );
    return Canonical.canonicalTree(tree);
  });

export const bindingFor = (profilePath: string) =>
  Effect.gen(function* () {
    const runtime = yield* ChromeBridgeRuntime;
    const bindings = yield* runtime.loadBindings;
    return bindings.find((binding) => binding.profilePath === Path.resolve(profilePath));
  });

export const isPaired = (profilePath: string) =>
  bindingFor(profilePath).pipe(Effect.map((binding) => binding !== undefined));

const requestState = (
  instanceId: string,
  operation: "snapshot" | "reconcile",
  expected?: TargetState,
  desired?: TargetState,
) =>
  Effect.gen(function* () {
    const runtime = yield* ChromeBridgeRuntime;
    // Each socket carries one request, so this ID is scoped to the connection by the host.
    const response = yield* runtime.request(instanceId, {
      id: "cli",
      operation,
      ...(expected
        ? { expectedTree: expected.tree, expectedReadingList: expected.readingList }
        : {}),
      ...(desired ? { tree: desired.tree, readingList: desired.readingList } : {}),
    });
    const decoded = yield* Schema.decodeUnknown(NativeResponseSchema)(response).pipe(
      Effect.mapError(
        (error) =>
          new Error(
            `Chrome bridge lacks protocol 2 Reading List support; rebuild/install and reload the extension and native host. Invalid response: ${error.message}`,
          ),
      ),
    );
    if (!decoded.capabilities.includes("readingList"))
      return yield* Effect.fail(
        new Error(
          "Chrome extension lacks readingList capability. Rebuild/install and reload it before syncing.",
        ),
      );
    if (!decoded.ok) return yield* Effect.fail(new Error(decoded.error));
    return yield* Effect.try({
      try: () =>
        TargetState.make({
          tree: Canonical.canonicalTree(decoded.value.tree),
          readingList: ReadingList.canonical(decoded.value.readingList),
        }),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
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

export const readState = (profilePath: string) =>
  Effect.gen(function* () {
    const binding = yield* requireBinding(profilePath);
    return yield* requestState(binding.instanceId, "snapshot").pipe(
      Effect.catchAll((failure) =>
        !isDisconnected(failure)
          ? Effect.fail(failure)
          : Effect.gen(function* () {
              const runtime = yield* ChromeBridgeRuntime;
              yield* runtime.launch(profilePath);
              return yield* requestState(binding.instanceId, "snapshot").pipe(
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

export const readTree = (profilePath: string) =>
  readState(profilePath).pipe(Effect.map((state) => state.tree));

export const writeState = (profilePath: string, expected: TargetState, desired: TargetState) =>
  Effect.gen(function* () {
    const binding = yield* requireBinding(profilePath);
    const tree = yield* normalizeDesiredTree(profilePath, desired.tree);
    const readingList = yield* Effect.try({
      try: () => ReadingList.canonical(desired.readingList),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    if (treesEqual(expected.tree, tree) && ReadingList.equal(expected.readingList, readingList))
      return;
    const result = yield* requestState(
      binding.instanceId,
      "reconcile",
      expected,
      TargetState.make({ tree, readingList }),
    );
    if (!treesEqual(result.tree, tree) || !ReadingList.equal(result.readingList, readingList))
      return yield* Effect.fail(
        new Error(
          "Chrome did not retain the requested bookmark layout or Reading List. The baseline was not advanced; inspect status before retrying.",
        ),
      );
  });

export const writeTree = (profilePath: string, expectedTree: BookmarkTree, tree: BookmarkTree) =>
  Effect.gen(function* () {
    if (treesEqual(expectedTree, tree)) return;
    const observed = yield* readState(profilePath);
    if (!treesEqual(observed.tree, expectedTree))
      return yield* Effect.fail(
        new Error("Chrome bookmarks changed after the sync planned its write."),
      );
    yield* writeState(
      profilePath,
      observed,
      TargetState.make({ tree, readingList: observed.readingList }),
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
      const snapshot = yield* requestState(instanceId, "snapshot").pipe(Effect.option);
      if (snapshot._tag === "Some" && treesEqual(snapshot.value.tree, diskTree))
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
    requestState(binding.instanceId, "snapshot").pipe(
      Effect.map(() => ({ ...binding, connected: true, error: null })),
      Effect.catchAll((error) =>
        Effect.succeed({ ...binding, connected: false, error: error.message }),
      ),
    ),
  );
});
