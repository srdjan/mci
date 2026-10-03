// @light-fp adapter
import { rpc } from "./client.ts";
import { captureCommand } from "./command.ts";
import { attempt, err, ok, type Result } from "./result.ts";

const bundleName = "mci Monitor.app";
const ownerValue = "meeci";
const knownBrews = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] as const;
const commandPolicy = { timeoutMs: 120000, reapMs: 1000 } as const;

export type SetupOptions = {
  readonly sourceBundle: string;
  readonly applicationsDirectory: string;
  readonly stateDirectory?: string;
  readonly daemonTimeoutMs?: number;
  readonly pollMs?: number;
};

export type SetupCapabilities = {
  readonly readOwner: (bundle: string) => Promise<Result<string>>;
  readonly verifySignature: (bundle: string) => Promise<Result<void>>;
  readonly copyBundle: (source: string, destination: string) => Promise<Result<void>>;
  readonly rename: (source: string, destination: string) => Promise<Result<void>>;
  readonly remove: (path: string) => Promise<Result<void>>;
  readonly quit: (executable: string) => Promise<Result<void>>;
  /** Return true only when setup owns service rollback. */
  readonly startService: () => Promise<Result<boolean>>;
  readonly stopService: () => Promise<Result<void>>;
  readonly ping: (stateDirectory?: string) => Promise<Result<void>>;
  readonly open: (bundle: string) => Promise<Result<void>>;
};

const output = async (
  executable: string,
  args: readonly string[],
): Promise<Result<string>> => {
  const run = await captureCommand(
    executable,
    { args: [...args] },
    commandPolicy,
  );
  if (!run.ok) return run;
  const stdout = new TextDecoder().decode(run.value.stdout).trim();
  const stderr = new TextDecoder().decode(run.value.stderr).trim();
  return run.value.status.code === 0
    ? ok(stdout)
    : err(stderr || `${executable} exited with ${run.value.status.code}`);
};

const findBrew = async (): Promise<Result<string>> => {
  for (const path of knownBrews) {
    const info = await attempt(() => Deno.stat(path));
    if (info.ok && info.value.isFile) return ok(path);
  }
  return err("Homebrew was not found at /opt/homebrew or /usr/local.");
};

const serviceWasPresent = (text: string): Result<boolean> => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    return err(
      `Homebrew service information is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(decoded)) {
    return err("Homebrew service information must be an array.");
  }
  if (decoded.length !== 1) {
    return err("Homebrew service information must contain one mci service.");
  }
  const service = decoded[0];
  if (
    typeof service !== "object" || service === null || Array.isArray(service) ||
    service.name !== "mci"
  ) {
    return err("Homebrew service information must contain one mci service.");
  }
  if (
    typeof service.loaded !== "boolean" || typeof service.running !== "boolean" ||
    typeof service.registered !== "boolean"
  ) {
    return err(
      "Homebrew service information has invalid loaded, running, or registered state.",
    );
  }
  return ok(service.loaded || service.running || service.registered);
};

const nativeSetupCapabilities: SetupCapabilities = {
  readOwner: async (bundle) =>
    await output("/usr/bin/plutil", [
      "-extract",
      "MCIInstaller",
      "raw",
      "-o",
      "-",
      `${bundle}/Contents/Info.plist`,
    ]),
  verifySignature: async (bundle) => {
    const verified = await output("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      bundle,
    ]);
    return verified.ok ? ok(undefined) : verified;
  },
  copyBundle: async (source, destination) => {
    const copied = await output("/usr/bin/ditto", [source, destination]);
    return copied.ok ? ok(undefined) : copied;
  },
  rename: (source, destination) => attempt(() => Deno.rename(source, destination)),
  remove: async (path) => {
    const removed = await attempt(() => Deno.remove(path, { recursive: true }));
    return removed.ok || removed.error.includes("No such file") ? ok(undefined) : removed;
  },
  quit: async (executable) => {
    const pattern = `^${executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    const stopped = await captureCommand(
      "/usr/bin/pkill",
      { args: ["-f", pattern] },
      { timeoutMs: 5000, reapMs: 1000 },
    );
    if (!stopped.ok) return stopped;
    return stopped.value.status.code <= 1
      ? ok(undefined)
      : err(`/usr/bin/pkill exited with ${stopped.value.status.code}`);
  },
  startService: async () => {
    const brew = await findBrew();
    if (!brew.ok) return brew;
    const info = await output(brew.value, ["services", "info", "mci", "--json"]);
    if (!info.ok) return err(`Cannot inspect the Homebrew service: ${info.error}`);
    const present = serviceWasPresent(info.value);
    if (!present.ok) return present;
    const started = await output(brew.value, ["services", "start", "mci"]);
    return started.ok ? ok(!present.value) : started;
  },
  stopService: async () => {
    const brew = await findBrew();
    if (!brew.ok) return brew;
    const stopped = await output(brew.value, ["services", "stop", "mci"]);
    return stopped.ok ? ok(undefined) : stopped;
  },
  ping: async (stateDirectory) => {
    const pinged = await rpc({ version: 1, op: "ping" }, stateDirectory);
    return pinged.ok ? ok(undefined) : pinged;
  },
  open: async (bundle) => {
    const opened = await output("/usr/bin/open", [bundle]);
    return opened.ok ? ok(undefined) : opened;
  },
};

const lstat = async (path: string): Promise<Result<Deno.FileInfo | null>> => {
  try {
    return ok(await Deno.lstat(path));
  } catch (error) {
    return error instanceof Deno.errors.NotFound
      ? ok(null)
      : err(error instanceof Error ? error.message : String(error));
  }
};

const checkBundle = async (
  path: string,
  capabilities: SetupCapabilities,
  allowAbsent: boolean,
): Promise<Result<"absent" | "owned">> => {
  const info = await lstat(path);
  if (!info.ok) return err(`Cannot inspect ${path}: ${info.error}`);
  if (info.value === null) {
    return allowAbsent
      ? ok("absent")
      : err(`The packaged monitor app is absent at ${path}.`);
  }
  if (info.value.isSymlink || !info.value.isDirectory) {
    return err(`${path} is not a real app directory. It is left unchanged.`);
  }
  const owner = await capabilities.readOwner(path);
  if (!owner.ok || owner.value !== ownerValue) {
    return err(`${path} is not owned by the mci installer. It is left unchanged.`);
  }
  const signature = await capabilities.verifySignature(path);
  if (!signature.ok) {
    return err(`${path} has an invalid signature: ${signature.error}`);
  }
  return ok("owned");
};

const waitForDaemon = async (
  stateDirectory: string | undefined,
  capabilities: SetupCapabilities,
  timeoutMs: number,
  pollMs: number,
): Promise<Result<void>> => {
  const end = performance.now() + timeoutMs;
  let latest = "daemon did not answer";
  while (performance.now() < end) {
    const ping = await capabilities.ping(stateDirectory);
    if (ping.ok) return ping;
    latest = ping.error;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return err(`The mci daemon did not start within ${timeoutMs} ms: ${latest}`);
};

const rollback = async (
  destination: string,
  backup: string,
  hadDestination: boolean,
  capabilities: SetupCapabilities,
): Promise<string> => {
  const removed = await capabilities.remove(destination);
  if (!removed.ok) return `Rollback could not remove ${destination}: ${removed.error}`;
  if (!hadDestination) return "The new app was removed.";
  const restored = await capabilities.rename(backup, destination);
  if (!restored.ok) {
    return `Rollback failed. The old app remains at ${backup}: ${restored.error}`;
  }
  const opened = await capabilities.open(destination);
  return opened.ok
    ? "The old app was restored and opened."
    : `The old app was restored, but it did not open: ${opened.error}`;
};

/** Install the packaged app, start the service, and open the app. */
export const setupWith = async (
  options: SetupOptions,
  capabilities: SetupCapabilities,
): Promise<Result<void>> => {
  const source = await checkBundle(options.sourceBundle, capabilities, false);
  if (!source.ok) return source;
  const daemonWasReady = await capabilities.ping(options.stateDirectory);

  const made = await attempt(() =>
    Deno.mkdir(options.applicationsDirectory, { recursive: true })
  );
  if (!made.ok) {
    return err(`Cannot create ${options.applicationsDirectory}: ${made.error}`);
  }
  const destination = `${options.applicationsDirectory}/${bundleName}`;
  const existing = await checkBundle(destination, capabilities, true);
  if (!existing.ok) return existing;

  const id = crypto.randomUUID();
  const staging = `${options.applicationsDirectory}/.mci-monitor-staging-${id}.app`;
  const backup = `${options.applicationsDirectory}/.mci-monitor-backup-${id}.app`;
  const copied = await capabilities.copyBundle(options.sourceBundle, staging);
  if (!copied.ok) {
    const removed = await capabilities.remove(staging);
    return err(
      `Cannot stage the monitor app: ${copied.error}` +
        (removed.ok ? "" : `; staging cleanup failed: ${removed.error}`),
    );
  }
  const staged = await checkBundle(staging, capabilities, false);
  if (!staged.ok) {
    await capabilities.remove(staging);
    return err(`The staged monitor app failed validation: ${staged.error}`);
  }

  const hadDestination = existing.value === "owned";
  if (hadDestination) {
    const quit = await capabilities.quit(
      `${destination}/Contents/MacOS/MonitorApp`,
    );
    if (!quit.ok) {
      await capabilities.remove(staging);
      return err(`Cannot quit the running monitor app: ${quit.error}`);
    }
    const moved = await capabilities.rename(destination, backup);
    if (!moved.ok) {
      await capabilities.remove(staging);
      return err(`Cannot move the old monitor app aside: ${moved.error}`);
    }
  }
  const placed = await capabilities.rename(staging, destination);
  if (!placed.ok) {
    const recovered = hadDestination
      ? await capabilities.rename(backup, destination)
      : ok(undefined);
    const reopened = recovered.ok && hadDestination
      ? await capabilities.open(destination)
      : ok(undefined);
    if (!recovered.ok) {
      return err(
        `Cannot install the monitor app: ${placed.error}. ` +
          `The old app remains at ${backup}: ${recovered.error}`,
      );
    }
    if (!reopened.ok) {
      return err(
        `Cannot install the monitor app: ${placed.error}. ` +
          `The old app is restored, but it did not open: ${reopened.error}`,
      );
    }
    return err(
      `Cannot install the monitor app: ${placed.error}. ` +
        `${
          hadDestination ? "The old app is restored and opened." : "No app was installed."
        }`,
    );
  }
  const installed = await checkBundle(destination, capabilities, false);
  if (!installed.ok) {
    const recovered = await rollback(destination, backup, hadDestination, capabilities);
    return err(
      `The installed monitor app failed validation: ${installed.error} ${recovered}`,
    );
  }

  let startedService = false;
  const stopStartedService = async (): Promise<string> => {
    if (!startedService) return "";
    const stopped = await capabilities.stopService();
    return stopped.ok ? "" : ` Service rollback failed: ${stopped.error}.`;
  };
  if (!daemonWasReady.ok) {
    const start = await capabilities.startService();
    if (!start.ok) {
      const recovered = await rollback(destination, backup, hadDestination, capabilities);
      return err(`Cannot start the Homebrew service: ${start.error} ${recovered}`);
    }
    startedService = start.value;
    const ready = await waitForDaemon(
      options.stateDirectory,
      capabilities,
      options.daemonTimeoutMs ?? 5000,
      options.pollMs ?? 100,
    );
    if (!ready.ok) {
      const serviceRecovery = await stopStartedService();
      const recovered = await rollback(destination, backup, hadDestination, capabilities);
      return err(`${ready.error}${serviceRecovery} ${recovered}`);
    }
  }
  const opened = await capabilities.open(destination);
  if (!opened.ok) {
    const serviceRecovery = await stopStartedService();
    const recovered = await rollback(destination, backup, hadDestination, capabilities);
    return err(
      `Cannot open the monitor app: ${opened.error}${serviceRecovery} ${recovered}`,
    );
  }
  if (hadDestination) {
    const removed = await capabilities.remove(backup);
    if (!removed.ok) {
      return err(`Cannot remove the old app at ${backup}: ${removed.error}`);
    }
  }
  return ok(undefined);
};

const installedSourceBundle = async (): Promise<Result<string>> => {
  const executable = await attempt(() => Deno.realPath(Deno.execPath()));
  if (!executable.ok) return executable;
  const bin = executable.value.slice(0, executable.value.lastIndexOf("/"));
  const prefix = bin.slice(0, bin.lastIndexOf("/"));
  const bundle = `${prefix}/libexec/${bundleName}`;
  const info = await lstat(bundle);
  if (!info.ok) return info;
  return info.value !== null ? ok(bundle) : err(
    `The packaged monitor app is absent at ${bundle}. ` +
      "Run deno task package, install dist/tap/Formula/mci.rb with Homebrew, " +
      "then run mci setup.",
  );
};

export const setup = async (): Promise<Result<void>> => {
  const home = Deno.env.get("HOME");
  if (home === undefined || !home.startsWith("/")) {
    return err("HOME must identify an absolute directory.");
  }
  const source = await installedSourceBundle();
  if (!source.ok) return source;
  return await setupWith({
    sourceBundle: source.value,
    applicationsDirectory: `${home}/Applications`,
  }, nativeSetupCapabilities);
};
