// @light-fp adapter
import { captureCommand, type CommandCapturePolicy } from "../src/command.ts";
import { rpc } from "../src/client.ts";
import { attempt, err, message, ok, type Result } from "../src/result.ts";
import { cliVersion } from "../src/runtime.ts";
import { canonicalDirectory } from "./registry.ts";

const bundleName = "mci Monitor.app";
const executableName = "MonitorApp";
const ownerValue = "mci";
const usage = "usage: deno task monitor:install [workspace]";

export type MonitorOptions = {
  readonly workspace: string;
  readonly applicationsDir: string;
  readonly version: string;
  readonly packageDir: string;
  readonly runningTimeoutMs?: number;
  readonly pollMs?: number;
  readonly previousOwners?: readonly string[];
};

export type MonitorCapabilities = {
  readonly swiftAvailable: () => Promise<boolean>;
  readonly buildApp: (packageDir: string) => Promise<Result<string>>;
  readonly sign: (bundle: string) => Promise<Result<void>>;
  readonly verify: (bundle: string) => Promise<Result<void>>;
  readonly readInstallerKey: (bundle: string) => Promise<Result<string>>;
  readonly quit: (executablePath: string) => Promise<Result<void>>;
  readonly open: (bundle: string) => Promise<Result<void>>;
  readonly isRunning: (executablePath: string) => Promise<Result<boolean>>;
  readonly rename: (from: string, to: string) => Promise<Result<void>>;
  readonly register: (workspace: string) => Promise<Result<void>>;
};

export type Installed = {
  readonly bundle: string;
  readonly workspace: string;
  readonly warnings: readonly string[];
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const plistEntries = (version: string): readonly (readonly [string, string])[] => [
  ["CFBundleIdentifier", `<string>dev.mci.monitor</string>`],
  ["CFBundleName", `<string>mci Monitor</string>`],
  ["CFBundleDisplayName", `<string>mci Monitor</string>`],
  ["CFBundleExecutable", `<string>${executableName}</string>`],
  ["CFBundlePackageType", `<string>APPL</string>`],
  ["CFBundleShortVersionString", `<string>${escapeXml(version)}</string>`],
  ["CFBundleVersion", `<string>${escapeXml(version)}</string>`],
  ["LSUIElement", `<true/>`],
  ["LSMinimumSystemVersion", `<string>14.0</string>`],
  ["NSHighResolutionCapable", `<true/>`],
  ["MCIInstaller", `<string>${ownerValue}</string>`],
];

export const infoPlist = (version: string): string =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ` +
    `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    ...plistEntries(version).flatMap(([key, value]) => [
      `  <key>${key}</key>`,
      `  ${value}`,
    ]),
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");

const removeTree = (path: string) =>
  attempt(() => Deno.remove(path, { recursive: true }));

const lstat = async (path: string): Promise<Deno.FileInfo | null> => {
  const info = await attempt(() => Deno.lstat(path));
  return info.ok ? info.value : null;
};

const assemble = async (
  staging: string,
  binary: string,
  version: string,
): Promise<Result<void>> =>
  await attempt(async () => {
    await Deno.mkdir(`${staging}/Contents/MacOS`, { recursive: true });
    const executable = `${staging}/Contents/MacOS/${executableName}`;
    await Deno.copyFile(binary, executable);
    await Deno.chmod(executable, 0o755);
    await Deno.writeTextFile(`${staging}/Contents/Info.plist`, infoPlist(version));
  });

/** The destination is replaceable when it is a real folder that mci installed. */
const checkDestination = async (
  destination: string,
  capabilities: MonitorCapabilities,
  previousOwners: readonly string[],
): Promise<Result<"absent" | "owned">> => {
  const info = await lstat(destination);
  if (info === null) return ok("absent");
  if (info.isSymlink || !info.isDirectory) {
    return err(`${destination} is not a real folder. It is left unchanged.`);
  }
  const key = await capabilities.readInstallerKey(destination);
  if (!key.ok || (key.value !== ownerValue && !previousOwners.includes(key.value))) {
    return err(
      `${destination} was not installed by mci (MCIInstaller is not "${ownerValue}"). ` +
        `It is left unchanged.`,
    );
  }
  if (key.value !== ownerValue) {
    const verified = await capabilities.verify(destination);
    if (!verified.ok) {
      return err(`The previous app has an invalid signature: ${verified.error}`);
    }
  }
  const executable = await lstat(`${destination}/Contents/MacOS/${executableName}`);
  if (executable === null || !executable.isFile) {
    return err(
      `${destination} has no ${executableName} executable. It is left unchanged.`,
    );
  }
  return ok("owned");
};

/** Move the staged bundle into place. An old bundle moves to the backup, which stays. */
const swapIn = async (
  staging: string,
  destination: string,
  backup: string,
  existed: boolean,
  capabilities: MonitorCapabilities,
): Promise<Result<void>> => {
  if (!existed) {
    const placed = await capabilities.rename(staging, destination);
    return placed.ok ? ok(undefined) : err(`Cannot install the app: ${placed.error}`);
  }
  const moved = await capabilities.rename(destination, backup);
  if (!moved.ok) return err(`Cannot move the old app aside: ${moved.error}`);
  const placed = await capabilities.rename(staging, destination);
  if (!placed.ok) {
    const restored = await capabilities.rename(backup, destination);
    return err(
      restored.ok
        ? `Cannot install the app: ${placed.error}. The old app is restored.`
        : `Cannot install the app: ${placed.error}. Restoring the old app failed: ` +
          `${restored.error}. The old app is at ${backup}.`,
    );
  }
  return ok(undefined);
};

const sentence = (text: string): string => text.endsWith(".") ? text : `${text}.`;

/** Quit the new app, put the old bundle back, and open it. Returns the full error text. */
const rollback = async (
  primary: string,
  destination: string,
  backup: string,
  executable: string,
  capabilities: MonitorCapabilities,
): Promise<string> => {
  const head = sentence(primary);
  const quit = await capabilities.quit(executable);
  if (!quit.ok) {
    return `${head} Rollback could not quit the new app: ${sentence(quit.error)} ` +
      `The old app remains at ${backup}.`;
  }
  const removed = await removeTree(destination);
  if (!removed.ok) {
    const cause = sentence(removed.error);
    return `${head} Rollback could not remove ${destination}: ${cause} ` +
      `The old app remains at ${backup}.`;
  }
  const restored = await capabilities.rename(backup, destination);
  if (!restored.ok) {
    return `${head} Rollback failed. The old app remains at ${backup}: ${restored.error}`;
  }
  const reopened = await capabilities.open(destination);
  return reopened.ok
    ? `${head} The old app was restored and opened.`
    : `${head} The old app was restored, but it did not open: ${reopened.error}`;
};

const waitForRunning = async (
  executable: string,
  capabilities: MonitorCapabilities,
  timeoutMs: number,
  pollMs: number,
): Promise<Result<void>> => {
  const end = performance.now() + timeoutMs;
  while (true) {
    const running = await capabilities.isRunning(executable);
    if (!running.ok) return err(`Cannot check the app process: ${running.error}`);
    if (running.value) return ok(undefined);
    if (performance.now() >= end) {
      return err(`The app did not start within ${timeoutMs} ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

/** Build, stage, sign, replace, register, and open the menu bar app. */
export const installMonitor = async (
  options: MonitorOptions,
  capabilities: MonitorCapabilities,
): Promise<Result<Installed>> => {
  if (!await capabilities.swiftAvailable()) {
    return err("swift is not available. Install the Xcode Command Line Tools.");
  }
  const workspace = await canonicalDirectory(options.workspace);
  if (!workspace.ok) return workspace;

  const built = await capabilities.buildApp(options.packageDir);
  if (!built.ok) return err(`Build failed: ${built.error}`);

  const destination = `${options.applicationsDir}/${bundleName}`;
  const executable = `${destination}/Contents/MacOS/${executableName}`;
  const id = crypto.randomUUID();
  const staging = `${options.applicationsDir}/.mci-monitor-staging-${id}.app`;
  const backup = `${options.applicationsDir}/.mci-monitor-backup-${id}.app`;
  const abandon = async (error: string): Promise<Result<Installed>> => {
    await removeTree(staging);
    return err(error);
  };

  const made = await attempt(() =>
    Deno.mkdir(options.applicationsDir, { recursive: true })
  );
  if (!made.ok) return err(`Cannot create ${options.applicationsDir}: ${made.error}`);
  const assembled = await assemble(staging, built.value, options.version);
  if (!assembled.ok) return abandon(`Cannot assemble the app: ${assembled.error}`);
  const signed = await capabilities.sign(staging);
  if (!signed.ok) return abandon(`Signing failed: ${signed.error}`);
  const verified = await capabilities.verify(staging);
  if (!verified.ok) return abandon(`Signature check failed: ${verified.error}`);

  const state = await checkDestination(
    destination,
    capabilities,
    options.previousOwners ?? [],
  );
  if (!state.ok) return abandon(state.error);
  if (state.value === "owned") {
    const quit = await capabilities.quit(executable);
    if (!quit.ok) return abandon(`Cannot quit the running app: ${quit.error}`);
  }
  const swapped = await swapIn(
    staging,
    destination,
    backup,
    state.value === "owned",
    capabilities,
  );
  if (!swapped.ok) return abandon(swapped.error);

  // A reinstall restores the old app after a failure. A fresh install keeps the new app.
  const owned = state.value === "owned";
  const fail = async (primary: string): Promise<Result<Installed>> =>
    err(
      owned
        ? await rollback(primary, destination, backup, executable, capabilities)
        : primary,
    );

  const registered = await capabilities.register(workspace.value);
  if (!registered.ok) {
    return fail(`Cannot register the repository: ${registered.error}`);
  }
  const opened = await capabilities.open(destination);
  if (!opened.ok) return fail(`Cannot open the app: ${opened.error}`);
  const running = await waitForRunning(
    executable,
    capabilities,
    options.runningTimeoutMs ?? 5000,
    options.pollMs ?? 100,
  );
  if (!running.ok) return fail(running.error);
  const removed = owned ? await removeTree(backup) : ok(undefined);
  const warnings = removed.ok
    ? []
    : [`Cannot remove the old app at ${backup}: ${removed.error}`];
  return ok({ bundle: destination, workspace: workspace.value, warnings });
};

const deadline = {
  timeoutMs: 10_000,
  reapMs: 2_000,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
} as const;
const buildDeadline = {
  timeoutMs: 600_000,
  reapMs: 5_000,
  maxStdoutBytes: 16 * 1024 * 1024,
  maxStderrBytes: 16 * 1024 * 1024,
} as const;
const outputTail = (stdout: Uint8Array): string => {
  const text = new TextDecoder().decode(stdout).trim();
  return text.length > 2000 ? `...${text.slice(-2000)}` : text;
};

const runChecked = async (
  command: string,
  args: readonly string[],
  policy: CommandCapturePolicy = deadline,
): Promise<Result<Uint8Array>> => {
  const captured = await captureCommand(command, { args: [...args] }, policy);
  if (!captured.ok) return captured;
  if (captured.value.status.code !== 0) {
    const detail = outputTail(captured.value.stdout);
    return err(
      `${command} exited with ${captured.value.status.code}${
        detail ? `:\n${detail}` : ""
      }`,
    );
  }
  return ok(captured.value.stdout);
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const processPattern = (executablePath: string): string =>
  `^${escapeRegex(executablePath)}`;

const pgrep = async (executablePath: string): Promise<Result<boolean>> => {
  const captured = await captureCommand(
    "/usr/bin/pgrep",
    { args: ["-f", processPattern(executablePath)] },
    deadline,
  );
  if (!captured.ok) return captured;
  const code = captured.value.status.code;
  if (code === 0) return ok(true);
  if (code === 1) return ok(false);
  return err(`/usr/bin/pgrep exited with ${code}`);
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const nativeCapabilities: MonitorCapabilities = {
  swiftAvailable: async () => {
    const result = await captureCommand("swift", { args: ["--version"] }, deadline);
    return result.ok && result.value.status.code === 0;
  },
  buildApp: async (packageDir) => {
    const built = await runChecked(
      "swift",
      ["build", "-c", "release", "--package-path", packageDir],
      buildDeadline,
    );
    if (!built.ok) return built;
    const binary = `${packageDir}/.build/release/${executableName}`;
    const info = await attempt(() => Deno.stat(binary));
    return info.ok && info.value.isFile ? ok(binary) : err(`${binary} was not built.`);
  },
  sign: async (bundle) => {
    const signed = await runChecked("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      bundle,
    ]);
    return signed.ok ? ok(undefined) : signed;
  },
  verify: async (bundle) => {
    const checked = await runChecked("/usr/bin/codesign", [
      "--verify",
      "--strict",
      bundle,
    ]);
    return checked.ok ? ok(undefined) : checked;
  },
  readInstallerKey: async (bundle) => {
    const read = await runChecked("/usr/bin/plutil", [
      "-extract",
      "MCIInstaller",
      "raw",
      "-o",
      "-",
      `${bundle}/Contents/Info.plist`,
    ]);
    return read.ok ? ok(new TextDecoder().decode(read.value).trim()) : read;
  },
  quit: async (executablePath) => {
    const killed = await captureCommand(
      "/usr/bin/pkill",
      { args: ["-f", processPattern(executablePath)] },
      deadline,
    );
    if (!killed.ok) return killed;
    // pkill exits 1 when no process matched.
    if (killed.value.status.code > 1) {
      return err(`/usr/bin/pkill exited with ${killed.value.status.code}`);
    }
    const end = performance.now() + 2000;
    while (true) {
      const running = await pgrep(executablePath);
      if (!running.ok) return running;
      if (!running.value) return ok(undefined);
      if (performance.now() >= end) return err("The app did not quit within 2000 ms.");
      await sleep(100);
    }
  },
  open: async (bundle) => {
    const opened = await runChecked("/usr/bin/open", [bundle]);
    return opened.ok ? ok(undefined) : opened;
  },
  isRunning: pgrep,
  rename: (from, to) => attempt(() => Deno.rename(from, to)),
  register: async (workspace) => {
    const response = await rpc({ version: 1, op: "register", path: workspace });
    return response.ok ? ok(undefined) : response;
  },
};

const pathOf = (relative: string): string =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname).replace(/\/$/, "");

/** Run the installer for `deno task monitor:install [workspace]`. Returns the exit code. */
export const main = async (
  args: readonly string[],
  capabilities: MonitorCapabilities = nativeCapabilities,
): Promise<number> => {
  if (args.length > 1) {
    console.error(usage);
    return 2;
  }
  const workspace = args[0] ?? pathOf("../");
  if (!workspace.startsWith("/")) {
    console.error("workspace must be an absolute path");
    return 2;
  }
  const home = Deno.env.get("HOME");
  if (home === undefined || !home.startsWith("/")) {
    console.error("HOME must be set to an absolute path");
    return 1;
  }
  const installed = await installMonitor({
    workspace,
    applicationsDir: `${home}/Applications`,
    version: cliVersion,
    packageDir: pathOf("../monitor/"),
  }, capabilities);
  if (!installed.ok) {
    console.error(`monitor:install failed: ${installed.error}`);
    return 1;
  }
  console.log(`Installed ${installed.value.bundle}`);
  console.log(`Monitoring ${installed.value.workspace}`);
  for (const warning of installed.value.warnings) console.error(`warning: ${warning}`);
  return 0;
};

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (error) {
    console.error(`monitor:install failed: ${message(error)}`);
    Deno.exit(1);
  }
}
