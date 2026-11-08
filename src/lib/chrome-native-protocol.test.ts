import { expect, test } from "bun:test";
import { encodeFrame, makeFrameDecoder, maxMessageBytes } from "./chrome-native-protocol.ts";

test("native frames preserve Unicode across arbitrary byte boundaries and multiple messages", () => {
  const values = [
    { title: "Montréal 🦊", url: "https://example.com" },
    { ok: true, count: 566 },
  ];
  const frames = values.map(encodeFrame);
  const decoder = makeFrameDecoder();
  const result: unknown[] = [];
  for (const frame of frames)
    for (const byte of frame) result.push(...decoder(new Uint8Array([byte])));
  expect(result).toEqual(values);
  const together = new Uint8Array(frames.reduce((size, frame) => size + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    together.set(frame, offset);
    offset += frame.length;
  }
  expect(makeFrameDecoder()(together)).toEqual(values);
});

test("native framing rejects oversized messages before buffering their payload", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, maxMessageBytes + 1, true);
  expect(() => makeFrameDecoder()(header)).toThrow("too large");
  expect(() => encodeFrame("x".repeat(maxMessageBytes))).toThrow("too large");
});
