/**
 * The bookmark tree and Reading List each target held after its last successful sync.
 *
 * A three-way merge reads a target's edits as its difference from this tree, so it must be
 * exactly what that target last agreed with. It lives in the state folder, never in
 * bookmarks.yaml's git history: a YAML edit committed before any browser saw it has to read
 * as a YAML edit, not as a deletion in every browser. Each target keeps its own tree, so a
 * target skipped by one sync (not selected, or its browser open) is merged correctly later.
 */

import { Effect, Schema } from "effect";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Canonical from "./canonical.ts";
import * as ManagedPaths from "./managed-paths.ts";
import * as Paths from "./paths.ts";
import * as ReadingList from "./reading-list.ts";
import { TargetState } from "./schema/__.ts";

const BaselineFile = Schema.Struct({
  version: Schema.Literal(2),
  targets: Schema.Record({ key: Schema.String, value: TargetState }),
});

/** Target key (`safari`, `chrome/default`) to that target's tree after its last sync. */
export type Baselines = Readonly<Record<string, TargetState>>;

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

/** No file yet means no target has synced: each one starts from an empty tree. */
export const load = (path = Paths.defaultSyncBaselinePath()): Effect.Effect<Baselines, Error> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await Fs.readFile(path, "utf-8");
        } catch (error) {
          if (hasCode(error, "ENOENT")) return undefined;
          throw error;
        }
      },
      catch: (error) => new Error(`Failed to read ${path}: ${messageFromUnknown(error)}`),
    });
    if (raw === undefined) return {};
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(raw),
      catch: (error) => new Error(`Failed to parse ${path}: ${messageFromUnknown(error)}`),
    });
    const decoded = yield* Schema.decodeUnknown(BaselineFile)(parsed).pipe(
      Effect.mapError((error) => new Error(`Invalid sync baseline at ${path}: ${error.message}`)),
    );
    return yield* Effect.try({
      try: () =>
        Object.fromEntries(
          Object.entries(decoded.targets).map(([key, state]) => [
            key,
            TargetState.make({
              tree: Canonical.canonicalTree(state.tree),
              readingList: ReadingList.canonical(state.readingList),
            }),
          ]),
        ),
      catch: (cause) => new Error(`Invalid sync baseline at ${path}: ${messageFromUnknown(cause)}`),
    });
  });

export const render = (baselines: Baselines): Effect.Effect<string, Error> =>
  Schema.encode(BaselineFile)({ version: 2, targets: baselines }).pipe(
    Effect.map((encoded) => `${JSON.stringify(encoded, null, 2)}\n`),
    Effect.mapError((error) => new Error(`Failed to encode sync baseline: ${error.message}`)),
  );

/** Written through a temporary file, so a crash leaves the previous baseline intact. */
export const save = (
  baselines: Baselines,
  path = Paths.defaultSyncBaselinePath(),
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const text = yield* render(baselines);
    yield* ManagedPaths.ensureParentDir(path);
    const temporaryPath = Path.join(
      Path.dirname(path),
      `.${Path.basename(path)}.${process.pid}.tmp`,
    );
    yield* Effect.tryPromise({
      try: async () => {
        await Fs.writeFile(temporaryPath, text, "utf-8");
        await Fs.rename(temporaryPath, path);
      },
      catch: (error) => new Error(`Failed to write ${path}: ${messageFromUnknown(error)}`),
    });
  });
