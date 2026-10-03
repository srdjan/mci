import { readJson, sendJson } from "../src/ipc.ts";
import { assert, equal } from "./helpers.ts";

const reader = (bytes: Uint8Array) => {
  let offset = 0;
  return {
    read: (buffer: Uint8Array): Promise<number | null> => {
      if (offset === bytes.length) return Promise.resolve(null);
      const count = Math.min(buffer.length, bytes.length - offset);
      buffer.set(bytes.subarray(offset, offset + count));
      offset += count;
      return Promise.resolve(count);
    },
  };
};

Deno.test("IPC handles complete frames and rejects truncated UTF-8", async () => {
  const frames = await Array.fromAsync(
    readJson(reader(new TextEncoder().encode("{}\n[]\n"))),
  );
  equal(frames, [{ ok: true, value: {} }, { ok: true, value: [] }]);
  const partial = await Array.fromAsync(readJson(reader(new Uint8Array([0xe2, 0x82]))));
  assert(partial.length === 1 && !partial[0]!.ok);
});

Deno.test("IPC bounds unterminated input and outgoing frames", async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 1).fill(32);
  const frames = await Array.fromAsync(readJson(reader(bytes)));
  assert(frames.length === 1 && !frames[0]!.ok);
  let wrote = false;
  const result = await sendJson({
    write: (data) => {
      wrote = true;
      return Promise.resolve(data.length);
    },
  }, "x".repeat(bytes.length));
  assert(!result.ok && !wrote);
});
