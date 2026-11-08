import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import * as Worker from "./worker.ts";
import * as ChromeReadingList from "../src/lib/chrome-reading-list.ts";
import * as ReadingList from "../src/lib/reading-list.ts";
import { ReadingListItem } from "../src/lib/schema/__.ts";

test("the worker announces Reading List changes on initial connection, events and reconnect", async () => {
  let entries: readonly ChromeReadingList.Entry[] = [];
  let changed = () => {};
  let connected: Worker.NativePort | undefined;
  const messages: unknown[] = [];
  const api: Worker.ChromeExtensionApi = {
    addReadingListListener: (listener) =>
      Effect.sync(() => {
        changed = listener;
      }),
    addAlarmListener: () => Effect.void,
    addInstalledListener: () => Effect.void,
    addStartupListener: () => Effect.void,
    connectNative: () =>
      Effect.sync(() => ({
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} },
        postMessage: (message) => messages.push(message),
      })),
    createReconnectAlarm: Effect.void,
    delay: () => Effect.void,
    loadInstanceId: Effect.succeed("12345678-1234-1234-1234-123456789abc"),
    newInstanceId: Effect.die("Unexpected ID creation"),
    saveInstanceId: () => Effect.die("Unexpected ID write"),
    addMessageListener: (port, listener) =>
      Effect.sync(() => {
        port.onMessage.addListener(listener);
      }),
    addDisconnectListener: (port, listener) =>
      Effect.sync(() => {
        port.onDisconnect.addListener(listener);
      }),
    postMessage: (port, message) =>
      Effect.sync(() => {
        port.postMessage(message);
      }),
  };
  const layer = Layer.merge(
    Layer.succeed(Worker.ChromeExtension, api),
    Layer.succeed(ChromeReadingList.ChromeReadingList, {
      query: () => Effect.sync(() => entries),
      addEntry: () => Effect.die("Unexpected write"),
      updateEntry: () => Effect.die("Unexpected write"),
      removeEntry: () => Effect.die("Unexpected write"),
    }),
  );
  const connect = () =>
    Effect.runPromise(
      Worker.openConnection(
        () => {},
        () => {},
        (port) => {
          connected = port;
        },
      ).pipe(Effect.provide(layer)),
    );
  await Effect.runPromise(
    Worker.watchReadingListChanges(() => connected).pipe(Effect.provide(layer)),
  );
  await connect();
  expect(messages).toContainEqual({ type: "readingListChanged", fingerprint: "[]" });
  entries = [{ url: "https://a.example/", title: "A", hasBeenRead: true, creationTime: 20 }];
  changed();
  await Bun.sleep(5);
  const fingerprint = ReadingList.fingerprint([
    ReadingListItem.make({ name: "A", url: "https://a.example/", read: true }),
  ]);
  expect(messages.at(-1)).toEqual({ type: "readingListChanged", fingerprint });
  connected = undefined;
  entries = [{ url: "https://a.example/", title: "A", hasBeenRead: false, creationTime: 20 }];
  await connect();
  expect(messages.at(-1)).toEqual({
    type: "readingListChanged",
    fingerprint: ReadingList.fingerprint([
      ReadingListItem.make({ name: "A", url: "https://a.example/", read: false }),
    ]),
  });
});
