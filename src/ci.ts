// @light-fp adapter
import { inspectProcessIdentity } from "./process.ts";
import { attempt, err, ok, type Result } from "./result.ts";

export type LoggerIdentity = {
  readonly started: string;
  readonly command: string;
};

export type CiStatus = {
  readonly version: 1;
  readonly logger: LoggerIdentity | null;
  readonly state: "running" | "pass" | "fail" | "cancelled";
  readonly pid: number;
  readonly started: string;
  readonly finished: string | null;
  readonly code: number | null;
};

export type LoggedCiResult = {
  readonly code: number;
  readonly diagnostics: readonly string[];
};

export type RunLoggedCiOptions = {
  readonly workspace: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly stdout?: (chunk: Uint8Array) => void | Promise<void>;
  readonly stderr?: (chunk: Uint8Array) => void | Promise<void>;
};

const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ciState = (value: unknown): value is CiStatus["state"] =>
  value === "running" || value === "pass" || value === "fail" ||
  value === "cancelled";

const timestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const decodeLogger = (value: unknown): Result<LoggerIdentity | null> => {
  if (value === undefined || value === null) return ok(null);
  if (
    !object(value) || Object.keys(value).length !== 2 ||
    typeof value.started !== "string" || value.started.length !== 24 ||
    typeof value.command !== "string" || value.command.length === 0
  ) return err("invalid CI logger identity");
  return ok({ started: value.started, command: value.command });
};

const decodeStatus = (value: unknown): Result<CiStatus> => {
  if (
    !object(value) ||
    (Object.keys(value).length !== 6 &&
      (Object.keys(value).length !== 7 || !Object.hasOwn(value, "logger"))) ||
    value.version !== 1 ||
    !ciState(value.state) || typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 || !timestamp(value.started)
  ) return err("invalid CI status shape");

  const logger = decodeLogger(value.logger);
  if (!logger.ok) return logger;

  if (value.state === "running") {
    if (value.finished !== null || value.code !== null) {
      return err("invalid CI status state");
    }
    return ok({
      version: 1,
      logger: logger.value,
      state: value.state,
      pid: value.pid,
      started: value.started,
      finished: null,
      code: null,
    });
  }
  if (
    !timestamp(value.finished) || typeof value.code !== "number" ||
    !Number.isSafeInteger(value.code) || value.code < 0
  ) return err("invalid CI status state");
  const finished = value.finished;
  const code = value.code;
  if (
    value.state === "pass" && code !== 0 ||
    (value.state === "fail" || value.state === "cancelled") && code === 0
  ) return err("invalid CI status exit code");

  return ok({
    version: 1,
    logger: logger.value,
    state: value.state,
    pid: value.pid,
    started: value.started,
    finished,
    code,
  });
};

export const readCiStatus = async (
  workspace: string,
): Promise<Result<CiStatus | null>> => {
  const path = `${workspace.replace(/\/$/, "")}/.mci/ci/status.json`;
  const found = await metadata(path);
  if (!found.ok) return found;
  if (found.value === null) return ok(null);
  if (!found.value.isFile || found.value.isSymlink) {
    return err("CI status must be a real file");
  }
  const parsed = await attempt(async (): Promise<unknown> =>
    JSON.parse(await Deno.readTextFile(path))
  );
  if (!parsed.ok) return err(`invalid CI status JSON: ${parsed.error}`);
  return decodeStatus(parsed.value);
};

const metadata = async (path: string): Promise<Result<Deno.FileInfo | null>> => {
  try {
    return ok(await Deno.lstat(path));
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? ok(null) : err(String(error));
  }
};

const makeDirectory = async (path: string): Promise<Result<void>> => {
  try {
    await Deno.mkdir(path, { mode: 0o700 });
    return ok(undefined);
  } catch (error) {
    return error instanceof Deno.errors.AlreadyExists
      ? ok(undefined)
      : err(String(error));
  }
};

const ensureDirectory = async (path: string): Promise<Result<void>> => {
  const made = await makeDirectory(path);
  if (!made.ok) return made;
  const found = await metadata(path);
  if (!found.ok) return found;
  if (found.value === null) return err(`${path} was not created`);
  if (!found.value.isDirectory || found.value.isSymlink) {
    return err(`${path} must be a real directory`);
  }
  return await attempt(() => Deno.chmod(path, 0o700));
};

const prepareState = async (
  workspace: string,
): Promise<Result<{ readonly root: string; readonly directory: string }>> => {
  const resolved = await attempt(async () => {
    const root = await Deno.realPath(workspace);
    const found = await Deno.stat(root);
    return found.isDirectory ? ok(root) : err("workspace is not a directory");
  });
  if (!resolved.ok) return resolved;
  if (!resolved.value.ok) return resolved.value;
  const root = resolved.value.value.replace(/\/$/, "");
  const state = `${root}/.mci`;
  const stateReady = await ensureDirectory(state);
  if (!stateReady.ok) return stateReady;
  const directory = `${state}/ci`;
  const directoryReady = await ensureDirectory(directory);
  return directoryReady.ok ? ok({ root, directory }) : directoryReady;
};

const writeStatus = async (
  directory: string,
  status: CiStatus,
): Promise<Result<void>> => {
  const temporary = await attempt(() =>
    Deno.makeTempFile({ dir: directory, prefix: ".status-" })
  );
  if (!temporary.ok) return temporary;
  const written = await attempt(async () => {
    await Deno.writeTextFile(temporary.value, JSON.stringify(status));
    await Deno.chmod(temporary.value, 0o600);
    await Deno.rename(temporary.value, `${directory}/status.json`);
  });
  if (written.ok) return written;
  const removed = await attempt(() => Deno.remove(temporary.value));
  return err(
    `${written.error}${
      removed.ok ? "" : `; status temporary cleanup failed: ${removed.error}`
    }`,
  );
};

const createLog = async (directory: string): Promise<Result<Deno.FsFile>> => {
  const temporary = `${directory}/.log-${crypto.randomUUID()}`;
  const opened = await attempt(() =>
    Deno.open(temporary, { createNew: true, write: true, mode: 0o600 })
  );
  if (!opened.ok) return opened;
  const prepared = await attempt(async () => {
    await Deno.chmod(temporary, 0o600);
    await Deno.rename(temporary, `${directory}/latest.log`);
  });
  if (prepared.ok) return opened;
  const closed = await attempt(() => opened.value.close());
  const removed = await attempt(() => Deno.remove(temporary));
  return err([
    prepared.error,
    ...(closed.ok ? [] : [`log cleanup failed: ${closed.error}`]),
    ...(removed.ok ? [] : [`temporary log cleanup failed: ${removed.error}`]),
  ].join("; "));
};

const writeBytes = async (
  file: Deno.FsFile,
  bytes: Uint8Array,
): Promise<Result<void>> => {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await attempt(() => file.write(bytes.subarray(offset)));
    if (!written.ok) return written;
    if (written.value === 0) return err("log write returned zero bytes");
    offset += written.value;
  }
  return ok(undefined);
};

const interruption = (
  reason: unknown,
): { readonly signal: Deno.Signal; readonly code: number } =>
  reason === "SIGINT"
    ? { signal: "SIGINT", code: 130 }
    : { signal: "SIGTERM", code: 143 };

const signalChild = (
  child: Deno.ChildProcess,
  signal: Deno.Signal,
): Result<void> => {
  try {
    child.kill(signal);
    return ok(undefined);
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? ok(undefined) : err(String(error));
  }
};

export const runLoggedCi = async (
  options: RunLoggedCiOptions,
): Promise<Result<LoggedCiResult>> => {
  const prepared = await prepareState(options.workspace);
  if (!prepared.ok) return prepared;
  const { root, directory } = prepared.value;
  const lockPath = `${directory}/lock`;
  const lockInfo = await metadata(lockPath);
  if (!lockInfo.ok) return lockInfo;
  if (
    lockInfo.value !== null &&
    (!lockInfo.value.isFile || lockInfo.value.isSymlink)
  ) return err("CI lock must be a real file");
  const openedLock = await attempt(() =>
    Deno.open(lockPath, { create: true, read: true, write: true, mode: 0o600 })
  );
  if (!openedLock.ok) return openedLock;
  const lock = openedLock.value;
  const closeLock = async (detail: string): Promise<Result<LoggedCiResult>> => {
    const closed = await attempt(() => lock.close());
    return err(`${detail}${closed.ok ? "" : `; lock cleanup failed: ${closed.error}`}`);
  };
  const locked = await attempt(() => lock.tryLock(true));
  if (!locked.ok) return await closeLock(locked.error);
  if (!locked.value) return await closeLock("another CI run is already running");
  const privateLock = await attempt(() => Deno.chmod(lockPath, 0o600));
  if (!privateLock.ok) return await closeLock(privateLock.error);

  const logPath = `${directory}/latest.log`;
  const logInfo = await metadata(logPath);
  if (!logInfo.ok) return await closeLock(logInfo.error);
  if (logInfo.value !== null && (!logInfo.value.isFile || logInfo.value.isSymlink)) {
    return await closeLock("CI log must be a real file");
  }

  const diagnostics: string[] = [];
  const inspectedLogger = await inspectProcessIdentity(Deno.pid);
  const logger = inspectedLogger.ok && inspectedLogger.value !== null
    ? {
      started: inspectedLogger.value.started,
      command: inspectedLogger.value.command,
    }
    : null;
  if (!inspectedLogger.ok) {
    diagnostics.push(`logger identity failed: ${inspectedLogger.error}`);
  } else if (logger === null || inspectedLogger.value?.pid !== Deno.pid) {
    diagnostics.push("logger identity is unavailable");
  }
  const started = new Date().toISOString();
  const running: CiStatus = {
    version: 1,
    logger,
    state: "running",
    pid: Deno.pid,
    started,
    finished: null,
    code: null,
  };
  const recordedRunning = await writeStatus(directory, running);
  if (!recordedRunning.ok) {
    return await closeLock(`running status update failed: ${recordedRunning.error}`);
  }
  const openedLog = await createLog(directory);
  let log: Deno.FsFile | null = openedLog.ok ? openedLog.value : null;
  if (!openedLog.ok) diagnostics.push(`log open failed: ${openedLog.error}`);

  let childCode: number | null = null;
  let cancelled = false;
  if (diagnostics.length === 0 && !options.signal?.aborted) {
    const spawned = await attempt(() =>
      new Deno.Command(options.command, {
        args: [...options.args],
        cwd: root,
        env: options.env === undefined ? undefined : { ...options.env },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn()
    );
    if (!spawned.ok) {
      diagnostics.push(`command launch failed: ${spawned.error}`);
    } else {
      const child = spawned.value;
      let settled = false;
      let cancellationError: string | null = null;
      const cancel = () => {
        if (settled || cancelled) return;
        cancelled = true;
        const sent = signalChild(child, interruption(options.signal?.reason).signal);
        if (!sent.ok) cancellationError = sent.error;
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();

      let logChain = Promise.resolve();
      let logAvailable = log !== null;
      const save = (chunk: Uint8Array): Promise<void> => {
        logChain = logChain.then(async () => {
          if (!logAvailable || log === null) return;
          const written = await writeBytes(log, chunk);
          if (!written.ok) {
            diagnostics.push(`log write failed: ${written.error}`);
            logAvailable = false;
          }
        });
        return logChain;
      };
      const drain = async (
        stream: ReadableStream<Uint8Array>,
        sink: ((chunk: Uint8Array) => void | Promise<void>) | undefined,
        label: "stdout" | "stderr",
      ): Promise<void> => {
        const reader = stream.getReader();
        let sinkAvailable = sink !== undefined;
        try {
          while (true) {
            const next = await attempt(() => reader.read());
            if (!next.ok) {
              diagnostics.push(`${label} read failed: ${next.error}`);
              return;
            }
            if (next.value.done) return;
            const chunk = next.value.value;
            if (chunk === undefined) {
              diagnostics.push(`${label} returned an empty stream chunk`);
              continue;
            }
            const forwarded = sinkAvailable && sink !== undefined
              ? attempt(() => sink(chunk))
              : Promise.resolve(ok(undefined));
            const [, sent] = await Promise.all([save(chunk), forwarded]);
            if (!sent.ok) {
              diagnostics.push(`${label} sink failed: ${sent.error}`);
              sinkAvailable = false;
            }
          }
        } finally {
          reader.releaseLock();
        }
      };
      const statusPromise = attempt(() => child.status).then((status) => {
        settled = true;
        return status;
      });
      const completed = await Promise.all([
        statusPromise,
        drain(child.stdout, options.stdout, "stdout"),
        drain(child.stderr, options.stderr, "stderr"),
      ]);
      options.signal?.removeEventListener("abort", cancel);
      if (cancellationError !== null) {
        diagnostics.push(`command cancellation failed: ${cancellationError}`);
      }
      const status = completed[0];
      if (status.ok) {
        childCode = cancelled && status.value.code === 0
          ? interruption(options.signal?.reason).code
          : status.value.code;
      } else diagnostics.push(`command status failed: ${status.error}`);
    }
  } else if (options.signal?.aborted) {
    cancelled = true;
    childCode = interruption(options.signal.reason).code;
  }

  let code = childCode !== null && childCode !== 0
    ? childCode
    : diagnostics.length > 0
    ? 1
    : childCode ?? 1;
  const finished = new Date().toISOString();
  const terminalStatus = (exitCode: number): CiStatus => ({
    ...running,
    state: cancelled ? "cancelled" : exitCode === 0 ? "pass" : "fail",
    finished,
    code: exitCode,
  });
  const recordedCode = code;
  let recordedFinal = await writeStatus(directory, terminalStatus(code));
  if (!recordedFinal.ok) {
    diagnostics.push(`final status update failed: ${recordedFinal.error}`);
    if (code === 0) code = 1;
  }
  if (log !== null) {
    const summary = [
      ...diagnostics.map((detail) => `[mci] ${detail}`),
      `[mci] exit ${code}`,
      "",
    ].join("\n");
    const appended = await writeBytes(log, new TextEncoder().encode(summary));
    if (!appended.ok) {
      diagnostics.push(`log summary failed: ${appended.error}`);
      if (code === 0) code = 1;
    }
    const closed = await attempt(() => log?.close());
    if (!closed.ok) {
      diagnostics.push(`log cleanup failed: ${closed.error}`);
      if (code === 0) code = 1;
    }
    log = null;
  }
  if (!recordedFinal.ok || code !== recordedCode) {
    recordedFinal = await writeStatus(directory, terminalStatus(code));
    if (!recordedFinal.ok) {
      diagnostics.push(`final status retry failed: ${recordedFinal.error}`);
    }
  }
  const released = await attempt(() => lock.close());
  if (!released.ok) diagnostics.push(`lock cleanup failed: ${released.error}`);
  const finalCode = childCode !== null && childCode !== 0
    ? childCode
    : diagnostics.length > 0
    ? 1
    : code;
  return ok({
    code: finalCode,
    diagnostics,
  });
};
