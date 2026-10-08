import { err, ok, type Result } from "./result.ts";

const observationTimeoutMs = 2000;
const pollMs = 100;

export type MonitorProcessCapabilities = {
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Promise<Result<number>>;
  readonly now: () => number;
  readonly delay: (ms: number) => Promise<void>;
};

const escapeExtendedRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const processPattern = (executablePath: string): string =>
  `^${escapeExtendedRegex(executablePath)}([[:space:]]|$)`;

/** Return whether the complete monitor executable path starts a process command. */
export const monitorRunningWith = async (
  executablePath: string,
  capabilities: MonitorProcessCapabilities,
): Promise<Result<boolean>> => {
  const inspected = await capabilities.run(
    "/usr/bin/pgrep",
    ["-f", processPattern(executablePath)],
  );
  if (!inspected.ok) return inspected;
  if (inspected.value === 0) return ok(true);
  if (inspected.value === 1) return ok(false);
  return err(`/usr/bin/pgrep exited with ${inspected.value}`);
};

/** Send one SIGTERM and confirm that no matching monitor process remains. */
export const quitMonitorWith = async (
  executablePath: string,
  capabilities: MonitorProcessCapabilities,
): Promise<Result<void>> => {
  const stopped = await capabilities.run(
    "/usr/bin/pkill",
    ["-TERM", "-f", processPattern(executablePath)],
  );
  if (!stopped.ok) return stopped;
  if (stopped.value !== 0 && stopped.value !== 1) {
    return err(`/usr/bin/pkill exited with ${stopped.value}`);
  }

  const end = capabilities.now() + observationTimeoutMs;
  while (true) {
    const running = await monitorRunningWith(executablePath, capabilities);
    if (!running.ok) return running;
    if (!running.value) return ok(undefined);
    if (capabilities.now() >= end) {
      return err(
        `The app at ${executablePath} did not quit within ${observationTimeoutMs} ms.`,
      );
    }
    await capabilities.delay(pollMs);
  }
};
