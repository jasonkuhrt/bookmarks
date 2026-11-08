import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  buildChromeExtension,
  ChromeNativeSetupRuntime,
  deriveExtensionId,
  extensionId,
  extensionOrigin,
  extensionPublicKey,
  launcherScriptFor,
  nativeHostManifestFor,
  nativeHostName,
} from "./chrome-native-setup.ts";

describe("Chrome native setup", () => {
  test("derives the stable Chrome extension ID from the checked-in public key", () => {
    expect(deriveExtensionId(extensionPublicKey)).toBe("jgjmfdhioofjidphefjjcfebcigbkfjl");
    expect(extensionId).toBe("jgjmfdhioofjidphefjjcfebcigbkfjl");
  });

  test("trusts only the stable bookmarks extension", () => {
    expect(nativeHostManifestFor("/Users/test/.local/share/bookmarks/native-host")).toEqual({
      name: nativeHostName,
      description: "Bookmarks CLI bridge for Chrome's bookmarks API",
      path: "/Users/test/.local/share/bookmarks/native-host",
      type: "stdio",
      allowed_origins: [extensionOrigin],
    });
  });

  test("quotes launcher paths for the shell", () => {
    expect(launcherScriptFor("/path with space/bun", "/repo/Jason's bookmarks/host.ts")).toBe(
      "#!/bin/sh\nset -eu\nexec '/path with space/bun' '/repo/Jason'\"'\"'s bookmarks/host.ts' \"$@\"\n",
    );
  });

  test("deploys the icon directory with the built extension", async () => {
    const copiedDirectories: Array<{ destinationPath: string; sourcePath: string }> = [];
    const runtime = Layer.succeed(ChromeNativeSetupRuntime, {
      homeDirectory: "/Users/test",
      bunExecutablePath: "/usr/local/bin/bun",
      packageRoot: "/repo",
      joinPath: (...parts: ReadonlyArray<string>) => parts.join("/"),
      ensurePrivateDirectory: () => Effect.void,
      readTextFile: () =>
        Effect.succeed(
          JSON.stringify({
            background: { service_worker: "worker.js" },
            key: extensionPublicKey,
          }),
        ),
      copyPrivateDirectory: (sourcePath: string, destinationPath: string) =>
        Effect.sync(() => {
          copiedDirectories.push({ destinationPath, sourcePath });
        }),
      writeTextFile: () => Effect.void,
      buildBrowserWorker: () => Effect.void,
    });

    await Effect.runPromise(
      buildChromeExtension({
        extensionDirectory: "/generated/extension",
        extensionSourceDirectory: "/repo/extension",
      }).pipe(Effect.provide(runtime)),
    );

    expect(copiedDirectories).toEqual([
      {
        sourcePath: "/repo/extension/icons",
        destinationPath: "/generated/extension/icons",
      },
    ]);
  });
});
