import {
  normalizeStop,
  type ProcessCapabilities,
  type ProcessIdentity,
  type ProcessPolicy,
  recoverProcess,
  runProcess,
} from "../src/process.ts";
import { err, ok, type Result } from "../src/result.ts";
import { assert, equal, inWorkspace } from "./helpers.ts";

const policy: ProcessPolicy = { graceMs: 3, reapMs: 3, pollMs: 1 };

const scriptFile = async (workspace: string, source: string): Promise<string> => {
  const path = `${workspace}/private-step.sh`;
  await Deno.writeTextFile(path, source, { mode: 0o700 });
  return path;
};

const runNative = (
  workspace: string,
  script: string,
  extra: {
    readonly signal?: AbortSignal;
    readonly onStart?: Parameters<typeof runProcess>[0]["onStart"];
    readonly onFinish?: Parameters<typeof runProcess>[0]["onFinish"];
  } = {},
) =>
  runProcess({
    shell: "/bin/bash",
    script,
    cwd: workspace,
    env: { PATH: "/bin:/usr/bin" },
    signal: extra.signal ?? new AbortController().signal,
    onStart: extra.onStart,
    onFinish: extra.onFinish,
  });

const never = new Promise<Deno.CommandStatus>(() => {});

const fakeCapabilities = (input: {
  readonly status?: Promise<Deno.CommandStatus>;
  readonly group?: (signal: Deno.Signal | 0) => Result<boolean>;
  readonly direct?: (signal: Deno.Signal) => Result<boolean>;
  readonly identity?: Result<ProcessIdentity | null>;
} = {}): {
  readonly capabilities: ProcessCapabilities;
  readonly groupSignals: Array<Deno.Signal | 0>;
  readonly directSignals: Deno.Signal[];
} => {
  const groupSignals: Array<Deno.Signal | 0> = [];
  const directSignals: Deno.Signal[] = [];
  let now = 0;
  return {
    groupSignals,
    directSignals,
    capabilities: {
      launch: () =>
        Promise.resolve(ok({
          pid: 321,
          status: input.status ?? never,
        })),
      inspect: () =>
        Promise.resolve(
          input.identity ??
            ok({
              pid: 321,
              pgid: 321,
              started: "Fri Oct  2 11:09:09 2026",
              command: "/bin/bash /private/step.sh",
            }),
        ),
      signalGroup: (_pid, signal) => {
        groupSignals.push(signal);
        return Promise.resolve(input.group?.(signal) ?? ok(false));
      },
      signalProcess: (_pid, signal) => {
        directSignals.push(signal);
        return Promise.resolve(input.direct?.(signal) ?? ok(false));
      },
      now: () => now,
      delay: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    },
  };
};

Deno.test("normalizeStop maps unknown abort reasons to SIGTERM", () => {
  equal(normalizeStop("SIGINT"), "SIGINT");
  equal(normalizeStop("timeout"), "timeout");
  equal(normalizeStop(new Error("cancelled")), "SIGTERM");
  equal(normalizeStop(undefined), "SIGTERM");
});

Deno.test("runProcess preserves the existing successful exit behavior", () =>
  inWorkspace(async (workspace) => {
    const script = await scriptFile(workspace, "printf complete > result\n");
    const result = await runNative(workspace, script);
    equal(result, ok({ kind: "exited", code: 0 }));
    equal(await Deno.readTextFile(`${workspace}/result`), "complete");
  }));

Deno.test("runProcess records and finishes a supervised native process", () =>
  inWorkspace(async (workspace) => {
    const script = await scriptFile(workspace, "sleep 0.1\n");
    const events: string[] = [];
    const result = await runNative(workspace, script, {
      onStart: (record) => {
        events.push(`start:${record.pid}:${record.script}:${record.started}`);
        return Promise.resolve(ok(undefined));
      },
      onFinish: () => {
        events.push("finish");
        return Promise.resolve(ok(undefined));
      },
    });
    equal(result, ok({ kind: "exited", code: 0 }));
    equal(events.length, 2);
    assert(events[0]?.startsWith(`start:`));
    assert(events[0]?.includes(`:${script}:`));
    equal(events[1], "finish");
  }));

Deno.test("runProcess accepts a current process that already changed command", async () => {
  const fake = fakeCapabilities({
    status: Promise.resolve({ success: true, code: 0, signal: null }),
    identity: ok({
      pid: 321,
      pgid: 321,
      started: "Fri Oct  2 11:09:09 2026",
      command: "/usr/bin/exec-replacement",
    }),
  });
  equal(
    await runProcess({
      shell: "/bin/bash",
      script: "/private/step.sh",
      cwd: "/private",
      env: {},
      signal: new AbortController().signal,
    }, { capabilities: fake.capabilities, policy }),
    ok({ kind: "exited", code: 0 }),
  );
});

Deno.test("runProcess bounds reaping and retains cleanup diagnostics", async () => {
  const fake = fakeCapabilities({
    group: () => err("group denied"),
    direct: () => err("direct denied"),
  });
  let finished = false;
  const result = await runProcess({
    shell: "/bin/bash",
    script: "/private/step.sh",
    cwd: "/private",
    env: {},
    signal: new AbortController().signal,
    onStart: () => Promise.resolve(err("journal full")),
    onFinish: () => {
      finished = true;
      return Promise.resolve(ok(undefined));
    },
  }, { capabilities: fake.capabilities, policy });
  assert(!result.ok);
  assert(result.error.includes("Process registration failed: journal full"));
  assert(result.error.includes("Process group cleanup failed: group denied"));
  assert(result.error.includes("Direct process kill failed: direct denied"));
  assert(result.error.includes("Direct child reaping timed out after 3 ms"));
  equal(finished, false);
});

Deno.test("runProcess retains a rejected status and skips onFinish", async () => {
  const fake = fakeCapabilities({
    status: Promise.reject(new Error("status rejected")),
  });
  let finished = false;
  const result = await runProcess({
    shell: "/bin/bash",
    script: "/private/step.sh",
    cwd: "/private",
    env: {},
    signal: new AbortController().signal,
    onFinish: () => {
      finished = true;
      return Promise.resolve(ok(undefined));
    },
  }, { capabilities: fake.capabilities, policy });
  assert(!result.ok);
  assert(result.error.includes("Direct child status failed: status rejected"));
  equal(finished, false);
});

Deno.test("runProcess retains the exit code with cleanup failures", async () => {
  const fake = fakeCapabilities({
    status: Promise.resolve({ success: false, code: 23, signal: null }),
    group: () => err("group denied"),
  });
  const result = await runProcess({
    shell: "/bin/bash",
    script: "/private/step.sh",
    cwd: "/private",
    env: {},
    signal: new AbortController().signal,
  }, { capabilities: fake.capabilities, policy });
  assert(!result.ok);
  assert(result.error.startsWith("Process exited with code 23\n"));
  assert(result.error.includes("Process group cleanup failed: group denied"));
});

Deno.test("runProcess skips onFinish while group cleanup is uncertain", async () => {
  const fake = fakeCapabilities({
    status: Promise.resolve({ success: true, code: 0, signal: null }),
    group: () => ok(true),
    direct: () => ok(true),
  });
  let finished = false;
  const result = await runProcess({
    shell: "/bin/bash",
    script: "/private/step.sh",
    cwd: "/private",
    env: {},
    signal: new AbortController().signal,
    onFinish: () => {
      finished = true;
      return Promise.resolve(ok(undefined));
    },
  }, { capabilities: fake.capabilities, policy });
  assert(!result.ok);
  assert(result.error.includes("cleanup remains uncertain"));
  equal(finished, false);
});

Deno.test("runProcess normalizes an abnormal cancellation reason", async () => {
  const status = Promise.withResolvers<Deno.CommandStatus>();
  const fake = fakeCapabilities({
    status: status.promise,
    group: (signal) => {
      if (signal === "SIGTERM") {
        status.resolve({ success: false, code: 143, signal: "SIGTERM" });
      }
      return ok(false);
    },
  });
  const controller = new AbortController();
  const running = runProcess({
    shell: "/bin/bash",
    script: "/private/step.sh",
    cwd: "/private",
    env: {},
    signal: controller.signal,
  }, { capabilities: fake.capabilities, policy });
  controller.abort({ unexpected: true });
  equal(await running, ok({ kind: "stopped", reason: "SIGTERM" }));
});

Deno.test("recoverProcess rejects the wrong identity without killing it", async () => {
  const child = new Deno.Command("/bin/sleep", {
    args: ["10"],
    detached: true,
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    const result = await recoverProcess({
      pid: child.pid,
      started: "Mon Jan  1 00:00:00 1900",
      script: "/private/not-this-process.sh",
    });
    assert(!result.ok);
    assert(result.error.includes(String(child.pid)));
    Deno.kill(child.pid, 0);
  } finally {
    child.kill("SIGKILL");
    await child.status;
  }
});

Deno.test("recoverProcess accepts an already-gone process", async () => {
  equal(
    await recoverProcess({
      pid: 2_147_483_647,
      started: "Mon Jan  1 00:00:00 1900",
      script: "/private/gone.sh",
    }),
    ok(undefined),
  );
});

Deno.test("recoverProcess rejects an orphaned group without a kill signal", async () => {
  const fake = fakeCapabilities({ identity: ok(null), group: () => ok(true) });
  const result = await recoverProcess({
    pid: 321,
    started: "Fri Oct  2 11:09:09 2026",
    script: "/private/step.sh",
  }, { capabilities: fake.capabilities, policy });
  assert(!result.ok);
  assert(result.error.includes("leader is absent"));
  equal(fake.groupSignals, [0]);
});

Deno.test("recoverProcess waits for group disappearance after SIGKILL", async () => {
  const groupSignals: Array<Deno.Signal | 0> = [];
  let now = 0;
  let killed = false;
  let orphanChecks = 0;
  const capabilities: ProcessCapabilities = {
    launch: () => Promise.resolve(err("unused")),
    inspect: () =>
      Promise.resolve(
        killed ? ok(null) : ok({
          pid: 321,
          pgid: 321,
          started: "Fri Oct  2 11:09:09 2026",
          command: "/bin/bash /private/step.sh",
        }),
      ),
    signalGroup: (_pid, signal) => {
      groupSignals.push(signal);
      if (signal === "SIGKILL") killed = true;
      if (signal === 0 && killed) orphanChecks++;
      return Promise.resolve(ok(!(signal === 0 && killed && orphanChecks > 1)));
    },
    signalProcess: () => Promise.resolve(ok(false)),
    now: () => now,
    delay: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
  equal(
    await recoverProcess({
      pid: 321,
      started: "Fri Oct  2 11:09:09 2026",
      script: "/private/step.sh",
    }, { capabilities, policy }),
    ok(undefined),
  );
  assert(groupSignals.includes("SIGTERM"));
  assert(groupSignals.includes("SIGKILL"));
  equal(orphanChecks, 2);
});
