// @light-fp adapter
import { attempt, err, ok, type Result } from "./result.ts";

type Writer = { readonly write: (bytes: Uint8Array) => Promise<number> };
type Reader = { readonly read: (bytes: Uint8Array) => Promise<number | null> };
const maximumMessageBytes = 4 * 1024 * 1024;

export const writeAll = async (
  writer: Writer,
  bytes: Uint8Array,
  zeroDiagnostic: string,
): Promise<Result<void>> => {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await attempt(() => writer.write(bytes.subarray(offset)));
    if (!written.ok) return written;
    if (written.value <= 0) return err(zeroDiagnostic);
    offset += written.value;
  }
  return ok(undefined);
};

export const sendJson = async (writer: Writer, value: unknown): Promise<Result<void>> => {
  const encoded = await attempt(() =>
    new TextEncoder().encode(JSON.stringify(value) + "\n")
  );
  if (!encoded.ok) return encoded;
  if (encoded.value.length > maximumMessageBytes) return err("IPC message exceeds 4 MiB");
  return await writeAll(writer, encoded.value, "IPC writer returned zero bytes");
};

export async function* readJson(reader: Reader): AsyncGenerator<Result<unknown>> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = new Uint8Array(32 * 1024);
  let pending = "";
  let pendingBytes = 0;
  while (true) {
    const next = await attempt(() => reader.read(buffer));
    if (!next.ok) {
      yield next;
      return;
    }
    if (next.value === null) {
      const flushed = await attempt(() => decoder.decode());
      if (!flushed.ok) yield flushed;
      else if (pendingBytes > 0) yield err("IPC closed before a complete message");
      return;
    }
    const count = next.value;
    const decoded = await attempt(() =>
      decoder.decode(buffer.subarray(0, count), { stream: true })
    );
    if (!decoded.ok) {
      yield decoded;
      return;
    }
    pendingBytes += count;
    pending += decoded.value;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const lineBytes = new TextEncoder().encode(line).length;
      if (lineBytes > maximumMessageBytes) {
        yield err("IPC message exceeds 4 MiB");
        return;
      }
      pendingBytes -= lineBytes + 1;
      const parsed = await attempt<unknown>(() => JSON.parse(line));
      yield parsed;
      if (!parsed.ok) return;
    }
    if (pendingBytes > maximumMessageBytes) {
      yield err("IPC message exceeds 4 MiB");
      return;
    }
  }
}
