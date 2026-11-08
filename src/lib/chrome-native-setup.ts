import { Context, Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import * as Fs from "node:fs/promises";
import { homedir } from "node:os";
import * as Path from "node:path";

export const nativeHostName = "com.jasonkuhrt.bookmarks";

export const extensionPublicKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwkQwHEO2q1cdTO/2X84H17n82ZKD0z9F9J+3uxdDAJV8hinFfixk+fmDploqa7KFguu6R1X60/2qFakET7zANzLjicpNLer4sT662adm3qciaWi60hExLt0OAewnqBi0H5goccEhbBCbABGDFUwZC0H5KFBjfL5iI9C5I4lCWVPvrdmBh6kKV0c1YMoCSDl/SEnL1Nzy481QdFTVOBlmi3IwN1yCzHhxinSFs7Qqq/8+agfcbbX/2MO8bA7qzfctQ964ZxocQxYfxrZ52+AiyhAvxTXaM+PO3QNS2E54kuPWbBhdLLYjQniJsbTBfMJEM26uP4ch1SKHs2Or4z7ypQIDAQAB";

export const deriveExtensionId = (publicKey: string): string => {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest();
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
};

export const extensionId = deriveExtensionId(extensionPublicKey);
export const extensionOrigin = `chrome-extension://${extensionId}/`;

const messageFromUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface ChromeNativeSetupRuntimeShape {
  readonly homeDirectory: string;
  readonly bunExecutablePath: string;
  readonly packageRoot: string;
  readonly joinPath: (...parts: ReadonlyArray<string>) => string;
  readonly ensurePrivateDirectory: (path: string) => Effect.Effect<void, Error>;
  readonly readTextFile: (path: string) => Effect.Effect<string, Error>;
  readonly copyPrivateDirectory: (
    sourcePath: string,
    destinationPath: string,
  ) => Effect.Effect<void, Error>;
  readonly writeTextFile: (
    path: string,
    contents: string,
    mode: number,
  ) => Effect.Effect<void, Error>;
  readonly buildBrowserWorker: (
    entrypoint: string,
    outputDirectory: string,
  ) => Effect.Effect<void, Error>;
}

export const ChromeNativeSetupRuntime = Context.GenericTag<ChromeNativeSetupRuntimeShape>(
  "bookmarks/ChromeNativeSetupRuntime",
);

const packageRootFromModule = Path.resolve(import.meta.dir, "..", "..");

export const ChromeNativeSetupRuntimeLive = Layer.succeed(ChromeNativeSetupRuntime, {
  homeDirectory: homedir(),
  bunExecutablePath: process.execPath,
  packageRoot: packageRootFromModule,
  joinPath: (...parts) => Path.join(...parts),
  ensurePrivateDirectory: (path) =>
    Effect.tryPromise({
      try: async () => {
        await Fs.mkdir(path, { mode: 0o700, recursive: true });
        await Fs.chmod(path, 0o700);
      },
      catch: (error) =>
        new Error(`Failed to prepare private directory ${path}: ${messageFromUnknown(error)}`),
    }),
  readTextFile: (path) =>
    Effect.tryPromise({
      try: () => Fs.readFile(path, "utf8"),
      catch: (error) => new Error(`Failed to read ${path}: ${messageFromUnknown(error)}`),
    }),
  copyPrivateDirectory: (sourcePath, destinationPath) =>
    Effect.tryPromise({
      try: async () => {
        await Fs.cp(sourcePath, destinationPath, { force: true, recursive: true });

        const applyPrivatePermissions = async (path: string): Promise<void> => {
          const entries = await Fs.readdir(path, { withFileTypes: true });
          await Fs.chmod(path, 0o700);
          await Promise.all(
            entries.map(async (entry) => {
              const entryPath = Path.join(path, entry.name);
              if (entry.isDirectory()) {
                await applyPrivatePermissions(entryPath);
              } else {
                await Fs.chmod(entryPath, 0o600);
              }
            }),
          );
        };

        await applyPrivatePermissions(destinationPath);
      },
      catch: (error) =>
        new Error(
          `Failed to copy private directory ${sourcePath} to ${destinationPath}: ${messageFromUnknown(error)}`,
        ),
    }),
  writeTextFile: (path, contents, mode) =>
    Effect.tryPromise({
      try: async () => {
        await Fs.mkdir(Path.dirname(path), { mode: 0o700, recursive: true });
        const temporaryPath = `${path}.${process.pid}.tmp`;
        await Fs.writeFile(temporaryPath, contents, { encoding: "utf8", mode });
        await Fs.chmod(temporaryPath, mode);
        await Fs.rename(temporaryPath, path);
      },
      catch: (error) => new Error(`Failed to write ${path}: ${messageFromUnknown(error)}`),
    }),
  buildBrowserWorker: (entrypoint, outputDirectory) =>
    Effect.tryPromise({
      try: async () => {
        const result = await Bun.build({
          entrypoints: [entrypoint],
          outdir: outputDirectory,
          naming: "worker.js",
          target: "browser",
          format: "esm",
        });
        if (result.success) return;
        throw new Error(result.logs.map((log) => log.message).join("\n"));
      },
      catch: (error) =>
        new Error(`Failed to build Chrome extension worker: ${messageFromUnknown(error)}`),
    }),
});

export interface ChromeNativeSetupOptions {
  readonly extensionSourceDirectory?: string;
  readonly extensionDirectory?: string;
  readonly nativeHostManifestPath?: string;
  readonly launcherPath?: string;
  readonly hostEntryPath?: string;
}

export interface ChromeExtensionBuildResult {
  readonly extensionDirectory: string;
  readonly extensionId: string;
}

export interface ChromeNativeInstallResult extends ChromeExtensionBuildResult {
  readonly nativeHostManifestPath: string;
  readonly launcherPath: string;
}

const resolveSetupPaths = (
  runtime: ChromeNativeSetupRuntimeShape,
  options: ChromeNativeSetupOptions,
) => {
  const extensionSourceDirectory =
    options.extensionSourceDirectory ?? runtime.joinPath(runtime.packageRoot, "extension");
  const shareDirectory = runtime.joinPath(runtime.homeDirectory, ".local", "share", "bookmarks");

  return {
    extensionSourceDirectory,
    extensionIconsSourcePath: runtime.joinPath(extensionSourceDirectory, "icons"),
    extensionManifestSourcePath: runtime.joinPath(extensionSourceDirectory, "manifest.json"),
    extensionWorkerSourcePath: runtime.joinPath(extensionSourceDirectory, "worker.ts"),
    extensionDirectory:
      options.extensionDirectory ?? runtime.joinPath(shareDirectory, "chrome-extension"),
    nativeHostManifestPath:
      options.nativeHostManifestPath ??
      runtime.joinPath(
        runtime.homeDirectory,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
        `${nativeHostName}.json`,
      ),
    launcherPath: options.launcherPath ?? runtime.joinPath(shareDirectory, nativeHostName),
    hostEntryPath:
      options.hostEntryPath ??
      runtime.joinPath(runtime.packageRoot, "src", "bin", "bookmarks-chrome-host.ts"),
  };
};

interface ExtensionManifest {
  readonly key?: unknown;
  readonly background?: { readonly service_worker?: unknown };
}

const parseAndValidateExtensionManifest = (contents: string): Effect.Effect<string, Error> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(contents);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Chrome extension manifest is not a JSON object");
      }
      const manifest: ExtensionManifest = parsed;
      if (manifest.key !== extensionPublicKey) {
        throw new Error(
          "Chrome extension manifest key does not match the setup key; refusing to change its extension ID",
        );
      }
      if (manifest.background?.service_worker !== "worker.js") {
        throw new Error(
          "Chrome extension manifest must use worker.js as its background service worker",
        );
      }
      return `${JSON.stringify(manifest, null, 2)}\n`;
    },
    catch: (error) => new Error(`Invalid Chrome extension manifest: ${messageFromUnknown(error)}`),
  });

export const buildChromeExtension = (
  options: ChromeNativeSetupOptions = {},
): Effect.Effect<ChromeExtensionBuildResult, Error, ChromeNativeSetupRuntimeShape> =>
  Effect.gen(function* () {
    const runtime = yield* ChromeNativeSetupRuntime;
    const paths = resolveSetupPaths(runtime, options);
    const sourceManifest = yield* runtime.readTextFile(paths.extensionManifestSourcePath);
    const normalizedManifest = yield* parseAndValidateExtensionManifest(sourceManifest);

    yield* runtime.ensurePrivateDirectory(paths.extensionDirectory);
    yield* runtime.buildBrowserWorker(paths.extensionWorkerSourcePath, paths.extensionDirectory);
    yield* runtime.copyPrivateDirectory(
      paths.extensionIconsSourcePath,
      runtime.joinPath(paths.extensionDirectory, "icons"),
    );
    yield* runtime.writeTextFile(
      runtime.joinPath(paths.extensionDirectory, "manifest.json"),
      normalizedManifest,
      0o600,
    );

    return {
      extensionDirectory: paths.extensionDirectory,
      extensionId,
    };
  });

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const launcherScriptFor = (bunExecutablePath: string, hostEntryPath: string): string =>
  `#!/bin/sh\nset -eu\nexec ${shellQuote(bunExecutablePath)} ${shellQuote(hostEntryPath)} "$@"\n`;

export const nativeHostManifestFor = (launcherPath: string) => ({
  name: nativeHostName,
  description: "Bookmarks CLI bridge for Chrome's bookmarks API",
  path: launcherPath,
  type: "stdio" as const,
  allowed_origins: [extensionOrigin],
});

export const installChromeNativeIntegration = (
  options: ChromeNativeSetupOptions = {},
): Effect.Effect<ChromeNativeInstallResult, Error, ChromeNativeSetupRuntimeShape> =>
  Effect.gen(function* () {
    const runtime = yield* ChromeNativeSetupRuntime;
    const paths = resolveSetupPaths(runtime, options);
    const extension = yield* buildChromeExtension(options);

    yield* runtime.writeTextFile(
      paths.launcherPath,
      launcherScriptFor(runtime.bunExecutablePath, paths.hostEntryPath),
      0o700,
    );
    yield* runtime.writeTextFile(
      paths.nativeHostManifestPath,
      `${JSON.stringify(nativeHostManifestFor(paths.launcherPath), null, 2)}\n`,
      0o600,
    );

    return {
      ...extension,
      nativeHostManifestPath: paths.nativeHostManifestPath,
      launcherPath: paths.launcherPath,
    };
  });
