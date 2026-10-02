import { attempt, err, ok, type Result } from "./result.ts";

export type Stop = "timeout" | "SIGINT" | "SIGTERM";
export type ProcessOutcome =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "stopped"; readonly reason: Stop };

export type ProcessRecord = {
  readonly pid: number;
  readonly started: string;
  readonly script: string;
};

export type ProcessIdentity = {
  readonly pid: number;
  readonly pgid: number;
  readonly started: string;
  readonly command: string;
};

export type ProcessLaunch = {
  readonly shell: string;
  readonly script: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
};

export type ProcessHandle = {
  readonly pid: number;
  readonly status: Promise<Deno.CommandStatus>;
};

export type ProcessCapabilities = {
  readonly launch: (input: ProcessLaunch) => Promise<Result<ProcessHandle>>;
  readonly inspect: (pid: number) => Promise<Result<ProcessIdentity | null>>;
  readonly signalGroup: (
    pid: number,
    signal: Deno.Signal | 0,
  ) => Promise<Result<boolean>>;
  readonly signalProcess: (
    pid: number,
    signal: Deno.Signal,
  ) => Promise<Result<boolean>>;
  readonly now: () => number;
  readonly delay: (ms: number) => Promise<void>;
};

export type ProcessPolicy = {
  readonly graceMs: number;
  readonly reapMs: number;
  readonly pollMs: number;
};

export type ProcessSupervision = {
  readonly capabilities?: ProcessCapabilities;
  readonly policy?: ProcessPolicy;
};

export type ProcessOptions = ProcessLaunch & {
  readonly signal: AbortSignal;
  readonly onStart?: (record: ProcessRecord) => Promise<Result<void>>;
  readonly onFinish?: () => Promise<Result<void>>;
};

type Cleanup = {
  readonly diagnostics: readonly string[];
  readonly groupClean: boolean;
  readonly reaped: boolean;
};

type ObservedStatus = {
  readonly completed: Promise<Result<Deno.CommandStatus>>;
  readonly current: () => Result<Deno.CommandStatus> | null;
};

const nativePolicy: ProcessPolicy = {
  graceMs: 2000,
  reapMs: 2000,
  pollMs: 25,
};

export const normalizeStop = (reason: unknown): Stop =>
  reason === "timeout" || reason === "SIGINT" || reason === "SIGTERM"
    ? reason
    : "SIGTERM";

const parseIdentity = (pid: number, output: string): Result<ProcessIdentity | null> => {
  const line = output.split("\n").find((candidate) => candidate.trim().length > 0);
  if (line === undefined) return ok(null);
  const matched = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
  if (matched === null) return err(`Unable to parse process identity for ${pid}`);
  const parsedPid = Number(matched[1]);
  const pgid = Number(matched[2]);
  const started = matched[3];
  const command = matched[4];
  if (
    !Number.isSafeInteger(parsedPid) || !Number.isSafeInteger(pgid) ||
    started === undefined || command === undefined
  ) {
    return err(`Unable to parse process identity for ${pid}`);
  }
  return ok({ pid: parsedPid, pgid, started, command });
};

const inspectNative = async (pid: number): Promise<Result<ProcessIdentity | null>> => {
  const inspected = await attempt(() =>
    new Deno.Command("/bin/ps", {
      args: ["-ww", "-o", "pid=,pgid=,lstart=,command=", "-p", String(pid)],
      clearEnv: true,
      env: { LC_ALL: "C" },
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output()
  );
  if (!inspected.ok) return err(`Unable to inspect process ${pid}: ${inspected.error}`);
  const output = new TextDecoder().decode(inspected.value.stdout);
  if (!inspected.value.success) {
    return output.trim().length === 0
      ? ok(null)
      : err(`Unable to inspect process ${pid}: ps exited ${inspected.value.code}`);
  }
  return parseIdentity(pid, output);
};

const signalNative = (
  target: number,
  signal: Deno.Signal | 0,
  label: string,
): Promise<Result<boolean>> => {
  try {
    Deno.kill(target, signal);
    return Promise.resolve(ok(true));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return Promise.resolve(ok(false));
    return Promise.resolve(err(`Unable to signal ${label}: ${String(error)}`));
  }
};

const nativeCapabilities: ProcessCapabilities = {
  launch: async (input) => {
    const spawned = await attempt(() =>
      new Deno.Command(input.shell, {
        args: ["--noprofile", "--norc", "-e", "-o", "pipefail", input.script],
        cwd: input.cwd,
        env: input.env,
        clearEnv: true,
        detached: true,
        stdin: "null",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn()
    );
    return spawned.ok
      ? ok({ pid: spawned.value.pid, status: spawned.value.status })
      : spawned;
  },
  inspect: inspectNative,
  signalGroup: (pid, signal) => signalNative(-pid, signal, `process group ${pid}`),
  signalProcess: (pid, signal) => signalNative(pid, signal, `process ${pid}`),
  now: () => performance.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const identityError = (
  identity: ProcessIdentity,
  record: ProcessRecord,
): string | null => {
  if (identity.pid !== record.pid) return `Process ${record.pid} has a different PID`;
  if (identity.pgid !== record.pid) {
    return `Process ${record.pid} is not its process group leader`;
  }
  if (identity.started !== record.started) {
    return `Process ${record.pid} has a different start time`;
  }
  if (!record.script.startsWith("/") || !identity.command.includes(record.script)) {
    return `Process ${record.pid} does not contain journal script ${record.script}`;
  }
  return null;
};

const recordProcess = async (
  pid: number,
  script: string,
  capabilities: ProcessCapabilities,
): Promise<Result<ProcessRecord | null>> => {
  const inspected = await capabilities.inspect(pid);
  if (!inspected.ok) return inspected;
  if (inspected.value === null) return ok(null);
  if (inspected.value.pid !== pid) return err(`Process ${pid} has a different PID`);
  if (inspected.value.pgid !== pid) {
    return err(`Process ${pid} is not its process group leader`);
  }
  const record = { pid, started: inspected.value.started, script };
  return ok(record);
};

const runHook = async (hook: () => Promise<Result<void>>): Promise<Result<void>> => {
  const called = await attempt(hook);
  return called.ok ? called.value : called;
};

const observeStatus = (status: Promise<Deno.CommandStatus>): ObservedStatus => {
  let current: Result<Deno.CommandStatus> | null = null;
  const completed = attempt(() => status).then((result) => {
    current = result;
    return result;
  });
  return { completed, current: () => current };
};

const waitForStatus = async (
  status: ObservedStatus,
  capabilities: ProcessCapabilities,
  timeoutMs: number,
  pollMs: number,
): Promise<Result<Deno.CommandStatus> | null> => {
  const deadline = capabilities.now() + timeoutMs;
  while (capabilities.now() < deadline) {
    const current = status.current();
    if (current !== null) return current;
    await capabilities.delay(Math.min(pollMs, deadline - capabilities.now()));
  }
  return status.current();
};

const cleanProcess = async (
  pid: number,
  firstSignal: Deno.Signal,
  status: ObservedStatus,
  capabilities: ProcessCapabilities,
  policy: ProcessPolicy,
): Promise<Cleanup> => {
  const diagnostics: string[] = [];
  let groupClean = false;
  const first = await capabilities.signalGroup(pid, firstSignal);
  if (!first.ok) diagnostics.push(`Process group cleanup failed: ${first.error}`);
  else if (!first.value) groupClean = true;

  if (!groupClean && first.ok) {
    const deadline = capabilities.now() + policy.graceMs;
    while (capabilities.now() < deadline) {
      await capabilities.delay(policy.pollMs);
      const present = await capabilities.signalGroup(pid, 0);
      if (!present.ok) {
        diagnostics.push(`Process group inspection failed: ${present.error}`);
        break;
      }
      if (!present.value) {
        groupClean = true;
        break;
      }
    }
    if (!groupClean) {
      const killed = await capabilities.signalGroup(pid, "SIGKILL");
      if (!killed.ok) diagnostics.push(`Process group kill failed: ${killed.error}`);
      else if (!killed.value) groupClean = true;
    }
  }

  if (!groupClean) {
    const killed = await capabilities.signalProcess(pid, "SIGKILL");
    if (!killed.ok) diagnostics.push(`Direct process kill failed: ${killed.error}`);
  }

  const reaped = await waitForStatus(
    status,
    capabilities,
    policy.reapMs,
    policy.pollMs,
  );
  let didReap = false;
  if (reaped === null) {
    diagnostics.push(`Direct child reaping timed out after ${policy.reapMs} ms`);
  } else if (!reaped.ok) {
    diagnostics.push(`Direct child status failed: ${reaped.error}`);
  } else {
    didReap = true;
  }

  if (!groupClean) {
    const deadline = capabilities.now() + policy.reapMs;
    while (capabilities.now() <= deadline) {
      const present = await capabilities.signalGroup(pid, 0);
      if (!present.ok) {
        diagnostics.push(`Final process group inspection failed: ${present.error}`);
        break;
      }
      if (!present.value) {
        groupClean = true;
        break;
      }
      if (capabilities.now() >= deadline) break;
      await capabilities.delay(policy.pollMs);
    }
  }
  if (!groupClean) diagnostics.push(`Process group ${pid} cleanup remains uncertain`);
  return { diagnostics, groupClean, reaped: didReap };
};

const failWithCleanup = async (
  initial: readonly string[],
  pid: number,
  status: ObservedStatus,
  capabilities: ProcessCapabilities,
  policy: ProcessPolicy,
): Promise<Result<ProcessOutcome>> => {
  const cleaned = await cleanProcess(pid, "SIGTERM", status, capabilities, policy);
  return err([...initial, ...cleaned.diagnostics].join("\n"));
};

/** Run one detached POSIX process group and reap its direct child. */
export const runProcess = async (
  options: ProcessOptions,
  supervision: ProcessSupervision = {},
): Promise<Result<ProcessOutcome>> => {
  if (options.signal.aborted) {
    return ok({ kind: "stopped", reason: normalizeStop(options.signal.reason) });
  }
  const capabilities = supervision.capabilities ?? nativeCapabilities;
  const policy = supervision.policy ?? nativePolicy;
  const launched = await capabilities.launch(options);
  if (!launched.ok) return launched;
  const child = launched.value;
  const status = observeStatus(child.status);

  const recorded = await recordProcess(child.pid, options.script, capabilities);
  if (!recorded.ok) {
    return await failWithCleanup(
      [`Process identity capture failed: ${recorded.error}`],
      child.pid,
      status,
      capabilities,
      policy,
    );
  }

  const registered = recorded.value !== null;
  const onStart = options.onStart;
  if (recorded.value !== null && onStart !== undefined) {
    const record = recorded.value;
    const started = await runHook(() => onStart(record));
    if (!started.ok) {
      return await failWithCleanup(
        [`Process registration failed: ${started.error}`],
        child.pid,
        status,
        capabilities,
        policy,
      );
    }
  }

  let abortListener = () => {};
  const stopped = new Promise<{ readonly kind: "stopped"; readonly reason: Stop }>(
    (resolve) => {
      abortListener = () =>
        resolve({ kind: "stopped", reason: normalizeStop(options.signal.reason) });
      options.signal.addEventListener("abort", abortListener, { once: true });
      if (options.signal.aborted) abortListener();
    },
  );
  const completed = status.completed.then((result): ProcessOutcome | {
    readonly kind: "status-failed";
  } =>
    result.ok ? { kind: "exited", code: result.value.code } : { kind: "status-failed" }
  );
  const outcome = await Promise.race([completed, stopped]);
  options.signal.removeEventListener("abort", abortListener);
  const firstSignal = outcome.kind === "stopped" && outcome.reason === "SIGINT"
    ? "SIGINT"
    : "SIGTERM";
  const cleaned = await cleanProcess(
    child.pid,
    firstSignal,
    status,
    capabilities,
    policy,
  );
  const diagnostics = [...cleaned.diagnostics];
  if (
    cleaned.groupClean && cleaned.reaped && registered && options.onFinish !== undefined
  ) {
    const finished = await runHook(options.onFinish);
    if (!finished.ok) {
      diagnostics.push(`Process finish registration failed: ${finished.error}`);
    }
  }
  if (diagnostics.length > 0 && outcome.kind === "exited") {
    diagnostics.unshift(`Process exited with code ${outcome.code}`);
  }
  if (diagnostics.length > 0 && outcome.kind === "stopped") {
    diagnostics.unshift(`Process stopped because of ${outcome.reason}`);
  }
  if (diagnostics.length > 0 || outcome.kind === "status-failed") {
    return err(diagnostics.join("\n"));
  }
  return ok(outcome);
};

const recoveryState = async (
  record: ProcessRecord,
  capabilities: ProcessCapabilities,
): Promise<Result<"gone" | "matched" | "orphaned">> => {
  const inspected = await capabilities.inspect(record.pid);
  if (!inspected.ok) return inspected;
  if (inspected.value === null) {
    const group = await capabilities.signalGroup(record.pid, 0);
    if (!group.ok) return group;
    return ok(group.value ? "orphaned" : "gone");
  }
  const mismatch = identityError(inspected.value, record);
  return mismatch === null ? ok("matched") : err(mismatch);
};

const signalRecoveryGroup = async (
  record: ProcessRecord,
  signal: Deno.Signal | 0,
  capabilities: ProcessCapabilities,
): Promise<Result<boolean>> => {
  const state = await recoveryState(record, capabilities);
  if (!state.ok) return state;
  if (state.value === "gone") return ok(false);
  if (state.value === "orphaned") {
    return err(`Process ${record.pid} leader is absent while its group still exists`);
  }
  return await capabilities.signalGroup(record.pid, signal);
};

const waitForRecovery = async (
  record: ProcessRecord,
  capabilities: ProcessCapabilities,
  timeoutMs: number,
  pollMs: number,
): Promise<Result<"gone" | "matched" | "orphaned">> => {
  const deadline = capabilities.now() + timeoutMs;
  while (capabilities.now() < deadline) {
    await capabilities.delay(Math.min(pollMs, deadline - capabilities.now()));
    const state = await recoveryState(record, capabilities);
    if (!state.ok || state.value === "gone") return state;
  }
  return await recoveryState(record, capabilities);
};

/** Best-effort recovery checks process identity before every signal. */
export const recoverProcess = async (
  record: ProcessRecord,
  supervision: ProcessSupervision = {},
): Promise<Result<void>> => {
  const capabilities = supervision.capabilities ?? nativeCapabilities;
  const policy = supervision.policy ?? nativePolicy;
  const terminated = await signalRecoveryGroup(record, "SIGTERM", capabilities);
  if (!terminated.ok) return terminated;
  if (!terminated.value) return ok(undefined);

  const graceful = await waitForRecovery(
    record,
    capabilities,
    policy.graceMs,
    policy.pollMs,
  );
  if (!graceful.ok) return graceful;
  if (graceful.value === "gone") return ok(undefined);
  if (graceful.value === "orphaned") {
    return err(`Process ${record.pid} leader is absent while its group still exists`);
  }
  const killed = await signalRecoveryGroup(record, "SIGKILL", capabilities);
  if (!killed.ok) return killed;
  if (!killed.value) return ok(undefined);
  const forced = await waitForRecovery(
    record,
    capabilities,
    policy.reapMs,
    policy.pollMs,
  );
  if (!forced.ok) return forced;
  if (forced.value === "gone") return ok(undefined);
  return err(`Process group ${record.pid} cleanup remains uncertain after SIGKILL`);
};
