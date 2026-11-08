import { Context, Effect, Layer, Runtime, Schema } from "effect";
import * as ChromeReadingList from "../src/lib/chrome-reading-list.ts";
import * as ReadingList from "../src/lib/reading-list.ts";
import { TargetState } from "../src/lib/schema/__.ts";
import * as ChromeNativeModel from "../src/lib/chrome-native-model.ts";
import {
  HelloSchema,
  InstanceIdSchema,
  NativeRequestSchema,
  ExtensionResponseSchema,
  protocolVersion,
  type NativeRequest,
  type NativeResponse,
} from "../src/lib/chrome-native-protocol.ts";

const nativeHostName = "com.jasonkuhrt.bookmarks";
const instanceIdStorageKey = "nativeBridgeInstanceId";
const reconnectAlarmName = "nativeBridgeReconnect";
const reconnectDelaysMs = [250, 1_000, 4_000] as const;
const connectionStabilityMs = 500;

interface ChromeEvent<Arguments extends readonly unknown[]> {
  addListener(listener: (...arguments_: Arguments) => void): void;
}

export interface NativePort {
  readonly onMessage: ChromeEvent<[message: unknown]>;
  readonly onDisconnect: ChromeEvent<[]>;
  postMessage(message: unknown): void;
}

interface ChromeApi {
  readonly alarms: {
    create(name: string, alarmInfo: { readonly periodInMinutes: number }): Promise<void> | void;
    readonly onAlarm: ChromeEvent<[alarm: { readonly name: string }]>;
  };
  readonly bookmarks: {
    getTree(): Promise<readonly ChromeNativeModel.ChromeBookmarkNode[]>;
    create(
      details: ChromeNativeModel.ChromeCreateDetails,
    ): Promise<ChromeNativeModel.ChromeBookmarkNode>;
    update(
      id: string,
      changes: ChromeNativeModel.ChromeUpdateChanges,
    ): Promise<ChromeNativeModel.ChromeBookmarkNode>;
    move(
      id: string,
      destination: ChromeNativeModel.ChromeMoveDestination,
    ): Promise<ChromeNativeModel.ChromeBookmarkNode>;
    remove(id: string): Promise<void>;
  };
  readonly readingList: {
    query(info: object): Promise<readonly ChromeReadingList.Entry[]>;
    addEntry(info: Parameters<ChromeReadingList.Api["addEntry"]>[0]): Promise<void>;
    updateEntry(info: Parameters<ChromeReadingList.Api["updateEntry"]>[0]): Promise<void>;
    removeEntry(info: { readonly url: string }): Promise<void>;
    readonly onEntryAdded: ChromeEvent<[]>;
    readonly onEntryUpdated: ChromeEvent<[]>;
    readonly onEntryRemoved: ChromeEvent<[]>;
  };
  readonly runtime: {
    connectNative(application: string): NativePort;
    readonly lastError?: unknown;
    readonly onInstalled: ChromeEvent<[]>;
    readonly onStartup: ChromeEvent<[]>;
  };
  readonly storage: {
    readonly local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

declare const chrome: ChromeApi;

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error("Chrome bookmark operation failed.");

export interface ChromeExtensionApi {
  readonly addReadingListListener: (listener: () => void) => Effect.Effect<void>;
  readonly addAlarmListener: (listener: (name: string) => void) => Effect.Effect<void>;
  readonly addInstalledListener: (listener: () => void) => Effect.Effect<void>;
  readonly addStartupListener: (listener: () => void) => Effect.Effect<void>;
  readonly connectNative: (application: string) => Effect.Effect<NativePort, Error>;
  readonly createReconnectAlarm: Effect.Effect<void, Error>;
  readonly delay: (milliseconds: number) => Effect.Effect<void>;
  readonly loadInstanceId: Effect.Effect<unknown, Error>;
  readonly newInstanceId: Effect.Effect<string>;
  readonly saveInstanceId: (instanceId: string) => Effect.Effect<void, Error>;
  readonly addMessageListener: (
    port: NativePort,
    listener: (message: unknown) => void,
  ) => Effect.Effect<void>;
  readonly addDisconnectListener: (port: NativePort, listener: () => void) => Effect.Effect<void>;
  readonly postMessage: (port: NativePort, message: unknown) => Effect.Effect<void, Error>;
}

export class ChromeExtension extends Context.Tag("bookmarks/ChromeExtension")<
  ChromeExtension,
  ChromeExtensionApi
>() {}

const chromeExtensionLiveService: ChromeExtensionApi = {
  addReadingListListener: (listener) =>
    Effect.sync(() => {
      chrome.readingList.onEntryAdded.addListener(listener);
      chrome.readingList.onEntryUpdated.addListener(listener);
      chrome.readingList.onEntryRemoved.addListener(listener);
    }),
  addAlarmListener: (listener) =>
    Effect.sync(() => {
      chrome.alarms.onAlarm.addListener((alarm) => {
        listener(alarm.name);
      });
    }),
  addInstalledListener: (listener) =>
    Effect.sync(() => {
      chrome.runtime.onInstalled.addListener(listener);
    }),
  addStartupListener: (listener) =>
    Effect.sync(() => {
      chrome.runtime.onStartup.addListener(listener);
    }),
  connectNative: (application) =>
    Effect.try({
      try: () => chrome.runtime.connectNative(application),
      catch: toError,
    }),
  createReconnectAlarm: Effect.tryPromise({
    try: async () => {
      await chrome.alarms.create(reconnectAlarmName, { periodInMinutes: 1 });
    },
    catch: toError,
  }),
  delay: (milliseconds) =>
    Effect.async<void>((resume) => {
      const timeout = setTimeout(() => {
        resume(Effect.void);
      }, milliseconds);
      return Effect.sync(() => {
        clearTimeout(timeout);
      });
    }),
  loadInstanceId: Effect.tryPromise({
    try: async () => (await chrome.storage.local.get(instanceIdStorageKey))[instanceIdStorageKey],
    catch: toError,
  }),
  newInstanceId: Effect.sync(() => crypto.randomUUID()),
  saveInstanceId: (instanceId) =>
    Effect.tryPromise({
      try: () => chrome.storage.local.set({ [instanceIdStorageKey]: instanceId }),
      catch: toError,
    }),
  addMessageListener: (port, listener) =>
    Effect.sync(() => {
      port.onMessage.addListener(listener);
    }),
  addDisconnectListener: (port, listener) =>
    Effect.sync(() => {
      port.onDisconnect.addListener(() => {
        // Reading lastError prevents Chrome from reporting an unchecked native-host error.
        void chrome.runtime.lastError;
        listener();
      });
    }),
  postMessage: (port, message) =>
    Effect.try({
      try: () => {
        port.postMessage(message);
      },
      catch: toError,
    }),
};

const ChromeExtensionLive = Layer.succeed(ChromeExtension, chromeExtensionLiveService);

const ChromeBookmarksLive = Layer.succeed(ChromeNativeModel.ChromeBookmarks, {
  getTree: () =>
    Effect.tryPromise({
      try: () => chrome.bookmarks.getTree(),
      catch: toError,
    }),
  create: (details) =>
    Effect.tryPromise({
      try: () => chrome.bookmarks.create(details),
      catch: toError,
    }),
  update: (id, changes) =>
    Effect.tryPromise({
      try: () => chrome.bookmarks.update(id, changes),
      catch: toError,
    }),
  move: (id, destination) =>
    Effect.tryPromise({
      try: () => chrome.bookmarks.move(id, destination),
      catch: toError,
    }),
  remove: (id: string) =>
    Effect.tryPromise({
      try: () => chrome.bookmarks.remove(id),
      catch: toError,
    }),
});

const ChromeReadingListLive = Layer.succeed(ChromeReadingList.ChromeReadingList, {
  query: () => Effect.tryPromise({ try: () => chrome.readingList.query({}), catch: toError }),
  addEntry: (entry) =>
    Effect.tryPromise({ try: () => chrome.readingList.addEntry(entry), catch: toError }),
  updateEntry: (entry) =>
    Effect.tryPromise({ try: () => chrome.readingList.updateEntry(entry), catch: toError }),
  removeEntry: (entry) =>
    Effect.tryPromise({ try: () => chrome.readingList.removeEntry(entry), catch: toError }),
});
const ChromeLive = Layer.mergeAll(ChromeExtensionLive, ChromeBookmarksLive, ChromeReadingListLive);

const run = <A>(
  effect: Effect.Effect<
    A,
    unknown,
    ChromeExtension | ChromeNativeModel.ChromeBookmarksApi | ChromeReadingList.Api
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(ChromeLive)));

const getInstanceId = (): Effect.Effect<string, Error, ChromeExtension> =>
  Effect.gen(function* () {
    const api = yield* ChromeExtension;
    const stored = yield* api.loadInstanceId;
    if (Schema.is(InstanceIdSchema)(stored)) return stored;
    const instanceId = yield* api.newInstanceId;
    yield* api.saveInstanceId(instanceId);
    return instanceId;
  });

const getRequestId = (message: unknown): string | undefined => {
  if (typeof message !== "object" || message === null || !("id" in message)) return undefined;
  return typeof message.id === "string" ? message.id : undefined;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Chrome bookmark operation failed.";

const operation = (
  request: NativeRequest,
): Effect.Effect<
  NativeResponse,
  never,
  ChromeNativeModel.ChromeBookmarksApi | ChromeReadingList.Api
> => {
  const effect = Effect.gen(function* () {
    if (request.operation === "snapshot")
      return TargetState.make({
        tree: yield* ChromeNativeModel.snapshot({ rootSelection: "prefer-syncing" }),
        readingList: yield* ChromeReadingList.snapshot,
      });
    // Validate both snapshots before either domain is mutated.
    const tree = yield* ChromeNativeModel.snapshot({ rootSelection: "prefer-syncing" });
    const readingList = yield* ChromeReadingList.snapshot;
    if (
      ChromeNativeModel.fingerprint(tree) !== ChromeNativeModel.fingerprint(request.expectedTree) ||
      !ReadingList.equal(readingList, request.expectedReadingList)
    )
      return yield* Effect.fail(new Error("Chrome changed; retry with a fresh snapshot."));
    yield* Effect.try({ try: () => ReadingList.canonical(request.readingList), catch: toError });
    const nextTree = yield* ChromeNativeModel.reconcile(request.expectedTree, request.tree, {
      rootSelection: "prefer-syncing",
    });
    const nextReadingList = yield* ChromeReadingList.reconcile(
      request.expectedReadingList,
      request.readingList,
    );
    return TargetState.make({ tree: nextTree, readingList: nextReadingList });
  });

  return effect.pipe(
    Effect.map((value) => ({ id: request.id, ok: true, value }) as const),
    Effect.catchAll((error) =>
      Effect.succeed({ id: request.id, ok: false, error: errorMessage(error) } as const),
    ),
  );
};

const handleMessage = (
  port: NativePort,
  message: unknown,
): Effect.Effect<
  void,
  Error,
  ChromeExtension | ChromeNativeModel.ChromeBookmarksApi | ChromeReadingList.Api
> =>
  Effect.gen(function* () {
    const api = yield* ChromeExtension;
    const request = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(NativeRequestSchema)(message),
      catch: () => new Error("Invalid native request."),
    }).pipe(
      Effect.catchAll((error) => {
        const id = getRequestId(message);
        if (id === undefined) return Effect.fail(error);
        return api
          .postMessage(
            port,
            Schema.encodeSync(ExtensionResponseSchema)({ id, ok: false, error: error.message }),
          )
          .pipe(Effect.as(undefined));
      }),
    );
    if (request === undefined) return;
    const response = yield* operation(request);
    if (response.ok) yield* announceReadingList(port);
    yield* api.postMessage(port, Schema.encodeSync(ExtensionResponseSchema)(response));
  });

let connectedPort: NativePort | undefined;
let connecting: Promise<void> | undefined;
let reconnecting: Promise<void> | undefined;
const settled = async (): Promise<void> => undefined;
let requestQueue: Promise<void> = settled();

/** Requests run one at a time, in arrival order; a failed request never blocks the next. */
const handleAfter = async (
  previous: Promise<void>,
  port: NativePort,
  message: unknown,
): Promise<void> => {
  await previous;
  try {
    await run(handleMessage(port, message));
  } catch {
    // The request's response already carries its failure.
  }
};

const announcementLock = Effect.runSync(Effect.makeSemaphore(1));
export const announceReadingList = (port: NativePort) =>
  announcementLock.withPermits(1)(
    Effect.gen(function* () {
      const api = yield* ChromeExtension;
      const items = yield* ChromeReadingList.snapshot;
      yield* api.postMessage(port, {
        type: "readingListChanged",
        fingerprint: ReadingList.fingerprint(items),
      });
    }),
  );

/** Called for every new native port, including reconnects. */
export const openConnection = (
  onMessage: (port: NativePort, message: unknown) => void,
  onDisconnect: (port: NativePort) => void,
  onConnected: (port: NativePort) => void = () => undefined,
) =>
  Effect.gen(function* () {
    const api = yield* ChromeExtension;
    const instanceId = yield* getInstanceId();
    const port = yield* api.connectNative(nativeHostName);
    onConnected(port);
    yield* api.addMessageListener(port, (message) => {
      onMessage(port, message);
    });
    yield* api.addDisconnectListener(port, () => {
      onDisconnect(port);
    });
    yield* api.postMessage(
      port,
      Schema.encodeSync(HelloSchema)({
        type: "hello",
        version: protocolVersion,
        instanceId,
        capabilities: ["readingList"],
      }),
    );
    yield* announceReadingList(port);
    return port;
  });

export const watchReadingListChanges = (port: () => NativePort | undefined) =>
  Effect.gen(function* () {
    const api = yield* ChromeExtension;
    const runtime = yield* Effect.runtime<ChromeExtension | ChromeReadingList.Api>();
    yield* api.addReadingListListener(() => {
      const current = port();
      if (current)
        void Runtime.runPromise(runtime)(announceReadingList(current).pipe(Effect.ignore));
    });
  });

const connect = () =>
  Effect.gen(function* () {
    if (connectedPort !== undefined) return;
    yield* openConnection(
      (port, message) => {
        requestQueue = handleAfter(requestQueue, port, message);
      },
      (port) => {
        if (connectedPort !== port) return;
        connectedPort = undefined;
        startConnectionCycle();
      },
      (port) => {
        connectedPort = port;
      },
    );
  });

const connectAndSettle = async (): Promise<void> => {
  try {
    await run(connect());
  } catch {
    connectedPort = undefined;
  } finally {
    connecting = undefined;
  }
};

const connectOnce = (): Promise<void> => {
  if (connectedPort !== undefined) return Promise.resolve();
  if (connecting !== undefined) return connecting;
  connecting = connectAndSettle();
  return connecting;
};

const confirmConnection = async (): Promise<boolean> => {
  await connectOnce();
  const port = connectedPort;
  if (port === undefined) return false;

  await run(
    Effect.gen(function* () {
      const api = yield* ChromeExtension;
      yield* api.delay(connectionStabilityMs);
    }),
  );
  return connectedPort === port;
};

const startConnectionCycle = (): void => {
  if (connectedPort !== undefined || reconnecting !== undefined) return;

  let completedWithStableConnection = false;
  const cycle = async (): Promise<void> => {
    try {
      if (await confirmConnection()) {
        completedWithStableConnection = true;
        return;
      }

      for (const delay of reconnectDelaysMs) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Reconnect attempts back off one after another by design.
        await run(
          Effect.gen(function* () {
            const api = yield* ChromeExtension;
            yield* api.delay(delay);
          }),
        );
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each attempt waits for the previous back-off.
        if (await confirmConnection()) {
          completedWithStableConnection = true;
          return;
        }
      }
    } catch {
      // A failed cycle is retried by the reconnect alarm.
    } finally {
      reconnecting = undefined;
      // Cover a disconnect between the final stability check and cycle cleanup.
      if (completedWithStableConnection && connectedPort === undefined) startConnectionCycle();
    }
  };
  reconnecting = cycle();
};

const initialize = Effect.gen(function* () {
  const api = yield* ChromeExtension;
  yield* watchReadingListChanges(() => connectedPort);
  yield* api.addInstalledListener(startConnectionCycle);
  yield* api.addStartupListener(startConnectionCycle);
  yield* api.addAlarmListener((name) => {
    if (name === reconnectAlarmName) startConnectionCycle();
  });
  yield* api.createReconnectAlarm;
});

const start = async (): Promise<void> => {
  try {
    await run(initialize);
    startConnectionCycle();
  } catch {
    // The reconnect alarm retries a failed start.
  }
};

if (typeof chrome !== "undefined") void start();
