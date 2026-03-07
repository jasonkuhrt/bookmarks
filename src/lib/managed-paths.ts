/* oxlint-disable no-await-in-loop, restrict-template-expressions */
import { Effect } from "effect";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

const codeIs = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const materializeAncestorSymlinkTargets = (path: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      const resolvedPath = Path.resolve(path);
      const parsed = Path.parse(resolvedPath);
      const relativeParts = parsed.dir.slice(parsed.root.length).split(Path.sep).filter(Boolean);

      let current = parsed.root;
      for (const part of relativeParts) {
        current = Path.join(current, part);
        try {
          const stat = await Fs.lstat(current);
          if (!stat.isSymbolicLink()) continue;

          const target = await Fs.readlink(current);
          const absoluteTarget = Path.isAbsolute(target)
            ? target
            : Path.resolve(Path.dirname(current), target);
          await Fs.mkdir(absoluteTarget, { recursive: true });
        } catch (error) {
          if (codeIs(error, "ENOENT")) continue;
          throw error;
        }
      }
    },
    catch: (e) => new Error(`Failed to prepare managed path ${path}: ${e}`),
  });

const materializePathIfSymlink = (path: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const stat = await Fs.lstat(path);
        if (!stat.isSymbolicLink()) return;

        const target = await Fs.readlink(path);
        const absoluteTarget = Path.isAbsolute(target)
          ? target
          : Path.resolve(Path.dirname(path), target);
        await Fs.mkdir(absoluteTarget, { recursive: true });
      } catch (error) {
        if (codeIs(error, "ENOENT")) return;
        throw error;
      }
    },
    catch: (e) => new Error(`Failed to prepare managed path ${path}: ${e}`),
  });

export const ensureDir = (path: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* materializeAncestorSymlinkTargets(path);
    yield* materializePathIfSymlink(path);
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await Fs.mkdir(path, { recursive: true });
        } catch (error) {
          if (!codeIs(error, "EEXIST")) throw error;

          const stat = await Fs.lstat(path);
          if (!stat.isDirectory() && !stat.isSymbolicLink()) throw error;
        }
      },
      catch: (e) => new Error(`Failed to create directory ${path}: ${e}`),
    });
  });

export const ensureParentDir = (path: string): Effect.Effect<void, Error> =>
  ensureDir(Path.dirname(path));
