// @light-fp adapter
import { readJson, sendJson } from "./ipc.ts";
import { servicePaths } from "./paths.ts";
import {
  decodeResponse,
  type Request,
  type Snapshot,
  type Terminal,
} from "./protocol.ts";
import { attempt, err, ok, type Result } from "./result.ts";

const connect = async (home?: string): Promise<Result<Deno.UnixConn>> => {
  const paths = servicePaths(home);
  if (!paths.ok) return paths;
  const connection = await attempt(() =>
    Deno.connect({ transport: "unix", path: paths.value.socket })
  );
  return connection.ok ? connection : err(
    `Daemon unavailable: ${connection.error}. Run mci setup, or start mci daemon for development.`,
  );
};

export const rpc = async (request: Request, home?: string): Promise<Result<Snapshot>> => {
  const connected = await connect(home);
  if (!connected.ok) return connected;
  const conn = connected.value;
  const timer = setTimeout(() => {
    try {
      conn.close();
    } catch { /* Already closed. */ }
  }, 5000);
  try {
    const sent = await sendJson(conn, request);
    if (!sent.ok) return sent;
    for await (const received of readJson(conn)) {
      if (!received.ok) return received;
      const decoded = decodeResponse(received.value);
      if (!decoded.ok) return decoded;
      if (decoded.value.type === "error") {
        return err(`${decoded.value.tag}: ${decoded.value.detail}`);
      }
      if (decoded.value.type !== "ok") return err("Unexpected daemon response");
      return ok(decoded.value.snapshot);
    }
    return err("Daemon closed before replying");
  } finally {
    clearTimeout(timer);
    try {
      conn.close();
    } catch { /* Already closed. */ }
  }
};

const writeTerminal = async (bytes: Uint8Array): Promise<Result<void>> => {
  let rest = bytes;
  while (rest.length > 0) {
    const written = await attempt(() => Deno.stdout.write(rest));
    if (!written.ok) return written;
    if (written.value <= 0) return err("Terminal writer returned zero bytes");
    rest = rest.subarray(written.value);
  }
  return ok(undefined);
};

export type SubmissionPolicy = {
  readonly acceptanceMs?: number;
  readonly cancellationMs?: number;
};

const nativeSubmissionPolicy = {
  acceptanceMs: 5000,
  cancellationMs: 10000,
};

/** Tail this request's spool. The server never waits for terminal output. */
const tailRequest = async (
  path: string,
  finished: () => boolean,
): Promise<Result<void>> => {
  const opened = await attempt(async () => {
    const info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink) return err("Request log is not a regular file");
    return ok(await Deno.open(path, { read: true }));
  });
  if (!opened.ok) return opened;
  if (!opened.value.ok) return opened.value;
  const file = opened.value.value;
  const buffer = new Uint8Array(32 * 1024);
  try {
    while (true) {
      const read = await attempt(() => file.read(buffer));
      if (!read.ok) return read;
      if (read.value !== null) {
        const sent = await writeTerminal(buffer.subarray(0, read.value));
        if (!sent.ok) return sent;
      } else if (finished()) return ok(undefined);
      else await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    file.close();
  }
};

export const submit = async (
  request: Extract<Request, { readonly op: "submit" }>,
  signal: AbortSignal,
  home?: string,
  policy: SubmissionPolicy = {},
): Promise<Result<Terminal>> => {
  const connected = await connect(home);
  if (!connected.ok) return connected;
  const conn = connected.value;
  const acceptanceMs = policy.acceptanceMs ?? nativeSubmissionPolicy.acceptanceMs;
  const cancellationMs = policy.cancellationMs ?? nativeSubmissionPolicy.cancellationMs;
  let completed = false;
  let tail: Promise<Result<void>> | undefined;
  let cancelled = false;
  let requestWritten = false;
  let cancellationWrite: Promise<Result<void>> | undefined;
  let deadlineError: string | undefined;
  let writeError: string | undefined;
  let acceptanceTimer: ReturnType<typeof setTimeout> | undefined;
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;

  const close = () => {
    try {
      conn.close();
    } catch { /* Already closed. */ }
  };
  const clearAcceptance = () => {
    clearTimeout(acceptanceTimer);
    acceptanceTimer = undefined;
  };
  const clearTimers = () => {
    clearAcceptance();
    clearTimeout(cancellationTimer);
    cancellationTimer = undefined;
  };
  const expire = (error: string) => {
    deadlineError ??= error;
    close();
  };
  const sendCancellation = (): void => {
    if (!cancelled || !requestWritten || cancellationWrite !== undefined) return;
    cancellationWrite = sendJson(conn, {
      version: 1,
      op: "cancel",
      reason: signal.reason === "SIGINT" ? "SIGINT" : "SIGTERM",
    }).then((sent) => {
      if (!sent.ok) {
        writeError ??= sent.error;
        close();
      }
      return sent;
    });
  };
  const cancel = () => {
    if (cancelled || completed) return;
    cancelled = true;
    clearAcceptance();
    cancellationTimer = setTimeout(
      () =>
        expire(
          `Cancellation deadline expired after ${cancellationMs} ms. Request completion is unknown. The request will not resume automatically.`,
        ),
      cancellationMs,
    );
    sendCancellation();
  };
  acceptanceTimer = setTimeout(
    () =>
      expire(
        `Acceptance deadline expired after ${acceptanceMs} ms. Request completion is unknown. The request will not resume automatically.`,
      ),
    acceptanceMs,
  );
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const sent = await sendJson(conn, request);
    if (!sent.ok) return err(deadlineError ?? sent.error);
    requestWritten = true;
    sendCancellation();
    for await (const received of readJson(conn)) {
      if (!received.ok) return err(deadlineError ?? writeError ?? received.error);
      const decoded = decodeResponse(received.value);
      if (!decoded.ok) return decoded;
      const response = decoded.value;
      switch (response.type) {
        case "error":
          return err(`${response.tag}: ${response.detail}`);
        case "ok":
          return err("Unexpected response to submission");
        case "accepted":
          clearAcceptance();
          if (tail !== undefined) return err("Duplicate acceptance");
          tail = tailRequest(response.log, () => completed);
          void tail.then((result) => {
            if (!result.ok) {
              cancelled = true;
              close();
            }
          });
          break;
        case "result": {
          clearTimers();
          completed = true;
          if (tail === undefined) return err("Result arrived without acceptance");
          const drained = await tail;
          if (!drained.ok) return drained;
          return ok(response.result);
        }
      }
    }
    if (deadlineError !== undefined) return err(deadlineError);
    if (writeError !== undefined) return err(writeError);
    return err(
      "Daemon connection closed before a result. The request will not resume automatically.",
    );
  } finally {
    completed = true;
    clearTimers();
    signal.removeEventListener("abort", cancel);
    close();
    if (cancellationWrite !== undefined) await cancellationWrite;
    if (tail !== undefined) await tail;
  }
};
