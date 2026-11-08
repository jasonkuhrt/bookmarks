#!/usr/bin/env bun

import { Console, Effect } from "effect";
import {
  buildChromeExtension,
  ChromeNativeSetupRuntimeLive,
} from "../src/lib/chrome-native-setup.ts";

const program = Effect.gen(function* () {
  const outputDirectory = process.argv[2];
  const result = yield* buildChromeExtension(
    outputDirectory === undefined ? {} : { extensionDirectory: outputDirectory },
  );
  yield* Console.log(
    JSON.stringify(
      {
        extensionDirectory: result.extensionDirectory,
        extensionId: result.extensionId,
      },
      null,
      2,
    ),
  );
}).pipe(Effect.provide(ChromeNativeSetupRuntimeLive));

await Effect.runPromise(program);
