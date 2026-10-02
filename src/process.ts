import { attempt, err, ok, type Result } from "./result.ts";

export type Stop = "timeout" | "SIGINT" | "SIGTERM";
export type ProcessOutcome =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "stopped"; readonly reason: Stop };

const signalGroup = (pid: number, signal: Deno.Signal | 0): Result<boolean> => {
  try {
    Deno.kill(-pid, signal);
    return ok(true);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return ok(false);
    return err(`Unable to signal process group ${pid}: ${String(error)}`);
  }
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Clean up ordinary descendants even if their shell already exited. */
const cleanGroup = async (
  pid: number,
  firstSignal: Deno.Signal,
): Promise<Result<void>> => {
  const sent = signalGroup(pid, firstSignal);
  if (!sent.ok) return sent;
  if (!sent.value) return ok(undefined);
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    await delay(25);
    const exists = signalGroup(pid, 0);
    if (!exists.ok) return exists;
    if (!exists.value) return ok(undefined);
  }
  const killed = signalGroup(pid, "SIGKILL");
  return killed.ok ? ok(undefined) : killed;
};

/** Internal POSIX primitive; the public CLI restricts run to macOS. */
export const runProcess = async (options: {
  readonly shell: string;
  readonly script: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly signal: AbortSignal;
}): Promise<Result<ProcessOutcome>> => {
  if (options.signal.aborted) {
    return ok({ kind: "stopped", reason: options.signal.reason as Stop });
  }
  const spawned = await attempt(() =>
    new Deno.Command(options.shell, {
      args: ["--noprofile", "--norc", "-e", "-o", "pipefail", options.script],
      cwd: options.cwd,
      env: options.env,
      clearEnv: true,
      detached: true,
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn()
  );
  if (!spawned.ok) return spawned;
  const child = spawned.value;
  // Register immediately, then recheck: cancellation may race with process creation.
  let abortListener = () => {};
  const stopped = new Promise<ProcessOutcome>((resolve) => {
    abortListener = () =>
      resolve({ kind: "stopped", reason: options.signal.reason as Stop });
    options.signal.addEventListener("abort", abortListener, { once: true });
    if (options.signal.aborted) abortListener();
  });
  const status = child.status;
  const outcome = await Promise.race([
    status.then((value): ProcessOutcome => ({ kind: "exited", code: value.code })),
    stopped,
  ]);
  options.signal.removeEventListener("abort", abortListener);
  const firstSignal = outcome.kind === "stopped" && outcome.reason === "SIGINT"
    ? "SIGINT"
    : "SIGTERM";
  const cleaned = await cleanGroup(child.pid, firstSignal);
  // Always reap the direct child. If group signalling failed, try the direct PID too.
  if (!cleaned.ok) await attempt(() => child.kill("SIGKILL"));
  await status;
  return cleaned.ok ? ok(outcome) : cleaned;
};
