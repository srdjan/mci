import { readCiStatus, runLoggedCi } from "../src/ci.ts";
import { assert, equal, exists, inWorkspace, unwrap, waitFor } from "./helpers.ts";

const text = (chunks: readonly Uint8Array[]): string => {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
};

const runShell = (
  workspace: string,
  script: string,
  signal?: AbortSignal,
  stdout?: (chunk: Uint8Array) => void,
  stderr?: (chunk: Uint8Array) => void,
) =>
  runLoggedCi({
    workspace,
    command: "/bin/sh",
    args: ["-c", script],
    signal,
    stdout,
    stderr,
  });

const killIfPresent = (send: () => void): void => {
  try {
    send();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};

Deno.test({
  name: "CI adapter cancels its workflow when the disposable parent dies",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await Deno.mkdir(`${workspace}/ci`);
      await Deno.writeTextFile(
        `${workspace}/ci/local-ci.yml`,
        `defaults:
  run:
    shell: bash
jobs:
  check:
    runs-on: macos-latest
    steps:
      - run: |
          trap 'printf stopped > stopped; exit 143' TERM
          echo $$ > job.pid
          touch ready
          while :; do :; done
`,
      );
      const childArgs = [
        "run",
        "--quiet",
        "--permission-set=mci",
        "--config",
        `${Deno.cwd()}/deno.json`,
        `${Deno.cwd()}/scripts/ci.ts`,
      ];
      const parentSource = `const child = new Deno.Command(${
        JSON.stringify(Deno.execPath())
      }, {
      args: ${JSON.stringify(childArgs)}, cwd: ${JSON.stringify(workspace)},
      env: { MCI_TASK_PARENT: "true" }, stdin: "null", stdout: "null", stderr: "null",
    }).spawn();
    await Deno.writeTextFile("logger.pid", String(child.pid));
    await child.status;`;
      const parentPath = `${workspace}/parent.ts`;
      await Deno.writeTextFile(parentPath, parentSource);
      const parent = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--quiet",
          "--permission-set=mci",
          "--config",
          `${Deno.cwd()}/deno.json`,
          parentPath,
        ],
        cwd: workspace,
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      let parentSettled = false;
      const parentStatus = parent.status.then((status) => {
        parentSettled = true;
        return status;
      });
      try {
        await waitFor(() => exists(`${workspace}/ready`));
        parent.kill("SIGKILL");
        await parentStatus;
        await waitFor(async () => {
          const status = await readCiStatus(workspace);
          return status.ok && status.value?.state === "cancelled";
        });
        equal(await Deno.readTextFile(`${workspace}/stopped`), "stopped");
        assert(!await exists(`${workspace}/.mci/run.json`));
        const status = unwrap(await readCiStatus(workspace));
        assert(status !== null);
        equal(status.code, 143);
        equal(unwrap(await runShell(workspace, "true")).code, 0);
      } finally {
        if (!parentSettled) {
          killIfPresent(() => parent.kill("SIGTERM"));
        }
        await parentStatus;
        if (await exists(`${workspace}/logger.pid`)) {
          const pid = Number(await Deno.readTextFile(`${workspace}/logger.pid`));
          killIfPresent(() => Deno.kill(pid, "SIGTERM"));
        }
      }
    }),
});

Deno.test("logged CI rejects a symlink log without changing its target", () =>
  inWorkspace(async (workspace) => {
    await Deno.mkdir(`${workspace}/.mci/ci`, { recursive: true });
    const target = `${workspace}/unrelated.txt`;
    await Deno.writeTextFile(target, "keep unrelated data\n");
    await Deno.symlink(target, `${workspace}/.mci/ci/latest.log`);

    const result = await runShell(workspace, "touch launched; printf replacement");
    assert(!result.ok && result.error.includes("CI log must be a real file"));
    equal(await Deno.readTextFile(target), "keep unrelated data\n");
    assert(!await exists(`${workspace}/launched`));
  }));

Deno.test("logged CI replaces a hard-linked log without changing its other link", () =>
  inWorkspace(async (workspace) => {
    await Deno.mkdir(`${workspace}/.mci/ci`, { recursive: true });
    const target = `${workspace}/unrelated.txt`;
    await Deno.writeTextFile(target, "keep unrelated data\n");
    await Deno.chmod(target, 0o644);
    await Deno.link(target, `${workspace}/.mci/ci/latest.log`);
    equal(unwrap(await runShell(workspace, "printf replacement")).code, 0);
    equal(await Deno.readTextFile(target), "keep unrelated data\n");
    equal(((await Deno.stat(target)).mode ?? 0) & 0o777, 0o644);
    assert(
      (await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`)).includes(
        "replacement",
      ),
    );
  }));

Deno.test("logged CI preserves the prior log when running status cannot be published", () =>
  inWorkspace(async (workspace) => {
    await Deno.mkdir(`${workspace}/.mci/ci/status.json`, { recursive: true });
    const path = `${workspace}/.mci/ci/latest.log`;
    await Deno.writeTextFile(path, "prior completed log\n");
    const result = await runShell(workspace, "touch launched");
    assert(!result.ok && result.error.includes("running status update failed"));
    equal(await Deno.readTextFile(path), "prior completed log\n");
    assert(!await exists(`${workspace}/launched`));
  }));

Deno.test("logged CI retains cancellation when the child exits zero", () =>
  inWorkspace(async (workspace) => {
    const controller = new AbortController();
    const running = runShell(
      workspace,
      "trap 'exit 0' TERM; touch ready; while :; do :; done",
      controller.signal,
    );
    try {
      await waitFor(() => exists(`${workspace}/ready`));
    } finally {
      controller.abort("SIGTERM");
    }
    const result = unwrap(await running);
    equal(result.code, 143);
    const status = unwrap(await readCiStatus(workspace));
    assert(status !== null);
    equal(status.state, "cancelled");
    equal(status.code, 143);
  }));

Deno.test("logged CI saves and forwards both streams on success", () =>
  inWorkspace(async (workspace) => {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const result = unwrap(
      await runShell(
        workspace,
        "printf 'standard output\\n'; printf 'standard error\\n' >&2",
        undefined,
        (chunk) => stdout.push(chunk.slice()),
        (chunk) => stderr.push(chunk.slice()),
      ),
    );

    equal(result, { code: 0, diagnostics: [] });
    equal(text(stdout), "standard output\n");
    equal(text(stderr), "standard error\n");
    const log = await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`);
    assert(log.includes("standard output\n"));
    assert(log.includes("standard error\n"));
    const status = unwrap(await readCiStatus(workspace));
    assert(status !== null);
    equal(status.state, "pass");
    equal(status.code, 0);
    assert(status.finished !== null);
  }));

Deno.test("logged CI retains exit 23 in the log, status, and result", () =>
  inWorkspace(async (workspace) => {
    const result = unwrap(
      await runShell(
        workspace,
        "printf 'failed output\\n'; printf 'failed error\\n' >&2; exit 23",
      ),
    );

    equal(result.code, 23);
    equal(result.diagnostics, []);
    const log = await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`);
    assert(log.includes("failed output\n"));
    assert(log.includes("failed error\n"));
    const status = unwrap(await readCiStatus(workspace));
    assert(status !== null);
    equal(status.state, "fail");
    equal(status.code, 23);
  }));

Deno.test("logged CI preserves exit 23 when an output sink fails", () =>
  inWorkspace(async (workspace) => {
    const result = unwrap(
      await runShell(
        workspace,
        "printf 'retained output\\n'; exit 23",
        undefined,
        () => Promise.reject(new Error("terminal closed")),
      ),
    );

    equal(result.code, 23);
    assert(result.diagnostics.some((detail) => detail.includes("terminal closed")));
    const log = await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`);
    assert(log.includes("retained output\n"));
    assert(log.includes("terminal closed"));
    assert(log.includes("[mci] exit 23"));
    const status = unwrap(await readCiStatus(workspace));
    assert(status !== null);
    equal(status.state, "fail");
    equal(status.code, 23);
  }));

Deno.test("logged CI converts a successful child with a sink failure to failure", () =>
  inWorkspace(async (workspace) => {
    const result = unwrap(
      await runShell(
        workspace,
        "printf 'child passed\\n'",
        undefined,
        () => Promise.reject(new Error("terminal closed")),
      ),
    );

    equal(result.code, 1);
    assert(result.diagnostics.some((detail) => detail.includes("terminal closed")));
    const status = unwrap(await readCiStatus(workspace));
    assert(status !== null);
    equal(status.state, "fail");
    equal(status.code, 1);
  }));

Deno.test("CI status reader distinguishes missing and invalid records", () =>
  inWorkspace(async (workspace) => {
    equal(unwrap(await readCiStatus(workspace)), null);
    await Deno.mkdir(`${workspace}/.mci/ci`, { recursive: true });
    await Deno.writeTextFile(
      `${workspace}/.mci/ci/status.json`,
      JSON.stringify({ version: 1, state: "pass" }),
    );
    const invalid = await readCiStatus(workspace);
    assert(!invalid.ok && invalid.error.includes("invalid CI status"));
  }));

Deno.test("logged CI records a missing command as a failure", () =>
  inWorkspace(async (workspace) => {
    const result = unwrap(
      await runLoggedCi({
        workspace,
        command: `${workspace}/missing-command`,
        args: [],
      }),
    );

    equal(result.code, 1);
    assert(result.diagnostics.some((detail) => detail.includes("launch")));
    const log = await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`);
    assert(log.includes("command launch failed"));
    assert(log.includes("[mci] exit 1"));
    const status = unwrap(await readCiStatus(workspace));
    assert(status !== null);
    equal(status.state, "fail");
    equal(status.code, 1);
  }));

Deno.test("logged CI excludes a competing writer without changing its files", () =>
  inWorkspace(async (workspace) => {
    const first = runShell(
      workspace,
      "printf 'first writer\\n'; while [ ! -f release ]; do :; done",
    );
    try {
      await waitFor(async () =>
        await exists(`${workspace}/.mci/ci/status.json`) &&
        (await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`)).includes(
          "first writer",
        )
      );
      const beforeStatus = await Deno.readTextFile(
        `${workspace}/.mci/ci/status.json`,
      );
      const beforeLog = await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`);
      const second = await runShell(workspace, "printf 'second writer\\n'");
      assert(!second.ok && second.error.includes("already running"));
      equal(await Deno.readTextFile(`${workspace}/.mci/ci/status.json`), beforeStatus);
      equal(await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`), beforeLog);
    } finally {
      await Deno.writeTextFile(`${workspace}/release`, "release");
      unwrap(await first);
    }
  }));

Deno.test("logged CI cancellation records cancelled and reaps the direct child", () =>
  inWorkspace(async (workspace) => {
    const controller = new AbortController();
    const running = runShell(
      workspace,
      "echo $$ > child.pid; touch ready; trap 'exit 143' TERM; while :; do :; done",
      controller.signal,
    );
    await waitFor(() => exists(`${workspace}/ready`));
    const pid = Number((await Deno.readTextFile(`${workspace}/child.pid`)).trim());
    controller.abort("SIGTERM");

    const result = unwrap(await running);
    equal(result.code, 143);
    const status = unwrap(await readCiStatus(workspace));
    assert(status !== null);
    equal(status.state, "cancelled");
    equal(status.code, 143);
    const absent = await Promise.resolve().then(() => {
      try {
        Deno.kill(pid, 0);
        return false;
      } catch (error) {
        return error instanceof Deno.errors.NotFound;
      }
    });
    assert(absent, `direct child ${pid} remains alive`);
  }));

const holderScript = "echo $$ > child.pid; sleep 5 & echo $! > holder.pid";

const killHolder = async (workspace: string): Promise<void> => {
  if (!await exists(`${workspace}/holder.pid`)) return;
  const pid = Number((await Deno.readTextFile(`${workspace}/holder.pid`)).trim());
  killIfPresent(() => Deno.kill(pid, "SIGKILL"));
};

Deno.test("logged CI cuts output that a detached process holds open", () =>
  inWorkspace(async (workspace) => {
    try {
      const began = performance.now();
      const result = unwrap(
        await runLoggedCi({
          workspace,
          command: "/bin/sh",
          args: ["-c", holderScript],
          outputGraceMs: 100,
        }),
      );
      const elapsed = performance.now() - began;
      assert(elapsed < 1500, `run took ${elapsed} ms`);
      equal(result.code, 1);
      const diagnostic = "stdout stayed open 100 ms after the command exited; " +
        "a detached process probably holds it";
      assert(
        result.diagnostics.some((detail) => detail.includes(diagnostic)),
        `missing grace diagnostic in ${JSON.stringify(result.diagnostics)}`,
      );
      const status = unwrap(await readCiStatus(workspace));
      assert(status !== null);
      equal(status.state, "fail");
      equal(status.code, 1);
      const log = await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`);
      assert(log.includes(`[mci] ${diagnostic}`), "log lacks the grace diagnostic");
      assert(log.includes("[mci] exit 1"), "log lacks the exit line");
      equal(unwrap(await runShell(workspace, "true")).code, 0);
    } finally {
      await killHolder(workspace);
    }
  }));

Deno.test("logged CI cancellation after exit cuts output that a detached process holds", () =>
  inWorkspace(async (workspace) => {
    const controller = new AbortController();
    const running = runLoggedCi({
      workspace,
      command: "/bin/sh",
      args: ["-c", holderScript],
      signal: controller.signal,
      outputGraceMs: 10000,
    });
    try {
      await waitFor(() => exists(`${workspace}/holder.pid`));
      const shellPid = Number((await Deno.readTextFile(`${workspace}/child.pid`)).trim());
      await waitFor(() =>
        Promise.resolve().then(() => {
          try {
            Deno.kill(shellPid, 0);
            return false;
          } catch (error) {
            return error instanceof Deno.errors.NotFound;
          }
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const began = performance.now();
      controller.abort("SIGINT");
      const result = unwrap(await running);
      const elapsed = performance.now() - began;
      assert(elapsed < 2000, `run took ${elapsed} ms after the abort`);
      equal(result.code, 130);
      const status = unwrap(await readCiStatus(workspace));
      assert(status !== null);
      equal(status.state, "cancelled");
      equal(status.code, 130);
      assert(
        result.diagnostics.some((detail) =>
          detail.includes("closed by cancellation after the command exited")
        ),
        `missing cancellation diagnostic in ${JSON.stringify(result.diagnostics)}`,
      );
    } finally {
      controller.abort("SIGINT");
      await running;
      await killHolder(workspace);
    }
  }));
