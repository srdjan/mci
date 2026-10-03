import { rpc, submit } from "../src/client.ts";
import { startDaemon } from "../src/daemon.ts";
import { readJson, sendJson } from "../src/ipc.ts";
import { servicePaths } from "../src/paths.ts";
import { cliSourceArgs } from "../src/runtime.ts";
import { assert, equal, exists, fixture, inWorkspace, waitFor } from "./helpers.ts";
import { withDaemon } from "./daemon_helpers.ts";

const capturedEnv = (extra: Readonly<Record<string, string>> = {}) => ({
  PATH: Deno.env.get("PATH") ?? "/bin:/usr/bin",
  ...extra,
});

Deno.test("socket disconnection cancels only its active owner and releases queued work", () =>
  inWorkspace((workspace) =>
    withDaemon(workspace, async (directory) => {
      const paths = servicePaths(directory);
      assert(paths.ok);
      const connection = await Deno.connect({
        transport: "unix",
        path: paths.value.socket,
      });
      let connected = true;
      try {
        assert(
          (await sendJson(connection, {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "disconnect.yml",
            job: "check",
            source: fixture(
              "      - run: trap 'touch stopped; exit 143' TERM; touch ready; while :; do sleep 0.01; done",
            ),
            env: capturedEnv(),
          })).ok,
        );
        await waitFor(() => exists(`${workspace}/ready`));
        const queued = submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "queued.yml",
            job: "check",
            source: fixture("      - run: test -f stopped; touch queued-finished"),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
        await waitFor(async () => {
          const status = await rpc({ version: 1, op: "status" }, directory);
          return status.ok && status.value.repositories[0]?.queued === 1;
        });
        connection.close();
        connected = false;
        const next = await queued;
        assert(next.ok && next.value.kind === "success");
        assert(await exists(`${workspace}/stopped`));
        assert(await exists(`${workspace}/queued-finished`));
        assert(!await exists(`${workspace}/.mci/run.json`));
      } finally {
        if (connected) connection.close();
      }
    })
  ));

Deno.test("daemon retains a connected client's old log and removes it after disconnect", () =>
  inWorkspace((workspace) =>
    withDaemon(workspace, async (directory) => {
      const paths = servicePaths(directory);
      assert(paths.ok);
      const connection = await Deno.connect({
        transport: "unix",
        path: paths.value.socket,
      });
      try {
        assert(
          (await sendJson(connection, {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "held.yml",
            job: "check",
            source: fixture("      - run: printf old-log"),
            env: capturedEnv(),
          })).ok,
        );
        const frames = readJson(connection);
        const accepted = await frames.next();
        assert(!accepted.done && accepted.value.ok);
        const final = await frames.next();
        assert(!final.done && final.value.ok);
        const first = await rpc({ version: 1, op: "status" }, directory);
        assert(first.ok && first.value.repositories[0]?.latest !== null);
        const log = first.value.repositories[0]!.latest!.log;
        const next = await submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "next.yml",
            job: "check",
            source: fixture("      - run: printf next-log"),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
        assert(next.ok);
        assert(await exists(log));
        connection.close();
        await waitFor(async () => !await exists(log));
        assert(await exists(next.value.log));
      } finally {
        try {
          connection.close();
        } catch { /* The connection is already closed. */ }
      }
    })
  ));

Deno.test("daemon restart prunes logs without a current result or connected owner", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-service-" });
    try {
      const first = await startDaemon({ directory });
      assert(first.ok);
      assert((await rpc({ version: 1, op: "register", path: workspace }, directory)).ok);
      const request = await submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "latest.yml",
          job: "check",
          source: fixture("      - run: printf latest-log"),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      assert(request.ok);
      await first.value.close();
      const obsolete = `${workspace}/.mci/ci/requests/obsolete.log`;
      await Deno.writeTextFile(obsolete, "old");
      const second = await startDaemon({ directory });
      assert(second.ok);
      try {
        assert(!await exists(obsolete));
        assert(await exists(request.value.log));
      } finally {
        await second.value.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("daemon shutdown closes idle clients and interrupts unfinished requests", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-service-" });
    const daemon = await startDaemon({ directory });
    assert(daemon.ok, daemon.ok ? "" : daemon.error);
    const paths = servicePaths(directory);
    assert(paths.ok, paths.ok ? "" : paths.error);
    const idle = await Deno.connect({ transport: "unix", path: paths.value.socket });
    try {
      assert((await rpc({ version: 1, op: "register", path: workspace }, directory)).ok);
      const request = submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "shutdown.yml",
          job: "check",
          source: fixture("      - run: touch ready; sleep 30; touch forbidden"),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      await waitFor(() => exists(`${workspace}/ready`));
      await daemon.value.close();
      assert(!(await request).ok);
      equal(await idle.read(new Uint8Array(1)), null);
      const latest = JSON.parse(
        await Deno.readTextFile(`${workspace}/.mci/ci/latest.json`),
      );
      equal(latest.kind, "interrupted");
      assert(!await exists(`${workspace}/forbidden`));
    } finally {
      idle.close();
      await daemon.value.close();
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("daemon runs a submitted job through its public socket", () =>
  inWorkspace((workspace) =>
    withDaemon(workspace, async (directory) => {
      const result = await submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "ci/test.yml",
          job: "check",
          source: fixture(
            "      - name: Build\n        run: printf daemon-output; touch artifact",
          ),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      assert(result.ok, result.ok ? "" : result.error);
      equal(result.value.kind, "success");
      assert(await exists(`${workspace}/artifact`));
      assert((await Deno.readTextFile(result.value.log)).includes("daemon-output"));
      const status = JSON.parse(
        await Deno.readTextFile(`${workspace}/.mci/ci/status.json`),
      );
      equal(status.version, 2);
      equal(status.id, result.value.id);
      const current = await rpc({ version: 1, op: "status" }, directory);
      assert(current.ok, current.ok ? "" : current.error);
      equal(current.value.repositories[0]?.latest?.id, result.value.id);
    })
  ));

Deno.test("registration during a held workspace lock does not block the repository", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-service-" });
    const started = await startDaemon({ directory });
    assert(started.ok, started.ok ? "" : started.error);
    await Deno.mkdir(`${workspace}/.mci`, { recursive: true });
    const lock = await Deno.open(`${workspace}/.mci/lock`, {
      create: true,
      read: true,
      write: true,
    });
    let held = await lock.tryLock(true);
    try {
      assert(held);
      const registered = await rpc(
        { version: 1, op: "register", path: workspace },
        directory,
      );
      assert(registered.ok, registered.ok ? "" : registered.error);
      equal(registered.value.repositories[0]?.blocked, null);
      await lock.unlock();
      held = false;
      const result = await submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "after-lock.yml",
          job: "check",
          source: fixture("      - run: touch after-lock"),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      assert(result.ok, result.ok ? "" : result.error);
      equal(result.value.kind, "success");
      assert(await exists(`${workspace}/after-lock`));
    } finally {
      if (held) await lock.unlock();
      lock.close();
      await started.value.close();
      await started.value.closed;
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("daemon validates before acceptance and does not create a spool", () =>
  inWorkspace((workspace) =>
    withDaemon(workspace, async (directory) => {
      const result = await submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "ci/test.yml",
          job: "missing",
          source: fixture("      - run: touch forbidden"),
          env: {},
        },
        new AbortController().signal,
        directory,
      );
      assert(!result.ok && result.error.includes("job not found"));
      assert(!await exists(`${workspace}/.mci/ci/requests`));
      assert(!await exists(`${workspace}/forbidden`));
    })
  ));

Deno.test("daemon imports a valid legacy registry once", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-service-" });
    try {
      await Deno.writeTextFile(
        `${directory}/monitor.json`,
        JSON.stringify({ version: 1, workspaces: [workspace] }),
      );
      const paths = servicePaths(directory);
      assert(paths.ok, paths.ok ? "" : paths.error);
      const started = await startDaemon({ directory });
      assert(started.ok, started.ok ? "" : started.error);
      try {
        const current = await rpc({ version: 1, op: "status" }, directory);
        assert(current.ok, current.ok ? "" : current.error);
        equal(current.value.repositories[0]?.path, workspace);
        assert(await exists(`${directory}/monitor.json`));
        assert(await exists(paths.value.registry));
      } finally {
        await started.value.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("daemon preserves a malformed legacy registry", async () => {
  const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-service-" });
  const legacy = `${directory}/monitor.json`;
  try {
    await Deno.writeTextFile(legacy, "{malformed");
    const started = await startDaemon({ directory });
    assert(!started.ok && started.error.includes("valid JSON"));
    equal(await Deno.readTextFile(legacy), "{malformed");
    assert(!await exists(`${directory}/registry.json`));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("daemon preserves FIFO and an idempotent register preserves queued work", () =>
  inWorkspace((workspace) =>
    withDaemon(workspace, async (directory) => {
      const first = submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "first.yml",
          job: "check",
          source: fixture(
            '      - run: touch first-ready; while [ ! -f release ]; do sleep 0.01; done; printf "$CAPTURED" >> order',
          ),
          env: capturedEnv({ CAPTURED: "first" }),
        },
        new AbortController().signal,
        directory,
      );
      await waitFor(() => exists(`${workspace}/first-ready`));
      const second = submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "second.yml",
          job: "check",
          source: fixture('      - run: printf "$CAPTURED" >> order'),
          env: capturedEnv({ CAPTURED: "second" }),
        },
        new AbortController().signal,
        directory,
      );
      await waitFor(async () => {
        const current = await rpc({ version: 1, op: "status" }, directory);
        return current.ok && current.value.repositories[0]?.queued === 1;
      });
      const registered = await rpc(
        { version: 1, op: "register", path: workspace },
        directory,
      );
      assert(registered.ok, registered.ok ? "" : registered.error);
      equal(registered.value.repositories[0]?.queued, 1);
      await Deno.writeTextFile(`${workspace}/release`, "release");
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert(firstResult.ok && secondResult.ok);
      equal(await Deno.readTextFile(`${workspace}/order`), "firstsecond");
    })
  ));

Deno.test("daemon runs different repositories concurrently", () =>
  inWorkspace(async (firstWorkspace) => {
    const secondWorkspace = await Deno.makeTempDir({ prefix: "mci second " });
    try {
      await withDaemon(firstWorkspace, async (directory) => {
        const registered = await rpc(
          { version: 1, op: "register", path: secondWorkspace },
          directory,
        );
        assert(registered.ok, registered.ok ? "" : registered.error);
        const run = (workspace: string, own: string, peer: string) =>
          submit(
            {
              version: 1,
              op: "submit",
              path: workspace,
              workflow: "concurrent.yml",
              job: "check",
              source: fixture(
                `      - run: touch ${own}; while [ ! -f '${peer}' ]; do sleep 0.01; done`,
              ),
              env: capturedEnv(),
            },
            new AbortController().signal,
            directory,
          );
        const [first, second] = await Promise.all([
          run(firstWorkspace, "ready", `${secondWorkspace}/ready`),
          run(secondWorkspace, "ready", `${firstWorkspace}/ready`),
        ]);
        assert(first.ok && second.ok);
      });
    } finally {
      await Deno.remove(secondWorkspace, { recursive: true });
    }
  }));

Deno.test("a queued cancellation does not cancel the active owner", () =>
  inWorkspace((workspace) =>
    withDaemon(workspace, async (directory) => {
      const first = submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "active.yml",
          job: "check",
          source: fixture(
            "      - run: touch active-ready; while [ ! -f release ]; do sleep 0.01; done; touch active-done",
          ),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      await waitFor(() => exists(`${workspace}/active-ready`));
      const controller = new AbortController();
      const second = submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "queued.yml",
          job: "check",
          source: fixture("      - run: touch forbidden"),
          env: capturedEnv(),
        },
        controller.signal,
        directory,
      );
      await waitFor(async () => {
        const current = await rpc({ version: 1, op: "status" }, directory);
        return current.ok && current.value.repositories[0]?.queued === 1;
      });
      controller.abort("SIGINT");
      const cancelled = await second;
      assert(cancelled.ok, cancelled.ok ? "" : cancelled.error);
      equal(cancelled.value.kind, "cancelled");
      await Deno.writeTextFile(`${workspace}/release`, "release");
      const completed = await first;
      assert(completed.ok && completed.value.kind === "success");
      assert(await exists(`${workspace}/active-done`));
      assert(!await exists(`${workspace}/forbidden`));
    })
  ));

Deno.test("a cancelled queued request does not replace the latest completed result", () =>
  inWorkspace((workspace) =>
    withDaemon(workspace, async (directory) => {
      const first = await submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "first.yml",
          job: "check",
          source: fixture("      - run: printf known-output"),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      assert(first.ok && first.value.kind === "success");
      const second = submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "second.yml",
          job: "check",
          source: fixture(
            "      - run: touch active-ready; while [ ! -f release ]; do sleep 0.01; done",
          ),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      try {
        await waitFor(() => exists(`${workspace}/active-ready`));
        const controller = new AbortController();
        const third = submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "third.yml",
            job: "check",
            source: fixture("      - run: touch forbidden"),
            env: capturedEnv(),
          },
          controller.signal,
          directory,
        );
        await waitFor(async () => {
          const current = await rpc({ version: 1, op: "status" }, directory);
          return current.ok && current.value.repositories[0]?.queued === 1;
        });
        controller.abort("SIGINT");
        const cancelled = await third;
        assert(cancelled.ok, cancelled.ok ? "" : cancelled.error);
        equal(cancelled.value.kind, "cancelled");
        const current = await rpc({ version: 1, op: "status" }, directory);
        assert(current.ok, current.ok ? "" : current.error);
        equal(current.value.repositories[0]?.latest?.id, first.value.id);
        const latest = JSON.parse(
          await Deno.readTextFile(`${workspace}/.mci/ci/latest.json`),
        );
        equal(latest.id, first.value.id);
        assert(
          (await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`)).includes(
            "known-output",
          ),
        );
        assert(await exists(first.value.log));
        assert(!await exists(`${workspace}/forbidden`));
      } finally {
        await Deno.writeTextFile(`${workspace}/release`, "release");
        await second;
      }
    })
  ));

Deno.test("an active cancellation cleans its process before the next request", () =>
  inWorkspace((workspace) =>
    withDaemon(workspace, async (directory) => {
      const controller = new AbortController();
      const active = submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "active.yml",
          job: "check",
          source: fixture(
            "      - run: trap 'touch stopped; exit 0' TERM; touch ready; while :; do sleep 0.01; done",
          ),
          env: capturedEnv(),
        },
        controller.signal,
        directory,
      );
      await waitFor(() => exists(`${workspace}/ready`));
      controller.abort("SIGTERM");
      const cancelled = await active;
      assert(cancelled.ok, cancelled.ok ? "" : cancelled.error);
      equal(cancelled.value.kind, "cancelled");
      assert(await exists(`${workspace}/stopped`));
      const next = await submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "next.yml",
          job: "check",
          source: fixture("      - run: touch next-done"),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      assert(next.ok && next.value.kind === "success");
      assert(await exists(`${workspace}/next-done`));
    })
  ));

Deno.test("an active run keeps the prior terminal and compatibility log", () =>
  inWorkspace((workspace) =>
    withDaemon(workspace, async (directory) => {
      const first = await submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "first.yml",
          job: "check",
          source: fixture("      - run: printf prior-output"),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      assert(first.ok, first.ok ? "" : first.error);
      const second = submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "second.yml",
          job: "check",
          source: fixture(
            "      - run: touch active-ready; while [ ! -f release ]; do sleep 0.01; done; printf next-output",
          ),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      await waitFor(() => exists(`${workspace}/active-ready`));
      const current = await rpc({ version: 1, op: "status" }, directory);
      assert(current.ok, current.ok ? "" : current.error);
      equal(current.value.repositories[0]?.latest?.id, first.value.id);
      assert(
        (await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`)).includes(
          "prior-output",
        ),
      );
      await Deno.writeTextFile(`${workspace}/release`, "release");
      assert((await second).ok);
    })
  ));

Deno.test("a client that does not read cannot block its worker", () =>
  inWorkspace((workspace) =>
    withDaemon(workspace, async (directory) => {
      const paths = servicePaths(directory);
      assert(paths.ok, paths.ok ? "" : paths.error);
      const connection = await Deno.connect({
        transport: "unix",
        path: paths.value.socket,
      });
      try {
        const sent = await sendJson(connection, {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "slow-client.yml",
          job: "check",
          source: fixture(
            "      - run: dd if=/dev/zero bs=1024 count=256 2>/dev/null; touch completed",
          ),
          env: capturedEnv(),
        });
        assert(sent.ok, sent.ok ? "" : sent.error);
        await waitFor(() => exists(`${workspace}/completed`));
        await waitFor(async () => {
          const current = await rpc({ version: 1, op: "status" }, directory);
          return current.ok && current.value.repositories[0]?.latest?.kind === "success";
        });
      } finally {
        connection.close();
      }
    })
  ));

Deno.test({
  name: "daemon restart marks an accepted request interrupted without retry",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-service-" });
      const daemon = new Deno.Command(Deno.execPath(), {
        args: cliSourceArgs(["daemon"]),
        env: { ...Deno.env.toObject(), MCI_HOME: directory },
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      try {
        const paths = servicePaths(directory);
        assert(paths.ok, paths.ok ? "" : paths.error);
        await waitFor(() => exists(paths.value.socket));
        const registered = await rpc(
          { version: 1, op: "register", path: workspace },
          directory,
        );
        assert(registered.ok, registered.ok ? "" : registered.error);
        const request = submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "interrupted.yml",
            job: "check",
            source: fixture("      - run: touch started; sleep 30; touch forbidden"),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
        await waitFor(() => exists(`${workspace}/started`));
        daemon.kill("SIGKILL");
        await daemon.status;
        assert(!(await request).ok);
        await waitFor(async () => !await exists(`${workspace}/.mci/run.json`));
        const restarted = await startDaemon({ directory });
        assert(restarted.ok, restarted.ok ? "" : restarted.error);
        try {
          const current = await rpc({ version: 1, op: "status" }, directory);
          assert(current.ok, current.ok ? "" : current.error);
          equal(current.value.repositories[0]?.latest?.kind, "interrupted");
          assert(!await exists(`${workspace}/forbidden`));
        } finally {
          await restarted.value.close();
        }
      } finally {
        try {
          daemon.kill("SIGKILL");
        } catch { /* The daemon already exited. */ }
        await daemon.status;
        await Deno.remove(directory, { recursive: true });
      }
    }),
});
