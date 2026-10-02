import { attempt, err, ok, type Result } from "./result.ts";

export type CommandCapture = {
  readonly status: Deno.CommandStatus;
  readonly stdout: Uint8Array;
};

export type CommandCapturePolicy = {
  readonly timeoutMs: number;
  readonly reapMs: number;
};

type Bounded<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "timeout" };

type Observed<T> = {
  readonly completed: Promise<Result<T>>;
  readonly current: () => Result<T> | null;
};

const waitBounded = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<Bounded<T>> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Bounded<T>>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value): Bounded<T> => ({ kind: "settled", value })),
      expired,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const track = <T>(completed: Promise<Result<T>>): Observed<T> => {
  let current: Result<T> | null = null;
  const tracked = completed.then((result) => {
    current = result;
    return result;
  });
  return { completed: tracked, current: () => current };
};

const observe = <T>(promise: Promise<T>): Observed<T> => track(attempt(() => promise));

const readAll = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
};

/** Run a command with bounded standard-output capture and process reaping. */
export const captureCommand = async (
  command: string,
  options: Omit<Deno.CommandOptions, "stdin" | "stdout" | "stderr">,
  policy: CommandCapturePolicy,
): Promise<Result<CommandCapture>> => {
  const spawned = await attempt(() =>
    new Deno.Command(command, {
      ...options,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn()
  );
  if (!spawned.ok) return err(`Unable to launch command ${command}: ${spawned.error}`);

  const child = spawned.value;
  const reader = child.stdout.getReader();
  const status = observe(child.status);
  const output = observe(readAll(reader));
  const captured = await waitBounded(
    Promise.all([status.completed, output.completed]),
    policy.timeoutMs,
  );
  if (captured.kind === "settled") {
    const [finished, read] = captured.value;
    const diagnostics: string[] = [];
    if (!finished.ok) {
      diagnostics.push(`Command ${command} status failed: ${finished.error}`);
    }
    if (!read.ok) diagnostics.push(`Command ${command} stdout failed: ${read.error}`);
    if (!finished.ok || !read.ok) return err(diagnostics.join("\n"));
    return ok({ status: finished.value, stdout: read.value });
  }

  const diagnostics = [`Command ${command} timed out after ${policy.timeoutMs} ms`];
  const statusCurrent = status.current();
  const outputCurrent = output.current();
  if (statusCurrent !== null && !statusCurrent.ok) {
    diagnostics.push(`Command ${command} status failed: ${statusCurrent.error}`);
  }
  if (outputCurrent !== null && !outputCurrent.ok) {
    diagnostics.push(`Command ${command} stdout failed: ${outputCurrent.error}`);
  }

  if (statusCurrent === null || !statusCurrent.ok) {
    const killed = await attempt(() => child.kill("SIGKILL"));
    if (!killed.ok) {
      diagnostics.push(`Command ${command} SIGKILL failed: ${killed.error}`);
    }
  }
  const closing = track(
    outputCurrent === null
      ? attempt(() => reader.cancel("command capture timed out"))
      : Promise.resolve(ok(undefined)),
  );
  const [reaped, closed] = await Promise.all([
    waitBounded(status.completed, policy.reapMs),
    waitBounded(Promise.all([closing.completed, output.completed]), policy.reapMs),
  ]);

  let didReap = false;
  if (reaped.kind === "timeout") {
    diagnostics.push(`Command ${command} reaping timed out after ${policy.reapMs} ms`);
  } else if (!reaped.value.ok) {
    if (statusCurrent === null) {
      diagnostics.push(`Command ${command} status failed: ${reaped.value.error}`);
    }
  } else {
    didReap = true;
  }

  if (closed.kind === "timeout") {
    const cancelCurrent = closing.current();
    const readCurrent = output.current();
    if (cancelCurrent !== null && !cancelCurrent.ok) {
      diagnostics.push(`Command ${command} stdout close failed: ${cancelCurrent.error}`);
    }
    if (readCurrent !== null && !readCurrent.ok) {
      diagnostics.push(`Command ${command} stdout failed: ${readCurrent.error}`);
    }
    diagnostics.push(
      `Command ${command} stdout close timed out after ${policy.reapMs} ms`,
    );
  } else {
    const [cancelled, read] = closed.value;
    if (!cancelled.ok) {
      diagnostics.push(`Command ${command} stdout close failed: ${cancelled.error}`);
    }
    if (!read.ok && outputCurrent === null) {
      diagnostics.push(`Command ${command} stdout failed: ${read.error}`);
    }
  }

  if (!didReap) {
    const released = await attempt(() => child.unref());
    if (!released.ok) {
      diagnostics.push(`Command ${command} release failed: ${released.error}`);
    }
  }
  return err(diagnostics.join("\n"));
};
