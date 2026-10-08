import { readJson, sendJson, writeAll } from "../src/ipc.ts";
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

Deno.test("IPC complete writes handle short writes and empty input", async () => {
  const output: number[] = [];
  const result = await writeAll(
    {
      write: (bytes) => {
        const count = Math.min(bytes.length, 2);
        output.push(...bytes.subarray(0, count));
        return Promise.resolve(count);
      },
    },
    new Uint8Array([1, 2, 3, 4, 5]),
    "writer stopped",
  );
  equal(result, { ok: true, value: undefined });
  equal(output, [1, 2, 3, 4, 5]);

  let writes = 0;
  const empty = await writeAll(
    {
      write: () => {
        writes++;
        return Promise.resolve(0);
      },
    },
    new Uint8Array(),
    "writer stopped",
  );
  equal(empty, { ok: true, value: undefined });
  equal(writes, 0);
});

Deno.test("IPC complete writes preserve zero diagnostics and write errors", async () => {
  for (const count of [0, -1]) {
    const stopped = await writeAll(
      { write: () => Promise.resolve(count) },
      new Uint8Array([1]),
      "exact zero diagnostic",
    );
    equal(stopped, { ok: false, error: "exact zero diagnostic" });
  }
  const failed = await writeAll(
    {
      write: () => {
        throw new Error("write failed");
      },
    },
    new Uint8Array([1]),
    "unused diagnostic",
  );
  equal(failed, { ok: false, error: "write failed" });

  const ipc = await sendJson({ write: () => Promise.resolve(0) }, {});
  equal(ipc, { ok: false, error: "IPC writer returned zero bytes" });
});

Deno.test("IPC sends complete JSON frames through short writes", async () => {
  const output: number[] = [];
  const counts: number[] = [];
  const sent = await sendJson({
    write: (bytes) => {
      const count = Math.min(bytes.length, 2);
      counts.push(count);
      output.push(...bytes.subarray(0, count));
      return Promise.resolve(count);
    },
  }, { ok: true });
  equal(sent, { ok: true, value: undefined });
  equal(counts, [2, 2, 2, 2, 2, 2]);
  equal(output, Array.from(new TextEncoder().encode('{"ok":true}\n')));

  const negative = await sendJson({ write: () => Promise.resolve(-1) }, null);
  equal(negative, { ok: false, error: "IPC writer returned zero bytes" });
  const failed = await sendJson({
    write: () => {
      throw new Error("IPC write failed");
    },
  }, null);
  equal(failed, { ok: false, error: "IPC write failed" });
});

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
