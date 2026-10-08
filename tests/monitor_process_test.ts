import {
  type MonitorProcessCapabilities,
  monitorRunningWith,
  quitMonitorWith,
} from "../src/monitor-process.ts";
import { captureCommand } from "../src/command.ts";
import { err, ok, type Result } from "../src/result.ts";
import { assert, equal } from "./helpers.ts";

type CommandCall = {
  readonly command: string;
  readonly args: readonly string[];
};

type Fake = {
  readonly calls: CommandCall[];
  readonly delays: number[];
  readonly capabilities: MonitorProcessCapabilities;
};

const fakeCapabilities = (results: readonly Result<number>[]): Fake => {
  const calls: CommandCall[] = [];
  const delays: number[] = [];
  let elapsed = 0;
  let index = 0;
  return {
    calls,
    delays,
    capabilities: {
      run: (command, args) => {
        calls.push({ command, args });
        const result = results[index];
        index += 1;
        return Promise.resolve(result ?? err("unexpected command"));
      },
      now: () => elapsed,
      delay: (ms) => {
        delays.push(ms);
        elapsed += ms;
        return Promise.resolve();
      },
    },
  };
};

Deno.test("monitor inspection matches the complete escaped executable path", async () => {
  const fake = fakeCapabilities([ok(0)]);
  const executable = "/Applications/mci [one]+ (test).app/MonitorApp";
  equal(await monitorRunningWith(executable, fake.capabilities), ok(true));
  equal(fake.calls, [{
    command: "/usr/bin/pgrep",
    args: [
      "-f",
      "^/Applications/mci \\[one\\]\\+ \\(test\\)\\.app/MonitorApp([[:space:]]|$)",
    ],
  }]);
});

const probeCapabilities = (commandLine: string): MonitorProcessCapabilities => ({
  run: async (command, args) => {
    assert(command === "/usr/bin/pgrep");
    const pattern = args[1];
    assert(pattern !== undefined);
    const child = new Deno.Command("/usr/bin/grep", {
      args: ["-E", "-q", pattern],
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(`${commandLine}\n`));
    await writer.close();
    return ok((await child.status).code);
  },
  now: () => 0,
  delay: () => Promise.resolve(),
});

Deno.test("monitor inspection enforces POSIX command boundaries", async () => {
  const executable = "/Applications/mci [one]+ (test).app/MonitorApp";
  const cases = [
    { command: executable, running: true },
    { command: `${executable} --workspace /tmp/one`, running: true },
    { command: `${executable}Helper --workspace /tmp/one`, running: false },
    { command: `/Other${executable}`, running: false },
    { command: `/usr/bin/tool --monitor ${executable}`, running: false },
  ] as const;
  for (const testCase of cases) {
    equal(
      await monitorRunningWith(executable, probeCapabilities(testCase.command)),
      ok(testCase.running),
    );
  }
});

Deno.test("monitor inspection maps absence and preserves diagnostics", async () => {
  const absent = fakeCapabilities([ok(1)]);
  equal(await monitorRunningWith("/MonitorApp", absent.capabilities), ok(false));

  const failed = fakeCapabilities([err("capture failed")]);
  equal(
    await monitorRunningWith("/MonitorApp", failed.capabilities),
    err("capture failed"),
  );

  const invalid = fakeCapabilities([ok(2)]);
  equal(
    await monitorRunningWith("/MonitorApp", invalid.capabilities),
    err("/usr/bin/pgrep exited with 2"),
  );
});

Deno.test("monitor quit sends SIGTERM once and waits for confirmed exit", async () => {
  const fake = fakeCapabilities([ok(0), ok(0), ok(0), ok(1)]);
  equal(await quitMonitorWith("/MonitorApp", fake.capabilities), ok(undefined));
  equal(fake.delays, [100, 100]);
  equal(fake.calls.filter((call) => call.command === "/usr/bin/pkill").length, 1);
  equal(fake.calls[0], {
    command: "/usr/bin/pkill",
    args: ["-TERM", "-f", "^/MonitorApp([[:space:]]|$)"],
  });
  assert(fake.calls.every((call) => !call.args.includes("-KILL")));
});

Deno.test("monitor quit accepts an absent process and reports command failures", async () => {
  const absent = fakeCapabilities([ok(1), ok(1)]);
  equal(await quitMonitorWith("/MonitorApp", absent.capabilities), ok(undefined));
  equal(absent.delays, []);

  const capture = fakeCapabilities([err("signal capture failed")]);
  equal(
    await quitMonitorWith("/MonitorApp", capture.capabilities),
    err("signal capture failed"),
  );

  const signal = fakeCapabilities([ok(2)]);
  equal(
    await quitMonitorWith("/MonitorApp", signal.capabilities),
    err("/usr/bin/pkill exited with 2"),
  );

  const inspection = fakeCapabilities([ok(0), err("inspection failed")]);
  equal(
    await quitMonitorWith("/MonitorApp", inspection.capabilities),
    err("inspection failed"),
  );
});

Deno.test("monitor quit reports the observation timeout without repeated signals", async () => {
  const running = Array.from({ length: 21 }, () => ok(0));
  const fake = fakeCapabilities([ok(0), ...running]);
  equal(
    await quitMonitorWith("/MonitorApp", fake.capabilities),
    err("The app at /MonitorApp did not quit within 2000 ms."),
  );
  equal(fake.delays, Array.from({ length: 20 }, () => 100));
  equal(fake.calls.filter((call) => call.command === "/usr/bin/pkill").length, 1);
});

const nativeCapabilities: MonitorProcessCapabilities = {
  run: async (command, args) => {
    const captured = await captureCommand(
      command,
      { args: [...args] },
      {
        timeoutMs: 5000,
        reapMs: 1000,
        maxStdoutBytes: 1024 * 1024,
        maxStderrBytes: 1024 * 1024,
      },
    );
    return captured.ok ? ok(captured.value.status.code) : captured;
  },
  now: () => performance.now(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const processExists = (pid: number): boolean => {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stopFixture = async (child: Deno.ChildProcess): Promise<void> => {
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  await child.status;
};

Deno.test({
  name: "native monitor quit ignores a sibling executable prefix",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const started = performance.now();
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "mci monitor [probe]+ (exact) " }),
    );
    const exactPath = `${root}/MonitorApp`;
    const siblingPath = `${root}/MonitorAppHelper`;
    await Deno.copyFile("/bin/sleep", exactPath);
    await Deno.copyFile("/bin/sleep", siblingPath);
    await Deno.chmod(exactPath, 0o755);
    await Deno.chmod(siblingPath, 0o755);
    for (const executable of [exactPath, siblingPath]) {
      equal(
        await nativeCapabilities.run("/usr/bin/codesign", [
          "--force",
          "--sign",
          "-",
          executable,
        ]),
        ok(0),
      );
    }
    const exact = new Deno.Command(exactPath, { args: ["10"] }).spawn();
    const sibling = new Deno.Command(siblingPath, { args: ["10"] }).spawn();
    try {
      equal(await monitorRunningWith(exactPath, nativeCapabilities), ok(true));
      equal(await monitorRunningWith(siblingPath, nativeCapabilities), ok(true));
      equal(await quitMonitorWith(exactPath, nativeCapabilities), ok(undefined));
      equal((await exact.status).signal, "SIGTERM");
      assert(!processExists(exact.pid), "the exact fixture must exit after SIGTERM");
      assert(processExists(sibling.pid), "the sibling fixture must remain active");
    } finally {
      await Promise.all([stopFixture(exact), stopFixture(sibling)]);
      await Deno.remove(root, { recursive: true });
    }
    assert(
      performance.now() - started < 1000,
      "the complete native fixture must finish below 1 s",
    );
  },
});
