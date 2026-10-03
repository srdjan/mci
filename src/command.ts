import { attempt, err, ok, type Result } from "./result.ts";

export type CommandCapture = {
  readonly status: Deno.CommandStatus;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
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

/** Run a command with bounded output capture and process reaping. */
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
      stderr: "piped",
    }).spawn()
  );
  if (!spawned.ok) return err(`Unable to launch command ${command}: ${spawned.error}`);

  const child = spawned.value;
  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  const status = observe(child.status);
  const stdout = observe(readAll(stdoutReader));
  const stderr = observe(readAll(stderrReader));
  const captured = await waitBounded(
    Promise.all([status.completed, stdout.completed, stderr.completed]),
    policy.timeoutMs,
  );
  if (captured.kind === "settled") {
    const [finished, capturedStdout, capturedStderr] = captured.value;
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
    return ok({
      status: finished.value,
      stdout: capturedStdout.value,
      stderr: capturedStderr.value,
    });
  }

  const diagnostics = [`Command ${command} timed out after ${policy.timeoutMs} ms`];
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

  if (statusCurrent === null || !statusCurrent.ok) {
    const killed = await attempt(() => child.kill("SIGKILL"));
    if (!killed.ok) {
      diagnostics.push(`Command ${command} SIGKILL failed: ${killed.error}`);
    }
  }
  const closingStdout = track(
    stdoutCurrent === null
      ? attempt(() => stdoutReader.cancel("command capture timed out"))
      : Promise.resolve(ok(undefined)),
  );
  const closingStderr = track(
    stderrCurrent === null
      ? attempt(() => stderrReader.cancel("command capture timed out"))
      : Promise.resolve(ok(undefined)),
  );
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
    closed: Bounded<readonly [Result<void>, Result<Uint8Array>]>,
    closing: Observed<void>,
    output: Observed<Uint8Array>,
    outputCurrent: Result<Uint8Array> | null,
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
