import { Context, Effect, Schema } from "effect";
import * as Fs from "node:fs/promises";
import * as Net from "node:net";
import * as Path from "node:path";
import { execFile } from "node:child_process";
import * as Paths from "./paths.ts";
import { InstanceIdSchema, maxMessageBytes } from "./chrome-native-protocol.ts";

const BindingSchema = Schema.Struct({ profilePath: Schema.String, instanceId: InstanceIdSchema });
export const BindingsSchema = Schema.Array(BindingSchema);
export type Binding = typeof BindingSchema.Type;
const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));
export const bridgeDirectory = (): string => Path.join(Paths.defaultRuntimeDir(), "chrome");
export const bindingsPath = (): string => Path.join(Paths.defaultConfigDir(), "chrome-bridge.json");
export const socketPath = (instanceId: string): string =>
  Path.join(bridgeDirectory(), `${Schema.decodeUnknownSync(InstanceIdSchema)(instanceId)}.sock`);

export interface Runtime {
  readonly loadBindings: Effect.Effect<readonly Binding[], Error>;
  readonly saveBindings: (bindings: readonly Binding[]) => Effect.Effect<void, Error>;
  readonly instances: Effect.Effect<readonly string[], Error>;
  readonly request: (instanceId: string, request: unknown) => Effect.Effect<unknown, Error>;
  readonly launch: (profilePath: string) => Effect.Effect<void, Error>;
}

const live: Runtime = {
  loadBindings: Effect.tryPromise({
    try: async () => {
      let text: string;
      try {
        text = await Fs.readFile(bindingsPath(), "utf8");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return [];
        throw error;
      }
      return Schema.decodeUnknownSync(BindingsSchema)(JSON.parse(text));
    },
    catch: toError,
  }),
  saveBindings: (bindings) =>
    Effect.tryPromise({
      try: async () => {
        const destination = bindingsPath();
        await Fs.mkdir(Path.dirname(destination), { recursive: true, mode: 0o700 });
        const temporary = `${destination}.${process.pid}.tmp`;
        await Fs.writeFile(temporary, JSON.stringify(bindings, null, 2) + "\n", { mode: 0o600 });
        await Fs.rename(temporary, destination);
      },
      catch: toError,
    }),
  instances: Effect.tryPromise({
    try: async () => {
      let entries: string[];
      try {
        entries = await Fs.readdir(bridgeDirectory());
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return [];
        throw error;
      }
      return entries
        .filter((name) => name.endsWith(".sock"))
        .map((name) => name.slice(0, -5))
        .filter(Schema.is(InstanceIdSchema));
    },
    catch: toError,
  }),
  request: (instanceId, request) =>
    Effect.async<unknown, Error>((resume) => {
      const bytes = Buffer.from(JSON.stringify(request) + "\n");
      if (bytes.length > maxMessageBytes) {
        resume(Effect.fail(new Error("Chrome bookmark request is too large.")));
        return;
      }
      const socket = Net.createConnection(socketPath(instanceId));
      let received = Buffer.alloc(0);
      let finished = false;
      const finish = (result: Effect.Effect<unknown, Error>) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resume(result);
      };
      socket.setTimeout(120_000, () => {
        finish(
          Effect.fail(
            new Error(
              "Chrome bookmark operation timed out. Read status before retrying; a write may have completed.",
            ),
          ),
        );
      });
      socket.on("connect", () => socket.write(bytes));
      socket.on("error", (error) => {
        finish(Effect.fail(error));
      });
      socket.on("close", () => {
        if (!finished)
          finish(
            Effect.fail(
              new Error(
                "Chrome bookmark connection closed before confirmation. Read status before retrying.",
              ),
            ),
          );
      });
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > maxMessageBytes) {
          finish(Effect.fail(new Error("Chrome bookmark response is too large.")));
          return;
        }
        const newline = received.indexOf(10);
        if (newline !== -1) {
          try {
            finish(Effect.succeed(JSON.parse(received.subarray(0, newline).toString("utf8"))));
          } catch (error) {
            finish(Effect.fail(toError(error)));
          }
        }
      });
      return Effect.sync(() => socket.destroy());
    }),
  launch: (profilePath) =>
    Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          execFile(
            "/usr/bin/open",
            [
              "-g",
              "-a",
              "Google Chrome",
              "--args",
              `--profile-directory=${Path.basename(Path.dirname(profilePath))}`,
            ],
            (error) => {
              if (error) reject(error);
              else resolve();
            },
          );
        }),
      catch: toError,
    }),
};

/** The OS boundary is replaceable with an Effect test layer. */
export class ChromeBridgeRuntime extends Context.Reference<ChromeBridgeRuntime>()(
  "bookmarks/ChromeBridgeRuntime",
  { defaultValue: () => live },
) {}
