import { expect, test } from "bun:test";
import * as Fs from "node:fs/promises";
import * as Net from "node:net";
import * as Path from "node:path";
import { encodeFrame, makeFrameDecoder } from "../lib/chrome-native-protocol.ts";
import { extensionOrigin } from "../lib/chrome-native-setup.ts";

test("native host routes a local request through the framed Chrome pipe and cleans up on disconnect", async () => {
  const directory = await Fs.mkdtemp("/tmp/bookmarks-host-");
  const instanceId = "12345678-1234-1234-1234-123456789abc";
  const path = Path.join(directory, "chrome", `${instanceId}.sock`);
  const child = Bun.spawn(
    [process.execPath, Path.join(import.meta.dir, "bookmarks-chrome-host.ts"), extensionOrigin],
    {
      env: { ...process.env, BOOKMARKS_RUNTIME_DIR: directory },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let socket: Net.Socket | undefined;
  try {
    await child.stdin.write(encodeFrame({ type: "hello", version: 1, instanceId }));
    await child.stdin.flush();
    const deadline = Date.now() + 3_000;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polls until the host has created its socket.
    while (!(await Fs.lstat(path).catch(() => undefined))) {
      if (Date.now() > deadline) throw new Error("Native host socket did not become ready.");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Polls until the host has created its socket.
      await Bun.sleep(10);
    }
    expect((await Fs.stat(path)).mode & 0o777).toBe(0o600);
    const received = new Promise<string>((resolve, reject) => {
      socket = Net.createConnection(path);
      socket.on("error", reject);
      socket.on("connect", () =>
        socket?.write(JSON.stringify({ id: "caller-id", operation: "snapshot" }) + "\n"),
      );
      let text = "";
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      socket.on("end", () => {
        resolve(text);
      });
    });
    const reader = child.stdout.getReader();
    const decode = makeFrameDecoder();
    let request: unknown;
    while (request === undefined) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Frames arrive one stream chunk at a time.
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Native host ended early.");
      request = decode(chunk.value)[0];
    }
    expect(request).toEqual({ id: "1", operation: "snapshot" });
    const tree = { bar: [{ _tag: "BookmarkLeaf", name: "Montréal", url: "https://example.com/" }] };
    await child.stdin.write(encodeFrame({ id: "1", ok: true, value: tree }));
    await child.stdin.flush();
    expect(JSON.parse(await received)).toEqual({ id: "caller-id", ok: true, value: tree });
    await child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await Fs.lstat(path).catch(() => undefined)).toBeUndefined();
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    socket?.destroy();
    child.kill();
    await child.exited;
    await Fs.rm(directory, { recursive: true, force: true });
  }
}, 10_000);

test("native host rejects an unrelated extension origin", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      Path.join(import.meta.dir, "bookmarks-chrome-host.ts"),
      "chrome-extension://untrusted/",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stdout).text()).toBe("");
});
