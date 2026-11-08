import { Schema } from "effect";
import { BookmarkTree } from "./schema/__.ts";

export const protocolVersion = 1;
export const maxMessageBytes = 1_000_000;
export const InstanceIdSchema = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);
export const HelloSchema = Schema.Struct({
  type: Schema.Literal("hello"),
  version: Schema.Literal(protocolVersion),
  instanceId: InstanceIdSchema,
});
export const NativeRequestSchema = Schema.Union(
  Schema.Struct({ id: Schema.String, operation: Schema.Literal("snapshot") }),
  Schema.Struct({
    id: Schema.String,
    operation: Schema.Literal("reconcile"),
    expectedTree: BookmarkTree,
    tree: BookmarkTree,
  }),
);
export type NativeRequest = typeof NativeRequestSchema.Type;
export const NativeResponseSchema = Schema.Union(
  Schema.Struct({ id: Schema.String, ok: Schema.Literal(true), value: BookmarkTree }),
  Schema.Struct({ id: Schema.String, ok: Schema.Literal(false), error: Schema.String }),
);
export type NativeResponse = typeof NativeResponseSchema.Type;

/** Native messaging uses a length-prefixed JSON frame on Chrome's stdio pipe. */
export const encodeFrame = (value: unknown): Uint8Array => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > maxMessageBytes) throw new Error("Chrome bookmark message is too large.");
  const frame = new Uint8Array(4 + bytes.length);
  new DataView(frame.buffer).setUint32(0, bytes.length, true);
  frame.set(bytes, 4);
  return frame;
};

/** Handles fragmented and coalesced native messages without decoding partial UTF-8. */
export const makeFrameDecoder = () => {
  let pending = new Uint8Array(0);
  return (chunk: Uint8Array): unknown[] => {
    const combined = new Uint8Array(pending.length + chunk.length);
    combined.set(pending);
    combined.set(chunk, pending.length);
    pending = combined;
    const messages: unknown[] = [];
    while (pending.length >= 4) {
      const size = new DataView(pending.buffer, pending.byteOffset, 4).getUint32(0, true);
      if (size > maxMessageBytes) throw new Error("Chrome bookmark message is too large.");
      if (pending.length < size + 4) break;
      messages.push(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(4, size + 4))),
      );
      pending = pending.slice(size + 4);
    }
    return messages;
  };
};
