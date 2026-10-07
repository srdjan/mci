import {
  type DaemonLaunchOptions,
  type LifecycleCapabilities,
  main,
  start,
  stop,
} from "../scripts/service.ts";
import type { ProcessIdentity } from "../src/process.ts";
import type { Snapshot } from "../src/protocol.ts";
import { err, ok, type Result } from "../src/result.ts";
import { assert, equal } from "./helpers.ts";

const home = "/Users/test";
const stateHome = `${home}/Library/Application Support/mci`;
const bundle = `${home}/Applications/mci Monitor.app`;
const executable = `${bundle}/Contents/MacOS/MonitorApp`;
const socket = `${stateHome}/daemon.sock`;
const record = `${stateHome}/source-daemon.json`;

const snapshot = (instance = "one", pid = 42): Snapshot => ({
  version: 1,
  instance,
  pid,
  updated: "2026-10-06T12:00:00.000Z",
  repositories: [],
});

const identity = (
  started = "Mon Oct  6 12:00:00 2026",
  command = "deno run /repo/src/main.ts daemon",
): ProcessIdentity => ({ pid: 42, pgid: 42, started, command });
const resolved = <T>(value: T): Promise<T> => Promise.resolve(value);

type SceneOptions = {
  readonly daemon?: boolean;
  readonly monitor?: boolean;
  readonly installed?: boolean;
  readonly owner?: string;
  readonly homebrew?: boolean;
  readonly quitError?: string;
  readonly signalError?: string;
  readonly monitorNeverReady?: boolean;
  readonly inspect?: readonly (ProcessIdentity | null)[];
  readonly inspectResults?: readonly Result<ProcessIdentity | null>[];
  readonly pings?: readonly Result<Snapshot>[];
  readonly exitObservations?: readonly Result<boolean>[];
  readonly unresponsive?: boolean;
};

const scene = (options: SceneOptions = {}) => {
  const calls: string[] = [];
  const writes = new Map<string, string>();
  let daemon = options.daemon ?? false;
  let monitor = options.monitor ?? false;
  let installed = options.installed ?? true;
  let owner = options.owner ?? "mci";
  let process: ProcessIdentity | null = daemon ? identity() : null;
  let now = 0;
  let inspectIndex = 0;
  let pingIndex = 0;
  let exitIndex = 0;
  let exitObservation: Result<boolean> = ok(false);
  let launch: DaemonLaunchOptions | undefined;
  const capabilities: LifecycleCapabilities = {
    home,
    stateHome,
    workspace: "/repo",
    packageDir: "/repo/monitor",
    execPath: "/deno",
    ping: () => {
      calls.push("ping");
      const queued = options.pings?.[pingIndex++];
      return resolved(
        queued ?? (daemon && !options.unresponsive ? ok(snapshot()) : err("unavailable")),
      );
    },
    register: () => {
      calls.push("register");
      return resolved(ok(undefined));
    },
    launchDaemon: (input) => {
      calls.push("launch");
      launch = input;
      daemon = true;
      process = identity();
      return resolved(ok({
        pid: 42,
        exited: () => {
          calls.push("exited");
          const queued = options.exitObservations?.[exitIndex++];
          if (queued !== undefined) exitObservation = queued;
          return exitObservation;
        },
      }));
    },
    inspectProcess: () => {
      calls.push("inspect");
      const result = options.inspectResults?.[inspectIndex];
      const queued = options.inspect?.[inspectIndex++];
      if (result !== undefined) return resolved(result);
      return resolved(ok(queued === undefined ? process : queued));
    },
    signalProcess: () => {
      calls.push("signal");
      if (options.signalError !== undefined) return resolved(err(options.signalError));
      daemon = false;
      process = null;
      return resolved(ok(true));
    },
    pathKind: (path) => {
      if (path === bundle) return resolved(ok(installed ? "directory" : "absent"));
      if (path === executable) return resolved(ok(installed ? "file" : "absent"));
      if (path === socket) return resolved(ok(daemon ? "file" : "absent"));
      if (path === record) return resolved(ok(writes.has(path) ? "file" : "absent"));
      return resolved(ok("absent"));
    },
    makePrivateDirectory: () => {
      calls.push("mkdir");
      return resolved(ok(undefined));
    },
    makePrivateFile: () => {
      calls.push("log");
      return resolved(ok(undefined));
    },
    readText: (path) => {
      const value = writes.get(path);
      return resolved(value === undefined ? err("missing") : ok(value));
    },
    writeText: (path, value) => {
      calls.push("write");
      writes.set(path, value);
      return resolved(ok(undefined));
    },
    removeFile: (path) => {
      calls.push("remove");
      writes.delete(path);
      return resolved(ok(undefined));
    },
    readInstallerKey: () => resolved(ok(owner)),
    verifyMonitor: () => {
      calls.push("verify");
      return resolved(ok(undefined));
    },
    installMonitor: () => {
      calls.push("install");
      installed = true;
      owner = "mci";
      monitor = true;
      return resolved(ok(undefined));
    },
    openMonitor: () => {
      calls.push("open");
      monitor = true;
      return resolved(ok(undefined));
    },
    monitorRunning: () => {
      calls.push("running");
      return resolved(ok(options.monitorNeverReady ? false : monitor));
    },
    quitMonitor: () => {
      calls.push("quit");
      if (options.quitError !== undefined) return resolved(err(options.quitError));
      monitor = false;
      return resolved(ok(undefined));
    },
    homebrewServiceLoaded: () => {
      calls.push("service-loaded");
      return resolved(ok(options.homebrew ?? false));
    },
    stopHomebrewService: () => {
      calls.push("service-stop");
      return resolved(ok(undefined));
    },
    now: () => now,
    delay: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    stdout: (text) => calls.push(`stdout:${text}`),
    stderr: (text) => calls.push(`stderr:${text}`),
  };
  return {
    capabilities,
    calls,
    writes,
    get launch(): DaemonLaunchOptions | undefined {
      return launch;
    },
  };
};

Deno.test("start reuses the ready daemon and reopens the shared monitor", async () => {
  const subject = scene({ daemon: true, monitor: true });
  const result = await start(subject.capabilities);
  assert(result.ok, result.ok ? "" : result.error);
  assert(!subject.calls.includes("launch"));
  assert(subject.calls.includes("quit"));
  assert(subject.calls.includes("open"));
  assert(subject.calls.includes("register"));
  assert(subject.calls.includes("verify"));
});

Deno.test("start launches a detached source command and records the ready identity", async () => {
  const subject = scene({ monitor: true });
  const result = await start(subject.capabilities);
  assert(result.ok, result.ok ? "" : result.error);
  assert(subject.writes.has(record));
  const launch = subject.launch;
  assert(launch !== undefined);
  equal(launch.command, "/usr/bin/nohup");
  equal(launch.args.slice(0, 5), [
    "/bin/sh",
    "-c",
    'exec "$@" >> "$MCI_DAEMON_LOG" 2>&1',
    "mci-daemon",
    "/deno",
  ]);
  equal(launch.env.MCI_DAEMON_LOG, `${stateHome}/daemon.log`);
});

Deno.test("start installs a missing monitor", async () => {
  const subject = scene({ daemon: true, installed: false });
  const result = await start(subject.capabilities);
  assert(result.ok, result.ok ? "" : result.error);
  assert(subject.calls.includes("install"));
});

Deno.test("start migrates the recognized legacy monitor", async () => {
  const subject = scene({ daemon: true, installed: true, owner: "meeci" });
  const result = await start(subject.capabilities);
  assert(result.ok, result.ok ? "" : result.error);
  assert(subject.calls.includes("install"));
});

Deno.test("start failure preserves a preexisting daemon and closes its opened monitor", async () => {
  const subject = scene({ daemon: true, monitorNeverReady: true });
  const result = await start(subject.capabilities);
  assert(!result.ok);
  assert(subject.calls.includes("open"));
  assert(subject.calls.includes("quit"));
  assert(!subject.calls.includes("signal"));
});

Deno.test("start failure stops only the daemon launched by this invocation", async () => {
  const subject = scene({ monitorNeverReady: true });
  const result = await start(subject.capabilities);
  assert(!result.ok);
  equal(subject.calls.filter((call) => call === "signal").length, 1);
  const signalIndex = subject.calls.indexOf("signal");
  assert(subject.calls.slice(signalIndex + 1).includes("inspect"));
  assert(subject.calls.includes("remove"));
});

Deno.test("start readiness failure does not signal a changed launched process", async () => {
  const subject = scene({
    unresponsive: true,
    inspect: [identity(), identity("replacement start")],
  });
  const result = await start(subject.capabilities);
  assert(!result.ok && result.error.includes("did not become ready"));
  assert(result.error.includes("cleanup ownership is unresolved"));
  assert(!subject.calls.includes("signal"));
});

Deno.test("start readiness failure does not signal an unobserved launched process", async () => {
  const subject = scene({ unresponsive: true, inspect: [null] });
  const result = await start(subject.capabilities);
  assert(!result.ok && result.error.includes("did not become ready"));
  assert(result.error.includes("cleanup ownership is unresolved"));
  assert(!subject.calls.includes("signal"));
});

Deno.test("start preserves readiness and inspection errors when ownership is unknown", async () => {
  const subject = scene({
    unresponsive: true,
    inspectResults: [err("inspection refused")],
  });
  const result = await start(subject.capabilities);
  assert(!result.ok && result.error.includes("did not become ready"));
  assert(result.error.includes("inspection refused"));
  assert(result.error.includes("cleanup ownership is unresolved"));
  assert(!subject.calls.includes("signal"));
});

Deno.test("start readiness failure does not signal a child that exits during inspection", async () => {
  const subject = scene({
    unresponsive: true,
    exitObservations: [ok(false), ok(true)],
  });
  const result = await start(subject.capabilities);
  assert(!result.ok && result.error.includes("did not become ready"));
  assert(!subject.calls.includes("signal"));
});

Deno.test("start reports unknown child status without signaling", async () => {
  const subject = scene({
    unresponsive: true,
    exitObservations: [ok(false), ok(false), err("status observation failed")],
  });
  const result = await start(subject.capabilities);
  assert(!result.ok && result.error.includes("did not become ready"));
  assert(result.error.includes("child status observation failed"));
  assert(result.error.includes("status observation failed"));
  assert(result.error.includes("no signal was sent"));
  assert(!subject.calls.includes("signal"));
});

Deno.test("start preserves its recovery record when child status becomes unknown", async () => {
  const subject = scene({
    monitorNeverReady: true,
    exitObservations: [
      ok(false),
      ok(false),
      ok(false),
      ok(false),
      err("status observation failed"),
    ],
  });
  const result = await start(subject.capabilities);
  assert(!result.ok && result.error.includes("status observation failed"));
  assert(subject.writes.has(record));
  assert(!subject.calls.includes("signal"));
  assert(!subject.calls.includes("remove"));
});

Deno.test("start accepts the launcher to Deno command transition", async () => {
  const launcher = identity(
    "Mon Oct  6 12:00:00 2026",
    "/usr/bin/nohup /bin/sh -c exec deno",
  );
  const daemon = identity(
    "Mon Oct  6 12:00:00 2026",
    "deno run /repo/src/main.ts daemon",
  );
  const subject = scene({ monitor: true, inspect: [launcher, daemon] });
  const result = await start(subject.capabilities);
  assert(result.ok, result.ok ? "" : result.error);
  equal(
    subject.writes.get(record),
    JSON.stringify({
      pid: daemon.pid,
      started: daemon.started,
      command: daemon.command,
    }),
  );
});

Deno.test("start restores a foreign launch record after later failure", async () => {
  const subject = scene({ owner: "foreign" });
  subject.writes.set(record, "foreign record");
  const result = await start(subject.capabilities);
  assert(!result.ok && result.error.includes("was not installed by mci"));
  equal(subject.writes.get(record), "foreign record");
  equal(subject.calls.filter((call) => call === "signal").length, 1);
});

Deno.test("stop is repeatable when both components are absent", async () => {
  const subject = scene();
  assert((await stop(subject.capabilities)).ok);
  assert((await stop(subject.capabilities)).ok);
  equal(subject.calls.filter((call) => call === "signal").length, 0);
});

Deno.test("stop disables Homebrew before signaling the daemon", async () => {
  const subject = scene({ daemon: true, monitor: true, homebrew: true });
  const result = await stop(subject.capabilities);
  assert(result.ok, result.ok ? "" : result.error);
  assert(subject.calls.indexOf("service-stop") < subject.calls.indexOf("signal"));
});

Deno.test("stop refuses a changed daemon identity", async () => {
  const subject = scene({
    daemon: true,
    inspect: [identity(), identity("Mon Oct  6 12:00:01 2026")],
  });
  const result = await stop(subject.capabilities);
  assert(!result.ok && result.error.includes("identity changed"));
  assert(!subject.calls.includes("signal"));
});

Deno.test("stop reports monitor and daemon failures together", async () => {
  const subject = scene({
    daemon: true,
    quitError: "quit failed",
    signalError: "kill failed",
  });
  const result = await stop(subject.capabilities);
  assert(!result.ok);
  assert(result.error.includes("quit failed"));
  assert(result.error.includes("kill failed"));
});

Deno.test("main validates arguments and help has no lifecycle effects", async () => {
  const subject = scene();
  equal(await main(["--help"], subject.capabilities), 0);
  equal(await main([], subject.capabilities), 2);
  equal(await main(["start", "extra"], subject.capabilities), 2);
  assert(!subject.calls.includes("ping"));
});

Deno.test("stop terminates an unresponsive daemon only when its recorded identity matches", async () => {
  const subject = scene({ daemon: true, unresponsive: true });
  subject.writes.set(record, JSON.stringify(identity()));
  const result = await stop(subject.capabilities);
  assert(result.ok, result.ok ? "" : result.error);
  assert(subject.calls.includes("signal"));
  assert(!subject.writes.has(record));
});

Deno.test("stop preserves a record when an unresponsive daemon cannot stop", async () => {
  const subject = scene({
    daemon: true,
    unresponsive: true,
    signalError: "signal refused",
  });
  subject.writes.set(record, JSON.stringify(identity()));
  const result = await stop(subject.capabilities);
  assert(!result.ok && result.error.includes("signal refused"));
  assert(subject.writes.has(record));
});

Deno.test("stop does not signal a stale identity in a saved source record", async () => {
  const subject = scene({ daemon: true, unresponsive: true });
  subject.writes.set(record, JSON.stringify(identity("previous start")));
  const result = await stop(subject.capabilities);
  assert(!result.ok);
  assert(!subject.calls.includes("signal"));
});

Deno.test("stop succeeds when the initial daemon exits before process inspection", async () => {
  const subject = scene({
    pings: [ok(snapshot()), err("gone"), err("gone")],
    inspect: [null],
  });
  const result = await stop(subject.capabilities);
  assert(result.ok, result.ok ? "" : result.error);
  assert(!subject.calls.includes("signal"));
});

Deno.test("startup failure preserves a preexisting daemon record", async () => {
  const subject = scene({ daemon: true, owner: "foreign" });
  subject.writes.set(record, "preexisting record");
  const result = await start(subject.capabilities);
  assert(!result.ok);
  equal(subject.writes.get(record), "preexisting record");
  assert(!subject.calls.includes("signal"));
});

Deno.test("custom start reopens the shared monitor and custom stop preserves Homebrew", async () => {
  const subject = scene({ daemon: true, monitor: true, homebrew: true });
  const capabilities = { ...subject.capabilities, stateHome: "/tmp/mci-custom" };
  const started = await start(capabilities);
  assert(started.ok, started.ok ? "" : started.error);
  assert(subject.calls.includes("quit"));
  assert(subject.calls.includes("open"));
  const stopped = await stop(capabilities);
  assert(stopped.ok, stopped.ok ? "" : stopped.error);
  assert(!subject.calls.includes("service-loaded"));
  assert(!subject.calls.includes("service-stop"));
});

Deno.test("start stops an unavailable Homebrew service before source launch", async () => {
  const subject = scene({ homebrew: true });
  const result = await start(subject.capabilities);
  assert(result.ok, result.ok ? "" : result.error);
  assert(subject.calls.indexOf("service-stop") < subject.calls.indexOf("launch"));
});

Deno.test("start attempts monitor recovery after a transient reopen failure", async () => {
  const subject = scene({ daemon: true, monitor: true });
  let attempts = 0;
  const result = await start({
    ...subject.capabilities,
    openMonitor: (path) => {
      attempts++;
      return attempts === 1
        ? Promise.resolve(err("transient open failure"))
        : subject.capabilities.openMonitor(path);
    },
  });
  assert(!result.ok && result.error.includes("the monitor reopened during recovery"));
  equal(attempts, 2);
  assert(!subject.calls.includes("signal"));
  const running = await subject.capabilities.monitorRunning(executable);
  assert(running.ok && running.value);
});

Deno.test("start rejects a symlinked launch record and preserves its contents", async () => {
  const subject = scene();
  subject.writes.set(record, "preserved target");
  const result = await start({
    ...subject.capabilities,
    pathKind: (path) =>
      path === record
        ? Promise.resolve(ok("other" as const))
        : subject.capabilities.pathKind(path),
  });
  assert(!result.ok && result.error.includes("not a real file"));
  equal(subject.writes.get(record), "preserved target");
  assert(subject.calls.includes("signal"));
  assert(!subject.calls.includes("write"));
});
