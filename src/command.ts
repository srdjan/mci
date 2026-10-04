// @light-fp adapter
import { attempt, err, ok, type Result } from "./result.ts";

export type CommandCapture = {
  readonly status: Deno.CommandStatus;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};

export type CommandCapturePolicy = {
  readonly timeoutMs: number;
  readonly reapMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
};

type CaptureStream = "stdout" | "stderr";

type StreamCapture =
  | { readonly kind: "captured"; readonly output: Uint8Array }
  | { readonly kind: "overflow"; readonly limit: number };

type CaptureCompletion =
  | {
    readonly kind: "complete";
    readonly status: Result<Deno.CommandStatus>;
    readonly stdout: Result<StreamCapture>;
    readonly stderr: Result<StreamCapture>;
  }
  | { readonly kind: "overflow"; readonly stream: CaptureStream; readonly limit: number };

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

const readBounded = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
): Promise<StreamCapture> => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > limit - length) {
        return { kind: "overflow", limit };
      }
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "captured", output };
};

const overflowDiagnostic = (
  command: string,
  stream: CaptureStream,
  limit: number,
): string => `Command ${command} ${stream} exceeded ${limit} byte capture limit`;

const validateLimit = (
  command: string,
  stream: CaptureStream,
  limit: number,
): Result<void> =>
  Number.isSafeInteger(limit) && limit >= 0 ? ok(undefined) : err(
    `Command ${command} ${stream} capture limit must be a nonnegative safe integer: ${limit}`,
  );

const waitForOverflow = async (
  stream: CaptureStream,
  output: Observed<StreamCapture>,
): Promise<CaptureCompletion> => {
  const result = await output.completed;
  if (result.ok && result.value.kind === "overflow") {
    return { kind: "overflow", stream, limit: result.value.limit };
  }
  return await new Promise<CaptureCompletion>(() => undefined);
};

const completedCapture = async (
  status: Observed<Deno.CommandStatus>,
  stdout: Observed<StreamCapture>,
  stderr: Observed<StreamCapture>,
): Promise<CaptureCompletion> => {
  const [finished, capturedStdout, capturedStderr] = await Promise.all([
    status.completed,
    stdout.completed,
    stderr.completed,
  ]);
  if (capturedStdout.ok && capturedStdout.value.kind === "overflow") {
    return { kind: "overflow", stream: "stdout", limit: capturedStdout.value.limit };
  }
  if (capturedStderr.ok && capturedStderr.value.kind === "overflow") {
    return { kind: "overflow", stream: "stderr", limit: capturedStderr.value.limit };
  }
  return {
    kind: "complete",
    status: finished,
    stdout: capturedStdout,
    stderr: capturedStderr,
  };
};

/** Run a command with bounded output capture and process reaping. */
export const captureCommand = async (
  command: string,
  options: Omit<Deno.CommandOptions, "stdin" | "stdout" | "stderr">,
  policy: CommandCapturePolicy,
): Promise<Result<CommandCapture>> => {
  const validStdout = validateLimit(command, "stdout", policy.maxStdoutBytes);
  if (!validStdout.ok) return validStdout;
  const validStderr = validateLimit(command, "stderr", policy.maxStderrBytes);
  if (!validStderr.ok) return validStderr;

  const spawned = await attempt(() =>
    new Deno.Command(command, {
      ...options,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn()
  );
  if (!spawned.ok) return err(`Unable to launch command ${command}: ${spawned.error}`);

  const child = spawned.value;
  const stdoutPipe = child.stdout;
  const stderrPipe = child.stderr;
  const stdoutReader = stdoutPipe.getReader();
  const stderrReader = stderrPipe.getReader();
  const status = observe(child.status);
  const stdout = observe(readBounded(stdoutReader, policy.maxStdoutBytes));
  const stderr = observe(readBounded(stderrReader, policy.maxStderrBytes));
  const captured = await waitBounded(
    Promise.race([
      completedCapture(status, stdout, stderr),
      waitForOverflow("stdout", stdout),
      waitForOverflow("stderr", stderr),
    ]),
    policy.timeoutMs,
  );
  if (captured.kind === "settled" && captured.value.kind === "complete") {
    const finished = captured.value.status;
    const capturedStdout = captured.value.stdout;
    const capturedStderr = captured.value.stderr;
    const diagnostics: string[] = [];
    if (!finished.ok) {
      diagnostics.push(`Command ${command} status failed: ${finished.error}`);
    }
    if (!capturedStdout.ok) {
      diagnostics.push(`Command ${command} stdout failed: ${capturedStdout.error}`);
    }
    if (!capturedStderr.ok) {
      diagnostics.push(`Command ${command} stderr failed: ${capturedStderr.error}`);
    }
    if (!finished.ok || !capturedStdout.ok || !capturedStderr.ok) {
      return err(diagnostics.join("\n"));
    }
    if (
      capturedStdout.value.kind !== "captured" ||
      capturedStderr.value.kind !== "captured"
    ) {
      return err(`Command ${command} capture ended in an invalid state`);
    }
    return ok({
      status: finished.value,
      stdout: capturedStdout.value.output,
      stderr: capturedStderr.value.output,
    });
  }

  let overflow: Extract<CaptureCompletion, { readonly kind: "overflow" }> | null = null;
  const diagnostics: string[] = [];
  if (captured.kind === "timeout") {
    diagnostics.push(`Command ${command} timed out after ${policy.timeoutMs} ms`);
  } else if (captured.value.kind === "overflow") {
    overflow = captured.value;
    diagnostics.push(overflowDiagnostic(command, overflow.stream, overflow.limit));
  } else {
    return err(`Command ${command} cleanup started without a timeout or overflow`);
  }
  const statusCurrent = status.current();
  const stdoutCurrent = stdout.current();
  const stderrCurrent = stderr.current();
  if (statusCurrent !== null && !statusCurrent.ok) {
    diagnostics.push(`Command ${command} status failed: ${statusCurrent.error}`);
  }
  if (stdoutCurrent !== null && !stdoutCurrent.ok) {
    diagnostics.push(`Command ${command} stdout failed: ${stdoutCurrent.error}`);
  }
  if (stderrCurrent !== null && !stderrCurrent.ok) {
    diagnostics.push(`Command ${command} stderr failed: ${stderrCurrent.error}`);
  }
  if (
    stdoutCurrent !== null && stdoutCurrent.ok &&
    stdoutCurrent.value.kind === "overflow" &&
    overflow?.stream !== "stdout"
  ) {
    diagnostics.push(overflowDiagnostic(command, "stdout", stdoutCurrent.value.limit));
  }
  if (
    stderrCurrent !== null && stderrCurrent.ok &&
    stderrCurrent.value.kind === "overflow" &&
    overflow?.stream !== "stderr"
  ) {
    diagnostics.push(overflowDiagnostic(command, "stderr", stderrCurrent.value.limit));
  }

  if (statusCurrent === null || !statusCurrent.ok) {
    const killed = await attempt(() => child.kill("SIGKILL"));
    if (!killed.ok) {
      diagnostics.push(`Command ${command} SIGKILL failed: ${killed.error}`);
    }
  }
  const closeReason = overflow === null
    ? "command capture timed out"
    : "command capture exceeded a byte limit";
  const closeOutput = (
    current: Result<StreamCapture> | null,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    stream: ReadableStream<Uint8Array>,
  ): Observed<void> => {
    if (stream.locked) return track(attempt(() => reader.cancel(closeReason)));
    if (current === null || (current.ok && current.value.kind === "overflow")) {
      return track(attempt(() => stream.cancel(closeReason)));
    }
    return track(Promise.resolve(ok(undefined)));
  };
  const closingStdout = closeOutput(stdoutCurrent, stdoutReader, stdoutPipe);
  const closingStderr = closeOutput(stderrCurrent, stderrReader, stderrPipe);
  const [reaped, closedStdout, closedStderr] = await Promise.all([
    waitBounded(status.completed, policy.reapMs),
    waitBounded(
      Promise.all([closingStdout.completed, stdout.completed]),
      policy.reapMs,
    ),
    waitBounded(
      Promise.all([closingStderr.completed, stderr.completed]),
      policy.reapMs,
    ),
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

  const diagnoseClose = (
    name: "stdout" | "stderr",
    closed: Bounded<readonly [Result<void>, Result<StreamCapture>]>,
    closing: Observed<void>,
    output: Observed<StreamCapture>,
    outputCurrent: Result<StreamCapture> | null,
  ): void => {
    if (closed.kind === "timeout") {
      const cancelCurrent = closing.current();
      const readCurrent = output.current();
      if (cancelCurrent !== null && !cancelCurrent.ok) {
        diagnostics.push(
          `Command ${command} ${name} close failed: ${cancelCurrent.error}`,
        );
      }
      if (readCurrent !== null && !readCurrent.ok) {
        diagnostics.push(`Command ${command} ${name} failed: ${readCurrent.error}`);
      }
      diagnostics.push(
        `Command ${command} ${name} close timed out after ${policy.reapMs} ms`,
      );
      return;
    }
    const [cancelled, read] = closed.value;
    if (!cancelled.ok) {
      diagnostics.push(`Command ${command} ${name} close failed: ${cancelled.error}`);
    }
    if (!read.ok && outputCurrent === null) {
      diagnostics.push(`Command ${command} ${name} failed: ${read.error}`);
    }
  };

  diagnoseClose(
    "stdout",
    closedStdout,
    closingStdout,
    stdout,
    stdoutCurrent,
  );
  diagnoseClose(
    "stderr",
    closedStderr,
    closingStderr,
    stderr,
    stderrCurrent,
  );

  if (!didReap) {
    const released = await attempt(() => child.unref());
    if (!released.ok) {
      diagnostics.push(`Command ${command} release failed: ${released.error}`);
    }
  }
  return err(diagnostics.join("\n"));
};
