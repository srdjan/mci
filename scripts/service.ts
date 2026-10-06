// @light-fp adapter
import { rpc } from "../src/client.ts";
import { captureCommand } from "../src/command.ts";
import { servicePaths } from "../src/paths.ts";
import { inspectProcessIdentity, type ProcessIdentity } from "../src/process.ts";
import { attempt, err, message, ok, type Result } from "../src/result.ts";
import { cliSourceArgs, cliVersion } from "../src/runtime.ts";
import type { Snapshot } from "../src/protocol.ts";
import {
  installMonitor,
  nativeCapabilities as nativeMonitorCapabilities,
} from "./install-monitor.ts";

const bundleName = "mci Monitor.app";
const executableName = "MonitorApp";
const ownerValue = "mci";
const recordName = "source-daemon.json";
const usage = "usage: deno task start|stop";

type PathKind = "absent" | "file" | "directory" | "other";

export type DaemonLaunch = {
  readonly pid: number;
};

export type DaemonLaunchOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

export type LifecycleCapabilities = {
  readonly home: string;
  readonly stateHome?: string;
  readonly workspace: string;
  readonly packageDir: string;
  readonly execPath: string;
  readonly ping: () => Promise<Result<Snapshot>>;
  readonly register: (workspace: string) => Promise<Result<void>>;
  readonly launchDaemon: (options: DaemonLaunchOptions) => Promise<Result<DaemonLaunch>>;
  readonly inspectProcess: (pid: number) => Promise<Result<ProcessIdentity | null>>;
  readonly signalProcess: (pid: number, signal: Deno.Signal) => Promise<Result<boolean>>;
  readonly pathKind: (path: string) => Promise<Result<PathKind>>;
  readonly makePrivateDirectory: (path: string) => Promise<Result<void>>;
  readonly makePrivateFile: (path: string) => Promise<Result<void>>;
  readonly readText: (path: string) => Promise<Result<string>>;
  readonly writeText: (path: string, value: string) => Promise<Result<void>>;
  readonly removeFile: (path: string) => Promise<Result<void>>;
  readonly readInstallerKey: (bundle: string) => Promise<Result<string>>;
  readonly verifyMonitor: (bundle: string) => Promise<Result<void>>;
  readonly installMonitor: () => Promise<Result<void>>;
  readonly openMonitor: (bundle: string) => Promise<Result<void>>;
  readonly monitorRunning: (executable: string) => Promise<Result<boolean>>;
  readonly quitMonitor: (executable: string) => Promise<Result<void>>;
  readonly homebrewServiceLoaded: () => Promise<Result<boolean>>;
  readonly stopHomebrewService: () => Promise<Result<void>>;
  readonly now: () => number;
  readonly delay: (ms: number) => Promise<void>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

type SourceRecord = {
  readonly pid: number;
  readonly started: string;
  readonly command: string;
};

const pathFrom = (relative: string): string =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname).replace(/\/$/, "");

const defaultDirectory = (home: string): string =>
  `${home}/Library/Application Support/mci`;

const sameIdentity = (left: ProcessIdentity, right: ProcessIdentity): boolean =>
  left.pid === right.pid && left.pgid === right.pgid && left.started === right.started &&
  left.command === right.command;

const parseRecord = (text: string): Result<SourceRecord> => {
  const parsed = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      return error;
    }
  })();
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    !("pid" in parsed) || !("started" in parsed) || !("command" in parsed) ||
    !Number.isSafeInteger(parsed.pid) || typeof parsed.pid !== "number" ||
    parsed.pid < 1 ||
    typeof parsed.started !== "string" || typeof parsed.command !== "string" ||
    !parsed.command.includes("src/main.ts daemon")
  ) return err("The source daemon launch record is invalid");
  return ok({ pid: parsed.pid, started: parsed.started, command: parsed.command });
};

const waitForDaemon = async (
  capabilities: LifecycleCapabilities,
  timeoutMs = 5000,
): Promise<Result<Snapshot>> => {
  const end = capabilities.now() + timeoutMs;
  let latest = "Daemon unavailable";
  while (true) {
    const response = await capabilities.ping();
    if (response.ok) return response;
    latest = response.error;
    if (capabilities.now() >= end) {
      return err(`The daemon did not become ready within ${timeoutMs} ms: ${latest}`);
    }
    await capabilities.delay(50);
  }
};

const waitForMonitor = async (
  executable: string,
  capabilities: LifecycleCapabilities,
  timeoutMs = 5000,
): Promise<Result<void>> => {
  const end = capabilities.now() + timeoutMs;
  while (true) {
    const running = await capabilities.monitorRunning(executable);
    if (!running.ok) return err(`Cannot check the monitor process: ${running.error}`);
    if (running.value) return ok(undefined);
    if (capabilities.now() >= end) {
      return err(`The monitor did not become ready within ${timeoutMs} ms`);
    }
    await capabilities.delay(50);
  }
};

const stopMatchingProcess = async (
  identity: ProcessIdentity,
  capabilities: LifecycleCapabilities,
): Promise<Result<void>> => {
  const current = await capabilities.inspectProcess(identity.pid);
  if (!current.ok) return current;
  if (current.value === null || !sameIdentity(identity, current.value)) {
    return ok(undefined);
  }
  const signaled = await capabilities.signalProcess(identity.pid, "SIGTERM");
  if (!signaled.ok) return signaled;
  if (!signaled.value) return ok(undefined);
  const end = capabilities.now() + 5000;
  while (capabilities.now() < end) {
    await capabilities.delay(50);
    const inspected = await capabilities.inspectProcess(identity.pid);
    if (!inspected.ok) return inspected;
    if (inspected.value === null || !sameIdentity(identity, inspected.value)) {
      return ok(undefined);
    }
  }
  return err(`Daemon process ${identity.pid} did not stop within 5000 ms`);
};

const waitForIdentityExit = async (
  identity: ProcessIdentity,
  capabilities: LifecycleCapabilities,
): Promise<Result<void>> => {
  const end = capabilities.now() + 5000;
  while (capabilities.now() < end) {
    const inspected = await capabilities.inspectProcess(identity.pid);
    if (!inspected.ok) return inspected;
    if (inspected.value === null || !sameIdentity(identity, inspected.value)) {
      return ok(undefined);
    }
    await capabilities.delay(50);
  }
  return err(`Daemon process ${identity.pid} did not stop within 5000 ms`);
};

const rollbackDaemon = async (
  identity: ProcessIdentity | null,
  launchedPid: number | null,
  record: string,
  capabilities: LifecycleCapabilities,
  recordSaved: boolean,
): Promise<string | null> => {
  if (identity === null && launchedPid === null) return null;
  const stopped = identity !== null
    ? await stopMatchingProcess(identity, capabilities)
    : launchedPid !== null
    ? await capabilities.signalProcess(launchedPid, "SIGTERM").then((result) =>
      result.ok ? ok(undefined) : result
    )
    : ok(undefined);
  const removed = stopped.ok && recordSaved
    ? await capabilities.removeFile(record)
    : ok(undefined);
  const failures = [stopped, removed].filter((result) => !result.ok).map((result) =>
    result.ok ? "" : result.error
  );
  return failures.length === 0 ? null : failures.join("; ");
};

/** Start the source daemon and installed monitor, then wait for both components. */
export const start = async (
  capabilities: LifecycleCapabilities = nativeCapabilities,
): Promise<Result<void>> => {
  const paths = servicePaths(
    capabilities.stateHome ?? defaultDirectory(capabilities.home),
  );
  if (!paths.ok) return paths;
  const bundle = `${capabilities.home}/Applications/${bundleName}`;
  const executable = `${bundle}/Contents/MacOS/${executableName}`;
  const record = `${paths.value.directory}/${recordName}`;
  let launchedIdentity: ProcessIdentity | null = null;
  let launchedPid: number | null = null;
  let openedMonitor = false;
  let recordSaved = false;

  const fail = async (primary: string): Promise<Result<void>> => {
    const failures = [primary];
    if (openedMonitor) {
      const quit = await capabilities.quitMonitor(executable);
      if (!quit.ok) failures.push(`monitor rollback: ${quit.error}`);
    }
    const rollback = await rollbackDaemon(
      launchedIdentity,
      launchedPid,
      record,
      capabilities,
      recordSaved,
    );
    if (rollback !== null) failures.push(`daemon rollback: ${rollback}`);
    return err(failures.join("; "));
  };

  let daemon = await capabilities.ping();
  if (!daemon.ok && paths.value.directory === defaultDirectory(capabilities.home)) {
    const loaded = await capabilities.homebrewServiceLoaded();
    if (!loaded.ok) return err(`Cannot inspect the Homebrew service: ${loaded.error}`);
    if (loaded.value) {
      const disabled = await capabilities.stopHomebrewService();
      if (!disabled.ok) {
        return err(`Cannot stop the unavailable Homebrew service: ${disabled.error}`);
      }
      daemon = await capabilities.ping();
    }
  }
  if (!daemon.ok) {
    const made = await capabilities.makePrivateDirectory(paths.value.directory);
    if (!made.ok) return err(`Cannot prepare the daemon directory: ${made.error}`);
    const log = `${paths.value.directory}/daemon.log`;
    const logged = await capabilities.makePrivateFile(log);
    if (!logged.ok) return err(`Cannot prepare the daemon log: ${logged.error}`);
    const launched = await capabilities.launchDaemon({
      command: "/usr/bin/nohup",
      args: [
        "/bin/sh",
        "-c",
        'exec "$@" >> "$MCI_DAEMON_LOG" 2>&1',
        "mci-daemon",
        capabilities.execPath,
        ...cliSourceArgs(["daemon"]),
      ],
      cwd: capabilities.workspace,
      env: { MCI_DAEMON_LOG: log },
    });
    if (!launched.ok) return err(`Cannot launch the daemon: ${launched.error}`);
    launchedPid = launched.value.pid;
    daemon = await waitForDaemon(capabilities);
    if (!daemon.ok) return await fail(daemon.error);
    if (daemon.value.pid !== launchedPid) {
      return await fail(
        `The responding daemon PID ${daemon.value.pid} differs from launched PID ${launchedPid}`,
      );
    }
    const inspected = await capabilities.inspectProcess(daemon.value.pid);
    if (!inspected.ok || inspected.value === null) {
      return await fail(
        `Cannot inspect the ready daemon: ${
          inspected.ok ? "the process exited" : inspected.error
        }`,
      );
    }
    launchedIdentity = inspected.value;
    const recordKind = await capabilities.pathKind(record);
    if (
      !recordKind.ok || (recordKind.value !== "absent" && recordKind.value !== "file")
    ) {
      return await fail("The source daemon launch record is not a real file");
    }
    const saved = await capabilities.writeText(
      record,
      JSON.stringify({
        pid: inspected.value.pid,
        started: inspected.value.started,
        command: inspected.value.command,
      }),
    );
    if (!saved.ok) {
      return await fail(`Cannot save the source daemon launch record: ${saved.error}`);
    }
    recordSaved = true;
  }

  const registered = await capabilities.register(capabilities.workspace);
  if (!registered.ok) {
    return await fail(`Cannot register the repository: ${registered.error}`);
  }

  const bundleKind = await capabilities.pathKind(bundle);
  if (!bundleKind.ok) return await fail(bundleKind.error);
  if (bundleKind.value === "absent") {
    const installed = await capabilities.installMonitor();
    if (!installed.ok) {
      return await fail(`Cannot install the monitor: ${installed.error}`);
    }
    openedMonitor = true;
  } else {
    if (bundleKind.value !== "directory") {
      return await fail(`${bundle} is not an installed application directory`);
    }
    const owner = await capabilities.readInstallerKey(bundle);
    if (!owner.ok || (owner.value !== ownerValue && owner.value !== "meeci")) {
      return await fail(`${bundle} was not installed by mci (MCIInstaller is not "mci")`);
    }
    if (owner.value === "meeci") {
      const installed = await capabilities.installMonitor();
      if (!installed.ok) {
        return await fail(`Cannot migrate the monitor: ${installed.error}`);
      }
      openedMonitor = true;
    } else {
      const verified = await capabilities.verifyMonitor(bundle);
      if (!verified.ok) {
        return await fail(`Monitor signature check failed: ${verified.error}`);
      }
      const executableKind = await capabilities.pathKind(executable);
      if (!executableKind.ok || executableKind.value !== "file") {
        return await fail(`${bundle} has no ${executableName} executable`);
      }
      const running = await capabilities.monitorRunning(executable);
      if (!running.ok) {
        return await fail(`Cannot check the monitor process: ${running.error}`);
      }
      if (running.value) {
        const quit = await capabilities.quitMonitor(executable);
        if (!quit.ok) return await fail(`Cannot reopen the monitor: ${quit.error}`);
      }
      const opened = await capabilities.openMonitor(bundle);
      if (!opened.ok) {
        let recovery = "";
        if (running.value) {
          const reopened = await capabilities.openMonitor(bundle);
          const restored = reopened.ok
            ? await waitForMonitor(executable, capabilities)
            : reopened;
          recovery = restored.ok
            ? "; the monitor reopened during recovery"
            : `; monitor recovery failed: ${restored.error}`;
        }
        return await fail(`Cannot open the monitor: ${opened.error}${recovery}`);
      }
      openedMonitor = true;
    }
  }
  const ready = await waitForMonitor(executable, capabilities);
  if (ready.ok) return ready;
  return await fail(ready.error);
};

const liveSourceRecord = async (
  path: string,
  capabilities: LifecycleCapabilities,
): Promise<Result<ProcessIdentity | null>> => {
  const kind = await capabilities.pathKind(path);
  if (!kind.ok) return kind;
  if (kind.value === "absent") return ok(null);
  if (kind.value !== "file") return err("The source daemon launch record is not a file");
  const text = await capabilities.readText(path);
  if (!text.ok) return text;
  const record = parseRecord(text.value);
  if (!record.ok) return record;
  const identity = await capabilities.inspectProcess(record.value.pid);
  if (!identity.ok) return identity;
  if (
    identity.value === null || identity.value.started !== record.value.started ||
    identity.value.command !== record.value.command
  ) return ok(null);
  return identity;
};

/** Stop the installed monitor and the daemon. */
export const stop = async (
  capabilities: LifecycleCapabilities = nativeCapabilities,
): Promise<Result<void>> => {
  const paths = servicePaths(
    capabilities.stateHome ?? defaultDirectory(capabilities.home),
  );
  if (!paths.ok) return paths;
  const executable =
    `${capabilities.home}/Applications/${bundleName}/Contents/MacOS/${executableName}`;
  const record = `${paths.value.directory}/${recordName}`;
  const failures: string[] = [];

  const quit = await capabilities.quitMonitor(executable);
  if (!quit.ok) failures.push(`Cannot quit the monitor: ${quit.error}`);

  const initial = await capabilities.ping();
  const initialIdentity = initial.ok
    ? await capabilities.inspectProcess(initial.value.pid)
    : ok(null);
  if (!initialIdentity.ok) {
    failures.push(`Cannot inspect daemon process: ${initialIdentity.error}`);
  }

  if (paths.value.directory === defaultDirectory(capabilities.home)) {
    const loaded = await capabilities.homebrewServiceLoaded();
    if (!loaded.ok) failures.push(`Cannot inspect the Homebrew service: ${loaded.error}`);
    else if (loaded.value) {
      const disabled = await capabilities.stopHomebrewService();
      if (!disabled.ok) {
        failures.push(`Cannot stop the Homebrew service: ${disabled.error}`);
      }
    }
  }

  const current = await capabilities.ping();
  if (!initial.ok && !current.ok) {
    const source = await liveSourceRecord(record, capabilities);
    if (!source.ok) failures.push(source.error);
    if (source.ok && source.value !== null) {
      const stopped = await stopMatchingProcess(source.value, capabilities);
      if (!stopped.ok) failures.push(stopped.error);
      else {
        const removed = await capabilities.removeFile(record);
        if (!removed.ok) failures.push(removed.error);
      }
    }
    const remaining = await capabilities.ping();
    if (remaining.ok) failures.push("A daemon started during shutdown");
    const socket = await capabilities.pathKind(paths.value.socket);
    if (!socket.ok) failures.push(`Cannot inspect the daemon socket: ${socket.error}`);
    if (socket.ok && socket.value !== "absent") {
      failures.push("The daemon socket exists, but the daemon does not respond");
    }
    return failures.length === 0 ? ok(undefined) : err(failures.join("; "));
  }

  const snapshot = initial.ok ? initial.value : current.ok ? current.value : null;
  if (snapshot === null) return err(failures.join("; "));
  const original = initial.ok
    ? initialIdentity
    : await capabilities.inspectProcess(snapshot.pid);
  if (!original.ok) {
    failures.push(`Cannot inspect daemon process: ${original.error}`);
  } else if (original.value === null) {
    if (current.ok) failures.push("The daemon process exited before shutdown");
  } else if (!current.ok) {
    const exited = await waitForIdentityExit(original.value, capabilities);
    if (!exited.ok) failures.push("The daemon stopped responding before shutdown");
  } else {
    if (
      current.value.instance !== snapshot.instance || current.value.pid !== snapshot.pid
    ) {
      failures.push("The daemon changed before it could be signaled");
    } else {
      const current = await capabilities.inspectProcess(original.value.pid);
      if (!current.ok) failures.push(`Cannot recheck daemon process: ${current.error}`);
      else if (current.value === null || !sameIdentity(original.value, current.value)) {
        failures.push("The daemon process identity changed before it could be signaled");
      } else {
        const stopped = await stopMatchingProcess(original.value, capabilities);
        if (!stopped.ok) failures.push(stopped.error);
      }
    }
  }

  const remaining = await capabilities.ping();
  if (remaining.ok) {
    failures.push(
      remaining.value.instance === snapshot.instance &&
        remaining.value.pid === snapshot.pid
        ? "The daemon still responds after shutdown"
        : "A new daemon started during shutdown",
    );
  } else {
    if (failures.length === 0) {
      const removed = await capabilities.removeFile(record);
      if (!removed.ok) {
        failures.push(`Cannot remove the source daemon launch record: ${removed.error}`);
      }
    }
  }
  return failures.length === 0 ? ok(undefined) : err(failures.join("; "));
};

const run = async (command: string, args: readonly string[]): Promise<Result<string>> => {
  const captured = await captureCommand(
    command,
    { args: [...args] },
    {
      timeoutMs: 10_000,
      reapMs: 2000,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    },
  );
  if (!captured.ok) return captured;
  if (!captured.value.status.success) {
    return err(
      new TextDecoder().decode(captured.value.stderr).trim() ||
        `${command} exited with ${captured.value.status.code}`,
    );
  }
  return ok(new TextDecoder().decode(captured.value.stdout));
};

const nativeHome = Deno.env.get("HOME") ?? "";
const nativeStateHome = Deno.env.get("MCI_HOME");
const nativeWorkspace = pathFrom("../");
const nativePackageDir = pathFrom("../monitor/");

const openNativeMonitor = async (bundle: string): Promise<Result<void>> => {
  const paths = servicePaths(nativeStateHome ?? defaultDirectory(nativeHome));
  if (!paths.ok) return paths;
  const opened = await run("/usr/bin/open", [
    "--env",
    `MCI_MONITOR_DAEMON_DIR=${paths.value.directory}`,
    "--env",
    `MCI_MONITOR_REGISTRY_DIR=${paths.value.directory}`,
    bundle,
  ]);
  return opened.ok ? ok(undefined) : opened;
};

const lifecycleMonitorCapabilities = {
  ...nativeMonitorCapabilities,
  open: openNativeMonitor,
};

export const nativeCapabilities: LifecycleCapabilities = {
  home: nativeHome,
  stateHome: nativeStateHome,
  workspace: nativeWorkspace,
  packageDir: nativePackageDir,
  execPath: Deno.execPath(),
  ping: () => rpc({ version: 1, op: "ping" }, nativeStateHome),
  register: async (workspace) => {
    const response = await rpc(
      { version: 1, op: "register", path: workspace },
      nativeStateHome,
    );
    return response.ok ? ok(undefined) : response;
  },
  launchDaemon: async (options) => {
    const launched = await attempt(() =>
      new Deno.Command(options.command, {
        args: [...options.args],
        cwd: options.cwd,
        env: { ...Deno.env.toObject(), ...options.env },
        detached: true,
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn()
    );
    if (!launched.ok) return launched;
    launched.value.unref();
    return ok({ pid: launched.value.pid });
  },
  inspectProcess: inspectProcessIdentity,
  signalProcess: (pid, signal) => {
    try {
      Deno.kill(pid, signal);
      return Promise.resolve(ok(true));
    } catch (error) {
      return Promise.resolve(
        error instanceof Deno.errors.NotFound ? ok(false) : err(message(error)),
      );
    }
  },
  pathKind: async (path) => {
    let inspected: Deno.FileInfo;
    try {
      inspected = await Deno.lstat(path);
    } catch (error) {
      return error instanceof Deno.errors.NotFound ? ok("absent") : err(message(error));
    }
    if (inspected.isSymlink) return ok("other");
    if (inspected.isFile) return ok("file");
    if (inspected.isDirectory) return ok("directory");
    return ok("other");
  },
  makePrivateDirectory: async (path) => {
    try {
      const existing = await Deno.lstat(path);
      if (existing.isSymlink || !existing.isDirectory) {
        return err(`${path} is not a real directory`);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) return err(message(error));
    }
    const made = await attempt(() => Deno.mkdir(path, { recursive: true, mode: 0o700 }));
    if (!made.ok) return made;
    return attempt(() => Deno.chmod(path, 0o700));
  },
  makePrivateFile: async (path) => {
    try {
      const existing = await Deno.lstat(path);
      if (existing.isSymlink || !existing.isFile) {
        return err(`${path} is not a real file`);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) return err(message(error));
    }
    const file = await attempt(() =>
      Deno.open(path, { create: true, append: true, mode: 0o600 })
    );
    if (!file.ok) return file;
    file.value.close();
    return attempt(() => Deno.chmod(path, 0o600));
  },
  readText: (path) => attempt(() => Deno.readTextFile(path)),
  writeText: async (path, value) => {
    const kind = await nativeCapabilities.pathKind(path);
    if (!kind.ok) return kind;
    if (kind.value !== "absent" && kind.value !== "file") {
      return err(`${path} is not a real file`);
    }
    const temporary = await attempt(() =>
      Deno.makeTempFile({
        dir: path.slice(0, path.lastIndexOf("/")),
        prefix: ".source-daemon-",
      })
    );
    if (!temporary.ok) return temporary;
    const written = await attempt(async () => {
      await Deno.chmod(temporary.value, 0o600);
      await Deno.writeTextFile(temporary.value, value);
      await Deno.rename(temporary.value, path);
    });
    if (!written.ok) {
      const removed = await nativeCapabilities.removeFile(temporary.value);
      if (!removed.ok) {
        return err(`${written.error}; record cleanup failed: ${removed.error}`);
      }
    }
    return written;
  },
  removeFile: async (path) => {
    try {
      await Deno.remove(path);
      return ok(undefined);
    } catch (error) {
      return error instanceof Deno.errors.NotFound ? ok(undefined) : err(message(error));
    }
  },
  readInstallerKey: nativeMonitorCapabilities.readInstallerKey,
  verifyMonitor: nativeMonitorCapabilities.verify,
  installMonitor: async () => {
    const installed = await installMonitor({
      workspace: nativeWorkspace,
      applicationsDir: `${nativeHome}/Applications`,
      version: cliVersion,
      packageDir: nativePackageDir,
      previousOwners: ["meeci"],
    }, lifecycleMonitorCapabilities);
    return installed.ok ? ok(undefined) : installed;
  },
  openMonitor: openNativeMonitor,
  monitorRunning: nativeMonitorCapabilities.isRunning,
  quitMonitor: nativeMonitorCapabilities.quit,
  homebrewServiceLoaded: async () => {
    const identified = await run("/usr/bin/id", ["-u"]);
    if (!identified.ok) return identified;
    const uid = identified.value.trim();
    if (!/^\d+$/.test(uid)) return err("/usr/bin/id returned an invalid user ID");
    for (const label of ["homebrew.mxcl.mci", "sh.brew.mci"]) {
      const output = await captureCommand(
        "/bin/launchctl",
        { args: ["print", `gui/${uid}/${label}`] },
        {
          timeoutMs: 10_000,
          reapMs: 2000,
          maxStdoutBytes: 1024 * 1024,
          maxStderrBytes: 1024 * 1024,
        },
      );
      if (!output.ok) return output;
      if (output.value.status.success) return ok(true);
    }
    return ok(false);
  },
  stopHomebrewService: async () => {
    const stopped = await run("brew", ["services", "stop", "mci"]);
    return stopped.ok ? ok(undefined) : stopped;
  },
  now: () => performance.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stdout: console.log,
  stderr: console.error,
};

/** Run `deno task start` or `deno task stop`. */
export const main = async (
  args: readonly string[],
  capabilities: LifecycleCapabilities = nativeCapabilities,
): Promise<number> => {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    capabilities.stdout(usage);
    return 0;
  }
  if (args.length !== 1 || (args[0] !== "start" && args[0] !== "stop")) {
    capabilities.stderr(usage);
    return 2;
  }
  const result = args[0] === "start"
    ? await start(capabilities)
    : await stop(capabilities);
  if (!result.ok) {
    capabilities.stderr(`mci ${args[0]} failed: ${result.error}`);
    return 1;
  }
  capabilities.stdout(`mci ${args[0]} complete`);
  return 0;
};

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (error) {
    console.error(`mci service failed: ${message(error)}`);
    Deno.exit(1);
  }
}
