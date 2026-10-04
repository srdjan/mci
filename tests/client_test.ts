import { submit } from "../src/client.ts";
import { readJson, sendJson } from "../src/ipc.ts";
import { servicePaths } from "../src/paths.ts";
import type { Request, Terminal } from "../src/protocol.ts";
import { assert, equal, sleep } from "./helpers.ts";

type Submission = Extract<Request, { readonly op: "submit" }>;

const submission = (source = ""): Submission => ({
  version: 1,
  op: "submit",
  path: "/tmp/repository",
  workflow: "client.yml",
  job: "check",
  source,
  env: {},
});

const success = (log: string): Terminal => ({
  id: "request-1",
  repositoryId: "repository-1",
  workflow: "client.yml",
  job: "check",
  started: "2026-10-03T12:00:00.000Z",
  finished: "2026-10-03T12:00:01.000Z",
  kind: "success",
  code: 0,
  completed: 1,
  total: 1,
  detail: "",
  log,
});

const nextFrame = async (frames: ReturnType<typeof readJson>): Promise<unknown> => {
  const frame = await frames.next();
  assert(!frame.done && frame.value.ok);
  return frame.value.value;
};

const send = async (connection: Deno.UnixConn, value: unknown): Promise<void> => {
  const sent = await sendJson(connection, value);
  assert(sent.ok, sent.ok ? "" : sent.error);
};

const close = (connection: { close(): void }): void => {
  try {
    connection.close();
  } catch { /* Already closed. */ }
};

const withServer = async <T>(
  client: (directory: string) => Promise<T>,
  server: (connection: Deno.UnixConn, log: string) => Promise<void>,
): Promise<T> => {
  const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-c-" });
  const paths = servicePaths(directory);
  assert(paths.ok, paths.ok ? "" : paths.error);
  const log = `${directory}/request.log`;
  await Deno.writeTextFile(log, "");
  const listener = Deno.listen({ transport: "unix", path: paths.value.socket });
  const accepted = listener.accept();
  let connection: Deno.UnixConn | undefined;
  let clientRun: Promise<T> | undefined;
  let serverRun: Promise<void> | undefined;
  try {
    clientRun = client(directory);
    connection = await accepted;
    listener.close();
    serverRun = server(connection, log);
    const [result] = await Promise.all([clientRun, serverRun]);
    return result;
  } finally {
    if (connection !== undefined) close(connection);
    close(listener);
    const pending: Promise<unknown>[] = [];
    if (clientRun !== undefined) pending.push(clientRun);
    if (serverRun !== undefined) pending.push(serverRun);
    await Promise.allSettled(pending);
    await Deno.remove(directory, { recursive: true });
  }
};

const acceptanceError = (ms: number) =>
  `Acceptance deadline expired after ${ms} ms. Request completion is unknown. The request will not resume automatically.`;

const cancellationError = (ms: number) =>
  `Cancellation deadline expired after ${ms} ms. Request completion is unknown. The request will not resume automatically.`;

Deno.test("submission stops at the acceptance deadline when the daemon stays silent", async () => {
  const result = await withServer(
    (directory) =>
      submit(submission(), new AbortController().signal, directory, {
        acceptanceMs: 40,
        cancellationMs: 100,
      }),
    async (connection) => {
      await nextFrame(readJson(connection));
    },
  );
  assert(!result.ok);
  equal(result.error, acceptanceError(40));
});

Deno.test("submission cancellation stops waiting before acceptance", async () => {
  const read = Promise.withResolvers<void>();
  const controller = new AbortController();
  const result = await withServer(
    async (directory) => {
      const request = submit(submission(), controller.signal, directory, {
        acceptanceMs: 500,
        cancellationMs: 40,
      });
      await read.promise;
      controller.abort("SIGINT");
      return await request;
    },
    async (connection) => {
      const frames = readJson(connection);
      equal(await nextFrame(frames), submission());
      read.resolve();
      equal(await nextFrame(frames), { version: 1, op: "cancel", reason: "SIGINT" });
    },
  );
  assert(!result.ok);
  equal(result.error, cancellationError(40));
});

Deno.test("submission cancellation stops waiting after acceptance", async () => {
  const accepted = Promise.withResolvers<void>();
  const controller = new AbortController();
  const result = await withServer(
    async (directory) => {
      const request = submit(submission(), controller.signal, directory, {
        acceptanceMs: 40,
        cancellationMs: 40,
      });
      await accepted.promise;
      await sleep(80);
      controller.abort("SIGTERM");
      return await request;
    },
    async (connection, log) => {
      const frames = readJson(connection);
      await nextFrame(frames);
      await send(connection, { version: 1, type: "accepted", id: "request-1", log });
      accepted.resolve();
      equal(await nextFrame(frames), { version: 1, op: "cancel", reason: "SIGTERM" });
    },
  );
  assert(!result.ok);
  equal(result.error, cancellationError(40));
});

Deno.test("cancellation closes a blocked initial submission write", async () => {
  const controller = new AbortController();
  const completed = Promise.withResolvers<void>();
  const result = await withServer(
    async (directory) => {
      const request = submit(
        submission("x".repeat(1024 * 1024)),
        controller.signal,
        directory,
        { acceptanceMs: 500, cancellationMs: 40 },
      );
      await sleep(20);
      controller.abort("SIGINT");
      try {
        return await request;
      } finally {
        completed.resolve();
      }
    },
    async (connection) => {
      await completed.promise;
      const frame = await readJson(connection).next();
      assert(!frame.done && !frame.value.ok, "The initial write did not remain blocked");
      equal(frame.value.error, "IPC closed before a complete message");
    },
  );
  assert(!result.ok);
  equal(result.error, cancellationError(40));
});

Deno.test("cancellation follows one complete submission frame", async () => {
  const controller = new AbortController();
  const aborted = Promise.withResolvers<void>();
  controller.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
  const expected = submission("x".repeat(1024 * 1024));
  const result = await withServer(
    async (directory) => {
      const request = submit(expected, controller.signal, directory, {
        acceptanceMs: 500,
        cancellationMs: 200,
      });
      await sleep(20);
      controller.abort("SIGINT");
      return await request;
    },
    async (connection, log) => {
      await aborted.promise;
      const frames = readJson(connection);
      equal(await nextFrame(frames), expected);
      equal(await nextFrame(frames), { version: 1, op: "cancel", reason: "SIGINT" });
      await send(connection, { version: 1, type: "accepted", id: "request-1", log });
      await send(connection, { version: 1, type: "result", result: success(log) });
      equal(await frames.next(), { value: undefined, done: true });
    },
  );
  assert(result.ok, result.ok ? "" : result.error);
  equal(result.value, success(result.value.log));
});

Deno.test("accepted work can outlast acceptance and return success after cancellation", async () => {
  const accepted = Promise.withResolvers<void>();
  const controller = new AbortController();
  const result = await withServer(
    async (directory) => {
      const request = submit(submission(), controller.signal, directory, {
        acceptanceMs: 40,
        cancellationMs: 200,
      });
      await accepted.promise;
      await sleep(80);
      controller.abort("SIGTERM");
      return await request;
    },
    async (connection, log) => {
      const frames = readJson(connection);
      await nextFrame(frames);
      await send(connection, { version: 1, type: "accepted", id: "request-1", log });
      accepted.resolve();
      equal(await nextFrame(frames), { version: 1, op: "cancel", reason: "SIGTERM" });
      await send(connection, { version: 1, type: "result", result: success(log) });
    },
  );
  assert(result.ok, result.ok ? "" : result.error);
  equal(result.value.kind, "success");
});
