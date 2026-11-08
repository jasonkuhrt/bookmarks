#!/usr/bin/env bun
/** Chrome owns this process. Stdout is exclusively length-prefixed native messages. */
import { Context, Effect, HashMap, HashSet, Option, Schema } from "effect";
import * as Fs from "node:fs/promises";
import * as Net from "node:net";
import * as ChromeNativeRuntime from "../lib/chrome-native-runtime.ts";
import * as ChromeNativeSetup from "../lib/chrome-native-setup.ts";
import * as ChromeNativeProtocol from "../lib/chrome-native-protocol.ts";

const runLive = () =>
  Effect.async<void, Error>((resume) => {
    const origin = process.argv[2];
    if (origin !== `chrome-extension://${ChromeNativeSetup.extensionId}/`) {
      resume(Effect.fail(new Error("Unrecognized Chrome extension origin.")));
      return;
    }
    const decode = ChromeNativeProtocol.makeFrameDecoder();
    let pending = HashMap.empty<string, { socket: Net.Socket; clientId: string }>();
    let clients = HashSet.empty<Net.Socket>();
    let sequence = 0;
    let server: Net.Server | undefined;
    let ownedPath: string | undefined;
    let ownedInode: number | undefined;
    let hello: typeof ChromeNativeProtocol.HelloSchema.Type | undefined;
    const settled = async (): Promise<void> => undefined;
    let incoming = settled();
    let initialized = false;
    let stopped = false;

    const cleanup = async () => {
      for (const client of clients) client.destroy();
      server?.close();
      if (ownedPath && ownedInode !== undefined) {
        const stat = await Fs.lstat(ownedPath).catch(() => undefined);
        if (stat?.ino === ownedInode) await Fs.unlink(ownedPath).catch(() => {});
      }
    };
    const cleanupAndResume = async (failure: Error | undefined) => {
      try {
        await cleanup();
      } finally {
        resume(failure ? Effect.fail(failure) : Effect.void);
      }
    };
    const stop = (failure?: Error) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(handshakeTimer);
      process.stdin.pause();
      void cleanupAndResume(failure);
    };
    const handshakeTimer = setTimeout(() => {
      stop(new Error("Chrome extension did not identify itself."));
    }, 15_000);
    const listen = async (instanceId: string) => {
      await Fs.mkdir(ChromeNativeRuntime.bridgeDirectory(), { recursive: true, mode: 0o700 });
      await Fs.chmod(ChromeNativeRuntime.bridgeDirectory(), 0o700);
      const path = ChromeNativeRuntime.socketPath(instanceId);
      const existing = await Fs.lstat(path).catch(() => undefined);
      if (existing) {
        if (!existing.isSocket() || (process.getuid && existing.uid !== process.getuid()))
          throw new Error("Unexpected file at Chrome bridge socket path.");
        const active = await new Promise<boolean>((resolve) => {
          const probe = Net.createConnection(path);
          probe.once("connect", () => {
            probe.destroy();
            resolve(true);
          });
          probe.once("error", () => {
            probe.destroy();
            resolve(false);
          });
        });
        if (active) throw new Error("Chrome extension already has a connected native host.");
        await Fs.unlink(path);
      }
      server = Net.createServer((socket) => {
        clients = HashSet.add(clients, socket);
        let input = Buffer.alloc(0);
        let submitted = false;
        socket.setTimeout(125_000, () => socket.destroy());
        socket.on("error", () => socket.destroy());
        socket.on("close", () => {
          clients = HashSet.remove(clients, socket);
          for (const [id, request] of pending)
            if (request.socket === socket) pending = HashMap.remove(pending, id);
        });
        socket.on("data", (chunk: Buffer) => {
          if (submitted) {
            socket.destroy();
            return;
          }
          input = Buffer.concat([input, chunk]);
          if (input.length > ChromeNativeProtocol.maxMessageBytes) {
            socket.destroy();
            return;
          }
          const newline = input.indexOf(10);
          if (newline === -1) return;
          submitted = true;
          try {
            const request = Schema.decodeUnknownSync(ChromeNativeProtocol.NativeRequestSchema)(
              JSON.parse(input.subarray(0, newline).toString("utf8")),
            );
            const id = String(++sequence);
            pending = HashMap.set(pending, id, { socket, clientId: request.id });
            process.stdout.write(ChromeNativeProtocol.encodeFrame({ ...request, id }));
          } catch {
            socket.end(
              JSON.stringify({ id: "cli", ok: false, error: "Invalid Chrome bookmark request." }) +
                "\n",
            );
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(path, () => {
          resolve();
        });
      });
      ownedPath = path;
      await Fs.chmod(path, 0o600);
      ownedInode = (await Fs.lstat(path)).ino;
      server.on("error", (error) => {
        stop(error);
      });
    };
    const receive = async (value: unknown): Promise<void> => {
      if (!initialized) {
        hello = Schema.decodeUnknownSync(ChromeNativeProtocol.HelloSchema)(value);
        initialized = true;
        clearTimeout(handshakeTimer);
        await listen(hello.instanceId);
        return;
      }
      const change = Schema.decodeUnknownOption(ChromeNativeProtocol.ReadingListChangedSchema)(
        value,
      );
      if (change._tag === "Some" && hello) {
        const path = ChromeNativeRuntime.readingListStampPath(hello.instanceId);
        const temporary = `${path}.${process.pid}.tmp`;
        await Fs.writeFile(temporary, change.value.fingerprint + "\n", { mode: 0o600 });
        await Fs.rename(temporary, path);
        return;
      }
      const response = Schema.decodeUnknownSync(ChromeNativeProtocol.ExtensionResponseSchema)(
        value,
      );
      const request = HashMap.get(pending, response.id);
      if (Option.isNone(request)) return;
      pending = HashMap.remove(pending, response.id);
      request.value.socket.end(
        JSON.stringify({
          ...response,
          id: request.value.clientId,
          hostVersion: ChromeNativeProtocol.protocolVersion,
          version: hello?.version,
          capabilities: hello?.capabilities,
        }) + "\n",
      );
    };
    const receiveAfter = async (
      previous: Promise<void>,
      values: readonly unknown[],
    ): Promise<void> => {
      try {
        await previous;
        // Frame order includes durable stamps before the following response is visible to CLI.
        await Effect.runPromise(
          Effect.forEach(values, (value) => Effect.promise(() => receive(value)), {
            discard: true,
          }),
        );
      } catch {
        stop(new Error("Invalid native message from Chrome bookmarks extension."));
      }
    };
    process.stdin.on("data", (chunk: Buffer) => {
      try {
        incoming = receiveAfter(incoming, decode(chunk));
      } catch {
        stop(new Error("Invalid native message from Chrome bookmarks extension."));
      }
    });
    const finishInput = async () => {
      await incoming;
      stop();
    };
    process.stdin.on("end", () => {
      void finishInput();
    });
    process.stdin.on("error", (error) => {
      stop(error);
    });
    process.stdout.on("error", (error) => {
      stop(error);
    });
    process.once("SIGTERM", () => {
      stop();
    });
    process.once("SIGINT", () => {
      stop();
    });
    return Effect.promise(cleanup);
  });

class NativeHostRuntime extends Context.Reference<NativeHostRuntime>()(
  "bookmarks/NativeHostRuntime",
  { defaultValue: () => ({ run: runLive }) },
) {}

const program = Effect.gen(function* () {
  const runtime = yield* NativeHostRuntime;
  yield* runtime.run();
});
const result = await Effect.runPromiseExit(program);
if (result._tag === "Failure") {
  // Never put diagnostics on stdout: it would corrupt Chrome's native framing.
  process.stderr.write(
    "Bookmarks CLI native host stopped. Check extension connection and installation.\n",
  );
  process.exitCode = 1;
}
