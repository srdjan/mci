import { captureCommand } from "../src/command.ts";
import { assert, equal, exists, waitFor } from "./helpers.ts";

const capturePolicy = (
  maxStdoutBytes: number,
  maxStderrBytes: number,
  timeoutMs = 500,
  reapMs = 500,
) => ({ timeoutMs, reapMs, maxStdoutBytes, maxStderrBytes });

const processExists = (pid: number): boolean => {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

const stopFixtureProcess = async (pid: number | null): Promise<void> => {
  if (pid === null || !processExists(pid)) return;
  Deno.kill(pid, "SIGKILL");
  await waitFor(() => Promise.resolve(!processExists(pid)), 500);
};

const readFixturePid = async (path: string): Promise<number> => {
  await waitFor(() => exists(path), 500);
  const pid = Number(await Deno.readTextFile(path));
  assert(Number.isSafeInteger(pid) && pid > 0, `invalid fixture PID: ${pid}`);
  return pid;
};

Deno.test("captureCommand returns status and both output streams", async () => {
  const result = await captureCommand(
    "/bin/sh",
    { args: ["-c", "printf captured; printf diagnostic >&2"] },
    capturePolicy(1024, 1024),
  );
  assert(result.ok);
  equal(result.value.status.code, 0);
  equal(new TextDecoder().decode(result.value.stdout), "captured");
  equal(new TextDecoder().decode(result.value.stderr), "diagnostic");
});

Deno.test("captureCommand returns a launch failure", async () => {
  const result = await captureCommand(
    "/missing/mci-command",
    {},
    capturePolicy(1024, 1024, 10, 10),
  );
  assert(!result.ok);
  assert(result.error.includes("Unable to launch command /missing/mci-command"));
});

Deno.test("captureCommand kills and reaps a timed out command", async () => {
  const result = await captureCommand(
    "/bin/sleep",
    { args: ["10"] },
    capturePolicy(1024, 1024, 10, 500),
  );
  assert(!result.ok);
  equal(result.error, "Command /bin/sleep timed out after 10 ms");
});

Deno.test("captureCommand closes stderr held by a child process", async () => {
  const result = await captureCommand(
    "/bin/sh",
    { args: ["-c", "(while printf x >&2; do sleep 0.01; done) &"] },
    capturePolicy(1024, 1024, 10, 100),
  );
  assert(!result.ok);
  equal(result.error, "Command /bin/sh timed out after 10 ms");
});

Deno.test("captureCommand rejects stdout above its independent byte cap", async () => {
  const policy = capturePolicy(4, 100);
  const result = await captureCommand(
    "/bin/sh",
    { args: ["-c", "printf 12345; printf diagnostic >&2"] },
    policy,
  );
  assert(!result.ok);
  equal(result.error, "Command /bin/sh stdout exceeded 4 byte capture limit");
});

Deno.test("captureCommand rejects stderr above its independent byte cap", async () => {
  const policy = capturePolicy(100, 4);
  const result = await captureCommand(
    "/bin/sh",
    { args: ["-c", "printf captured; printf 12345 >&2"] },
    policy,
  );
  assert(!result.ok);
  equal(result.error, "Command /bin/sh stderr exceeded 4 byte capture limit");
});

Deno.test("captureCommand accepts output at each exact byte cap", async () => {
  const policy = capturePolicy(5, 4);
  const result = await captureCommand(
    "/bin/sh",
    { args: ["-c", "printf 12345; printf 6789 >&2"] },
    policy,
  );
  assert(result.ok);
  equal(new TextDecoder().decode(result.value.stdout), "12345");
  equal(new TextDecoder().decode(result.value.stderr), "6789");
});

Deno.test("captureCommand counts multibyte output as raw bytes", async () => {
  const oneBytePolicy = capturePolicy(1, 0);
  const overflow = await captureCommand(
    "/bin/sh",
    { args: ["-c", "printf é"] },
    oneBytePolicy,
  );
  assert(!overflow.ok);
  equal(overflow.error, "Command /bin/sh stdout exceeded 1 byte capture limit");

  const twoBytePolicy = capturePolicy(2, 0);
  const exact = await captureCommand(
    "/bin/sh",
    { args: ["-c", "printf é"] },
    twoBytePolicy,
  );
  assert(exact.ok);
  equal(exact.value.stdout, new TextEncoder().encode("é"));
});

Deno.test("captureCommand accepts empty streams with zero byte caps", async () => {
  const policy = capturePolicy(0, 0);
  const result = await captureCommand("/bin/sh", { args: ["-c", "exit 0"] }, policy);
  assert(result.ok);
  equal(result.value.stdout.length, 0);
  equal(result.value.stderr.length, 0);
});

Deno.test("captureCommand rejects nonempty output with a zero byte cap", async () => {
  const policy = capturePolicy(0, 0);
  const result = await captureCommand(
    "/bin/sh",
    { args: ["-c", "printf x"] },
    policy,
  );
  assert(!result.ok);
  equal(result.error, "Command /bin/sh stdout exceeded 0 byte capture limit");
});

Deno.test("captureCommand rejects invalid caps before command launch", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mci-capture-cap-" });
  try {
    const invalidPolicies = [
      capturePolicy(-1, 0),
      capturePolicy(Number.NaN, 0),
      capturePolicy(1.5, 0),
      capturePolicy(Number.MAX_SAFE_INTEGER + 1, 0),
      capturePolicy(0, Number.POSITIVE_INFINITY),
    ];
    for (const [index, policy] of invalidPolicies.entries()) {
      const marker = `${directory}/${index}`;
      const result = await captureCommand(
        "/bin/sh",
        { args: ["-c", 'printf launched > "$1"', "capture", marker] },
        policy,
      );
      assert(!result.ok);
      assert(result.error.includes("capture limit must be a nonnegative safe integer"));
      assert(!(await exists(marker)), `invalid policy ${index} launched its command`);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("captureCommand kills and reaps a live child after overflow", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mci-capture-live-" });
  const pidPath = `${directory}/pid`;
  let pid: number | null = null;
  try {
    const policy = capturePolicy(4, 0, 5_000, 500);
    const result = await captureCommand(
      "/bin/sh",
      {
        args: [
          "-c",
          'printf "%s" "$$" > "$1"; while :; do printf 12345; sleep 0.01; done',
          "capture",
          pidPath,
        ],
      },
      policy,
    );
    pid = await readFixturePid(pidPath);
    assert(!result.ok);
    equal(result.error, "Command /bin/sh stdout exceeded 4 byte capture limit");
    assert(!processExists(pid), `overflowed command ${pid} still exists`);
  } finally {
    await stopFixtureProcess(pid);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("captureCommand closes descendant-held pipes after the child exits", async () => {
  const directory = await Deno.makeTempDir({ prefix: "mci-capture-descendant-" });
  const pidPath = `${directory}/pid`;
  let pid: number | null = null;
  try {
    const policy = capturePolicy(4, 100, 5_000, 500);
    const started = performance.now();
    const result = await captureCommand(
      "/bin/sh",
      {
        args: [
          "-c",
          'parent="$$"; (/bin/sh -c \'printf "%s" "$$" > "$1"; while kill -0 "$2" 2>/dev/null; do sleep 0.005; done; printf 12345; while :; do printf y >&2; sleep 0.01; done\' capture "$1" "$parent") &',
          "capture",
          pidPath,
        ],
      },
      policy,
    );
    const elapsed = performance.now() - started;
    const fixturePid = await readFixturePid(pidPath);
    pid = fixturePid;
    assert(!result.ok);
    equal(result.error, "Command /bin/sh stdout exceeded 4 byte capture limit");
    assert(elapsed < 500, `pipe cleanup took ${elapsed} ms`);
    await waitFor(() => Promise.resolve(!processExists(fixturePid)), 500);
  } finally {
    await stopFixtureProcess(pid);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("captureCommand returns a stable overflow before its capture deadline", async () => {
  const policy = capturePolicy(4, 0, 5_000, 500);
  const started = performance.now();
  const result = await captureCommand(
    "/bin/sh",
    { args: ["-c", "while :; do printf 12345; sleep 0.01; done"] },
    policy,
  );
  const elapsed = performance.now() - started;
  assert(!result.ok);
  equal(result.error, "Command /bin/sh stdout exceeded 4 byte capture limit");
  assert(elapsed < 500, `overflow returned after ${elapsed} ms`);
});

Deno.test("captureCommand preserves under-cap bytes for a failed exit", async () => {
  const policy = capturePolicy(8, 10);
  const result = await captureCommand(
    "/bin/sh",
    { args: ["-c", "printf failure; printf diagnostic >&2; exit 7"] },
    policy,
  );
  assert(result.ok);
  equal(result.value.status.code, 7);
  equal(new TextDecoder().decode(result.value.stdout), "failure");
  equal(new TextDecoder().decode(result.value.stderr), "diagnostic");
});
