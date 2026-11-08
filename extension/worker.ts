import { Context, Effect, Layer, Schema } from "effect";
import * as ChromeNativeModel from "../src/lib/chrome-native-model.ts";
import {
  HelloSchema,
  InstanceIdSchema,
  NativeRequestSchema,
  NativeResponseSchema,
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

interface NativePort {
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

interface ChromeExtensionApi {
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

class ChromeExtension extends Context.Tag("bookmarks/ChromeExtension")<
  ChromeExtension,
  ChromeExtensionApi
>() {}

const chromeExtensionLiveService: ChromeExtensionApi = {
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

const ChromeLive = Layer.merge(ChromeExtensionLive, ChromeBookmarksLive);

const run = <A>(
  effect: Effect.Effect<A, unknown, ChromeExtension | ChromeNativeModel.ChromeBookmarksApi>,
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
): Effect.Effect<NativeResponse, never, ChromeNativeModel.ChromeBookmarksApi> => {
  const effect =
    request.operation === "snapshot"
      ? ChromeNativeModel.snapshot({ rootSelection: "prefer-syncing" })
      : ChromeNativeModel.reconcile(request.expectedTree, request.tree, {
          rootSelection: "prefer-syncing",
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
): Effect.Effect<void, Error, ChromeExtension | ChromeNativeModel.ChromeBookmarksApi> =>
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
            Schema.encodeSync(NativeResponseSchema)({ id, ok: false, error: error.message }),
          )
          .pipe(Effect.as(undefined));
      }),
    );
    if (request === undefined) return;
    const response = yield* operation(request);
    yield* api.postMessage(port, Schema.encodeSync(NativeResponseSchema)(response));
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

const connect = (): Effect.Effect<void, Error, ChromeExtension> =>
  Effect.gen(function* () {
    if (connectedPort !== undefined) return;
    const api = yield* ChromeExtension;
    const instanceId = yield* getInstanceId();
    const port = yield* api.connectNative(nativeHostName);
    connectedPort = port;

    yield* api.addMessageListener(port, (message) => {
      requestQueue = handleAfter(requestQueue, port, message);
    });
    yield* api.addDisconnectListener(port, () => {
      if (connectedPort !== port) return;
      connectedPort = undefined;
      startConnectionCycle();
    });
    yield* api.postMessage(
      port,
      Schema.encodeSync(HelloSchema)({ type: "hello", version: protocolVersion, instanceId }),
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

void start();
