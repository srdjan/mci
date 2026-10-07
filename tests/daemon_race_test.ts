import { rpc, submit } from "../src/client.ts";
import { type DaemonStore, openDaemonStore } from "../src/daemon-store.ts";
import { startDaemon } from "../src/daemon.ts";
import { type ServicePaths, servicePaths } from "../src/paths.ts";
import type { Terminal } from "../src/protocol.ts";
import { err, ok, type Result } from "../src/result.ts";
import {
  assert,
  equal,
  exists,
  fixture,
  inWorkspace,
  sleep,
  waitFor,
} from "./helpers.ts";

type Gate = {
  readonly ready: Promise<void>;
  readonly arrive: () => void;
  readonly wait: () => Promise<void>;
  readonly release: () => void;
};

const gate = (): Gate => {
  const ready = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    ready: ready.promise,
    arrive: () => ready.resolve(),
    wait: () => released.promise,
    release: () => released.resolve(),
  };
};

const capturedEnv = (): Readonly<Record<string, string>> => ({
  PATH: Deno.env.get("PATH") ?? "/bin:/usr/bin",
});

const prepareRecovery = async (workspace: string, directory: string) => {
  const paths = servicePaths(directory);
  assert(paths.ok);
  const store = await openDaemonStore(paths.value);
  assert(store.ok);
  const repository = await store.value.register(workspace);
  assert(repository.ok);
  const save = async (id: string, finished: string): Promise<Terminal> => {
    const files = await store.value.allocate(workspace, id);
    assert(files.ok);
    const terminal: Terminal = {
      id,
      repositoryId: repository.value.id,
      workflow: "recovery.yml",
      job: "check",
      started: "2026-10-03T18:00:00.000Z",
      finished,
      kind: "success",
      code: 0,
      completed: 1,
      total: 1,
      detail: "completed",
      log: files.value.log,
    };
    await Deno.writeTextFile(terminal.log, id);
    assert(
      (await store.value.accept({
        id,
        repositoryId: terminal.repositoryId,
        workflow: terminal.workflow,
        job: terminal.job,
        started: terminal.started,
        log: terminal.log,
        total: 1,
        begun: true,
      })).ok,
    );
    return terminal;
  };
  return { store: store.value, save };
};

for (const projection of ["latest.json", "latest.log", "status.json"] as const) {
  Deno.test(`recorded terminal survives a ${projection} projection failure`, () =>
    inWorkspace(async (workspace) => {
      const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-project-" });
      try {
        const recovery = await prepareRecovery(workspace, directory);
        const terminal = await recovery.save(
          `blocked-${projection.replace(".", "-")}`,
          "2026-10-03T18:00:01.000Z",
        );
        assert((await recovery.store.writeTerminal(workspace, terminal)).ok);
        await Deno.mkdir(`${workspace}/.mci/ci/${projection}`);
        const projected = await recovery.store.projectTerminal(workspace, terminal);
        assert(!projected.ok);
        const repository = recovery.store.repositories()[0];
        assert(repository !== undefined);
        const recorded = await recovery.store.readTerminal(repository, terminal.id);
        assert(recorded.ok);
        equal(recorded.value, terminal);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    }));
}

Deno.test("terminal recording is idempotent and rejects a conflicting result", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-record-" });
    try {
      const recovery = await prepareRecovery(workspace, directory);
      const terminal = await recovery.save("immutable", "2026-10-03T18:00:01.000Z");
      assert((await recovery.store.writeTerminal(workspace, terminal)).ok);
      assert((await recovery.store.writeTerminal(workspace, terminal)).ok);
      const conflict: Terminal = {
        ...terminal,
        kind: "failure",
        code: 1,
        detail: "conflicting result",
      };
      const repeated = await recovery.store.writeTerminal(workspace, conflict);
      assert(!repeated.ok && repeated.error.includes("conflicting terminal"));
      const repository = recovery.store.repositories()[0];
      assert(repository !== undefined);
      const recorded = await recovery.store.readTerminal(repository, terminal.id);
      assert(recorded.ok);
      equal(recorded.value, terminal);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("terminal recording failure retains the pending journal entry", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-record-" });
    try {
      const recovery = await prepareRecovery(workspace, directory);
      const terminal = await recovery.save("blocked-record", "2026-10-03T18:00:01.000Z");
      await Deno.mkdir(`${workspace}/.mci/ci/requests/${terminal.id}.json`);
      assert(!(await recovery.store.writeTerminal(workspace, terminal)).ok);
      equal(recovery.store.pending().map((request) => request.id), [terminal.id]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("restart preserves the newest completion across multiple pending journal entries", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-recovery-" });
    try {
      const recovery = await prepareRecovery(workspace, directory);
      const first = await recovery.save("first", "2026-10-03T18:00:01.000Z");
      assert((await recovery.store.writeTerminal(workspace, first)).ok);
      assert((await recovery.store.projectTerminal(workspace, first)).ok);
      const second = await recovery.save("second", "2026-10-03T18:00:02.000Z");
      assert((await recovery.store.writeTerminal(workspace, second)).ok);
      assert((await recovery.store.projectTerminal(workspace, second)).ok);
      const daemon = await startDaemon({ directory });
      assert(daemon.ok);
      try {
        equal(daemon.value.snapshot().repositories[0]?.latest, second);
        equal(
          JSON.parse(await Deno.readTextFile(`${directory}/requests.json`)).requests,
          [],
        );
        assert(!await exists(first.log));
        assert(await exists(second.log));
      } finally {
        await daemon.value.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("restart accepts a pending completion found only in latest.json", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-latest-only-" });
    try {
      const recovery = await prepareRecovery(workspace, directory);
      const terminal = await recovery.save("latest-only", "2026-10-03T18:00:01.000Z");
      assert((await recovery.store.projectTerminal(workspace, terminal)).ok);
      assert(
        !await exists(`${workspace}/.mci/ci/requests/${terminal.id}.json`),
      );
      const daemon = await startDaemon({ directory });
      assert(daemon.ok, daemon.ok ? "" : daemon.error);
      try {
        equal(daemon.value.snapshot().repositories[0]?.latest, terminal);
        equal(
          JSON.parse(await Deno.readTextFile(`${directory}/requests.json`)).requests,
          [],
        );
        equal(await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`), "latest-only");
      } finally {
        await daemon.value.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("restart restores a durable completion after latest projection fails", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-projection-" });
    try {
      const recovery = await prepareRecovery(workspace, directory);
      const first = await recovery.save("first", "2026-10-03T18:00:01.000Z");
      assert((await recovery.store.writeTerminal(workspace, first)).ok);
      assert((await recovery.store.projectTerminal(workspace, first)).ok);
      assert((await recovery.store.finish(first.id)).ok);
      const second = await recovery.save("second", "2026-10-03T18:00:02.000Z");
      const reference = `${workspace}/.mci/ci/latest.json`;
      const prior = await Deno.readTextFile(reference);
      await Deno.remove(reference);
      await Deno.mkdir(reference);
      assert((await recovery.store.writeTerminal(workspace, second)).ok);
      assert(!(await recovery.store.projectTerminal(workspace, second)).ok);
      await Deno.remove(reference);
      await Deno.writeTextFile(reference, prior);
      const daemon = await startDaemon({ directory });
      assert(daemon.ok);
      try {
        equal(daemon.value.snapshot().repositories[0]?.latest, second);
        equal(
          JSON.parse(await Deno.readTextFile(`${directory}/requests.json`)).requests,
          [],
        );
        equal(await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`), "second");
        assert(await exists(second.log));
        assert(!await exists(first.log));
      } finally {
        await daemon.value.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("projection failure preserves the recorded workflow result for recovery", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-recorded-" });
    let projectionCalls = 0;
    let prior: Terminal | null = null;
    let completed: Terminal | null = null;
    try {
      const daemon = await startDaemon({
        directory,
        openStore: async (paths) => {
          const store = await openDaemonStore(paths);
          return store.ok
            ? ok({
              ...store.value,
              projectTerminal: async (path, terminal) => {
                projectionCalls += 1;
                if (projectionCalls === 2) {
                  await Deno.remove(`${path}/.mci/ci/latest.json`);
                  await Deno.mkdir(`${path}/.mci/ci/latest.json`);
                }
                return await store.value.projectTerminal(path, terminal);
              },
            })
            : store;
        },
      });
      assert(daemon.ok, daemon.ok ? "" : daemon.error);
      try {
        assert(
          (await rpc({ version: 1, op: "register", path: workspace }, directory)).ok,
        );
        const first = await submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "prior.yml",
            job: "check",
            source: fixture("      - run: printf prior >> executions"),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
        assert(first.ok, first.ok ? "" : first.error);
        equal(first.value.kind, "success");
        prior = first.value;
        const result = await submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "recorded.yml",
            job: "check",
            source: fixture("      - run: printf current >> executions"),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
        assert(result.ok, result.ok ? "" : result.error);
        equal(result.value.kind, "success");
        completed = result.value;
        const recorded = JSON.parse(
          await Deno.readTextFile(
            `${workspace}/.mci/ci/requests/${result.value.id}.json`,
          ),
        );
        equal(recorded, result.value);
        assert(
          daemon.value.snapshot().repositories[0]?.blocked?.includes("projection"),
        );
        equal(daemon.value.snapshot().repositories[0]?.latest, result.value);
        equal(
          JSON.parse(await Deno.readTextFile(`${directory}/requests.json`)).requests
            .length,
          1,
        );
        assert(await exists(prior.log));
        assert(await exists(result.value.log));
        equal(await Deno.readTextFile(`${workspace}/executions`), "priorcurrent");
      } finally {
        await daemon.value.close();
      }
      assert(prior !== null);
      assert(completed !== null);
      await Deno.remove(`${workspace}/.mci/ci/latest.json`);
      const restarted = await startDaemon({ directory });
      assert(restarted.ok, restarted.ok ? "" : restarted.error);
      try {
        equal(restarted.value.snapshot().repositories[0]?.latest, completed);
        equal(
          JSON.parse(await Deno.readTextFile(`${directory}/requests.json`)).requests,
          [],
        );
        equal(
          JSON.parse(await Deno.readTextFile(`${workspace}/.mci/ci/latest.json`)),
          completed,
        );
        equal(
          await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`),
          await Deno.readTextFile(completed.log),
        );
        equal(
          JSON.parse(await Deno.readTextFile(`${workspace}/.mci/ci/status.json`)),
          { version: 2, ...completed },
        );
        assert(!await exists(prior.log));
        assert(await exists(completed.log));
        equal(await Deno.readTextFile(`${workspace}/executions`), "priorcurrent");
      } finally {
        await restarted.value.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("ambiguous recording failure never replaces the recorded workflow result", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-recording-" });
    let writeCalls = 0;
    let recorded: Terminal | null = null;
    try {
      const daemon = await startDaemon({
        directory,
        openStore: async (paths) => {
          const store = await openDaemonStore(paths);
          return store.ok
            ? ok({
              ...store.value,
              writeTerminal: async (path, terminal) => {
                writeCalls += 1;
                const written = await store.value.writeTerminal(path, terminal);
                return written.ok ? err("injected sync failure") : written;
              },
            })
            : store;
        },
      });
      assert(daemon.ok, daemon.ok ? "" : daemon.error);
      try {
        assert(
          (await rpc({ version: 1, op: "register", path: workspace }, directory)).ok,
        );
        const result = await submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "ambiguous.yml",
            job: "check",
            source: fixture("      - run: printf once >> executions"),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
        assert(result.ok, result.ok ? "" : result.error);
        equal(result.value.kind, "failure");
        equal(writeCalls, 1);
        recorded = JSON.parse(
          await Deno.readTextFile(
            `${workspace}/.mci/ci/requests/${result.value.id}.json`,
          ),
        );
        equal(recorded?.kind, "success");
        assert(
          daemon.value.snapshot().repositories[0]?.blocked?.includes("storage"),
        );
        equal(
          JSON.parse(await Deno.readTextFile(`${directory}/requests.json`)).requests
            .length,
          1,
        );
      } finally {
        await daemon.value.close();
      }
      assert(recorded !== null);
      const restarted = await startDaemon({ directory });
      assert(restarted.ok, restarted.ok ? "" : restarted.error);
      try {
        equal(restarted.value.snapshot().repositories[0]?.latest, recorded);
        equal(
          JSON.parse(await Deno.readTextFile(`${directory}/requests.json`)).requests,
          [],
        );
        equal(await Deno.readTextFile(`${workspace}/executions`), "once");
      } finally {
        await restarted.value.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("restart recovers a pending request whose spool log is missing", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-missing-log-" });
    try {
      const recovery = await prepareRecovery(workspace, directory);
      const pending = await recovery.save("pending", "2026-10-03T18:00:01.000Z");
      await Deno.remove(`${workspace}/.mci`, { recursive: true });
      const daemon = await startDaemon({ directory });
      assert(daemon.ok, daemon.ok ? "" : daemon.error);
      try {
        const repository = daemon.value.snapshot().repositories[0];
        equal(repository?.blocked, null);
        equal(repository?.latest?.kind, "interrupted");
        equal(repository?.latest?.id, pending.id);
        equal(
          JSON.parse(await Deno.readTextFile(`${directory}/requests.json`)).requests,
          [],
        );
        equal(await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`), "");
        const result = await submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "after-recovery.yml",
            job: "check",
            source: fixture("      - run: touch after-recovery"),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
        assert(result.ok, result.ok ? "" : result.error);
        equal(result.value.kind, "success");
      } finally {
        await daemon.value.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("retention failure blocks later submissions without launching commands", () =>
  inWorkspace((workspace) =>
    withRaceDaemon(async (paths) => {
      const store = await openDaemonStore(paths);
      return store.ok
        ? ok({
          ...store.value,
          removeRun: () => Promise.resolve(err("injected retention failure")),
        })
        : store;
    }, async (directory) => {
      assert((await rpc({ version: 1, op: "register", path: workspace }, directory)).ok);
      const run = () =>
        submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "retention.yml",
            job: "check",
            source: fixture('      - run: "true"'),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
      assert((await run()).ok);
      assert((await run()).ok);
      const status = await rpc({ version: 1, op: "status" }, directory);
      assert(status.ok && status.value.repositories[0]?.blocked?.includes("retention"));
      assert(!(await run()).ok);
    })
  ));

Deno.test("a repository that becomes blocked settles its queued requests", () =>
  inWorkspace((workspace) =>
    withRaceDaemon(async (paths) => {
      const store = await openDaemonStore(paths);
      return store.ok
        ? ok({
          ...store.value,
          removeRun: () => Promise.resolve(err("injected retention failure")),
        })
        : store;
    }, async (directory) => {
      assert((await rpc({ version: 1, op: "register", path: workspace }, directory)).ok);
      const run = (name: string, command: string) =>
        submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: `${name}.yml`,
            job: "check",
            source: fixture(`      - run: ${command}`),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
      assert((await run("first", '"true"')).ok);
      const second = run(
        "second",
        "touch second-ready; while [ ! -f release ]; do sleep 0.01; done",
      );
      try {
        await waitFor(() => exists(`${workspace}/second-ready`));
        const third = run("third", "touch forbidden");
        await waitFor(async () => {
          const current = await rpc({ version: 1, op: "status" }, directory);
          return current.ok && current.value.repositories[0]?.queued === 1;
        });
        await Deno.writeTextFile(`${workspace}/release`, "release");
        const timer = Promise.withResolvers<null>();
        const timeout = setTimeout(() => timer.resolve(null), 2000);
        const settled = await Promise.race([third, timer.promise]).finally(() =>
          clearTimeout(timeout)
        );
        assert(settled !== null, "the queued request was not settled");
        assert(settled.ok, settled.ok ? "" : settled.error);
        equal(settled.value.kind, "failure");
        assert(settled.value.detail.includes("blocked"), settled.value.detail);
        assert(settled.value.detail.includes("retention"), settled.value.detail);
        assert(!await exists(`${workspace}/forbidden`));
      } finally {
        await Deno.writeTextFile(`${workspace}/release`, "release");
        await second;
      }
    })
  ));

Deno.test("startup pruning failure blocks commands and preserves recovery files", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-prune-" });
    try {
      const recovery = await prepareRecovery(workspace, directory);
      const saved = await recovery.save("saved", "2026-10-03T18:00:01.000Z");
      assert((await recovery.store.writeTerminal(workspace, saved)).ok);
      assert((await recovery.store.projectTerminal(workspace, saved)).ok);
      assert((await recovery.store.finish(saved.id)).ok);
      const daemon = await startDaemon({
        directory,
        openStore: async (paths) => {
          const store = await openDaemonStore(paths);
          return store.ok
            ? ok({
              ...store.value,
              pruneRuns: () => Promise.resolve(err("injected prune failure")),
            })
            : store;
        },
      });
      assert(daemon.ok);
      try {
        assert(daemon.value.snapshot().repositories[0]?.blocked?.includes("prune"));
        const result = await submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: "blocked.yml",
            job: "check",
            source: fixture("      - run: touch forbidden"),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
        assert(!result.ok);
        assert(!await exists(`${workspace}/forbidden`));
        assert(await exists(saved.log));
      } finally {
        await daemon.value.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

Deno.test("submission setup preserves FIFO when the first allocation waits", () =>
  inWorkspace(async (workspace) => {
    const allocation = gate();
    let allocations = 0;
    const openStore = async (paths: ServicePaths): Promise<Result<DaemonStore>> => {
      const opened = await openDaemonStore(paths);
      if (!opened.ok) return opened;
      return ok({
        ...opened.value,
        allocate: async (path, id) => {
          if (++allocations === 1) {
            allocation.arrive();
            await allocation.wait();
          }
          return await opened.value.allocate(path, id);
        },
      });
    };
    await withRaceDaemon(openStore, async (directory) => {
      assert((await rpc({ version: 1, op: "register", path: workspace }, directory)).ok);
      const run = (name: string) =>
        submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: `${name}.yml`,
            job: "check",
            source: fixture(`      - run: printf ${name} >> order`),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
      const first = run("first");
      await allocation.ready;
      const second = run("second");
      const release = setTimeout(allocation.release, 250);
      try {
        const results = await Promise.all([first, second]);
        assert(results.every((result) => result.ok));
        equal(await Deno.readTextFile(`${workspace}/order`), "firstsecond");
      } finally {
        clearTimeout(release);
        allocation.release();
      }
    });
  }));

Deno.test("restart preserves completion when request journal cleanup fails", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-crash-" });
    try {
      const first = await startDaemon({
        directory,
        openStore: async (paths) => {
          const opened = await openDaemonStore(paths);
          return opened.ok
            ? ok({
              ...opened.value,
              finish: () => Promise.resolve(err("injected journal failure")),
            })
            : opened;
        },
      });
      assert(first.ok);
      assert((await rpc({ version: 1, op: "register", path: workspace }, directory)).ok);
      const result = await submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "completed.yml",
          job: "check",
          source: fixture("      - run: printf once >> executions"),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      assert(result.ok && result.value.kind === "success");
      await first.value.close();
      const restarted = await startDaemon({ directory });
      assert(restarted.ok);
      try {
        const status = await rpc({ version: 1, op: "status" }, directory);
        assert(status.ok);
        equal(status.value.repositories[0]?.latest, result.value);
        equal(status.value.repositories[0]?.blocked, null);
        equal(await Deno.readTextFile(`${workspace}/executions`), "once");
        equal(
          JSON.parse(await Deno.readTextFile(`${directory}/requests.json`)).requests,
          [],
        );
      } finally {
        await restarted.value.close();
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));

const withRaceDaemon = async (
  openStore: (paths: ServicePaths) => Promise<Result<DaemonStore>>,
  test: (directory: string) => Promise<void>,
  resolvePath?: (path: string) => Promise<Result<string>>,
): Promise<void> => {
  const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-race-" });
  try {
    const started = await startDaemon({ directory, openStore, resolvePath });
    assert(started.ok, started.ok ? "" : started.error);
    try {
      await test(directory);
    } finally {
      await started.value.close();
      await started.value.closed;
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
};

Deno.test("slow repository resolution preserves submission ingress order", () =>
  inWorkspace(async (workspace) => {
    const resolution = gate();
    let resolutions = 0;
    await withRaceDaemon(openDaemonStore, async (directory) => {
      assert((await rpc({ version: 1, op: "register", path: workspace }, directory)).ok);
      const run = (name: string) =>
        submit(
          {
            version: 1,
            op: "submit",
            path: workspace,
            workflow: `${name}.yml`,
            job: "check",
            source: fixture(`      - run: printf ${name} >> ingress`),
            env: capturedEnv(),
          },
          new AbortController().signal,
          directory,
        );
      const first = run("first");
      await resolution.ready;
      const second = run("second");
      const release = setTimeout(resolution.release, 250);
      try {
        const results = await Promise.all([first, second]);
        assert(results.every((result) => result.ok));
        equal(await Deno.readTextFile(`${workspace}/ingress`), "firstsecond");
      } finally {
        clearTimeout(release);
        resolution.release();
      }
    }, async (path) => {
      if (++resolutions === 1) {
        resolution.arrive();
        await resolution.wait();
      }
      return ok(path);
    });
  }));

Deno.test("concurrent duplicate registration preserves the running repository", () =>
  inWorkspace(async (workspace) => {
    const firstRead = gate();
    let latestReads = 0;
    const openStore = async (paths: ServicePaths): Promise<Result<DaemonStore>> => {
      const opened = await openDaemonStore(paths);
      if (!opened.ok) return opened;
      return ok({
        ...opened.value,
        readLatest: async (repository) => {
          latestReads += 1;
          if (latestReads === 1) {
            firstRead.arrive();
            await firstRead.wait();
          }
          return await opened.value.readLatest(repository);
        },
      });
    };

    await withRaceDaemon(openStore, async (directory) => {
      const first = rpc({ version: 1, op: "register", path: workspace }, directory);
      await firstRead.ready;
      const second = rpc({ version: 1, op: "register", path: workspace }, directory);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      firstRead.release();
      const firstResult = await first;
      assert(firstResult.ok, firstResult.ok ? "" : firstResult.error);

      const submission = submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "duplicate-register.yml",
          job: "check",
          source: fixture("      - run: touch duplicate-register-finished"),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      const [secondResult, terminal] = await Promise.all([second, submission]);
      assert(secondResult.ok, secondResult.ok ? "" : secondResult.error);
      assert(terminal.ok, terminal.ok ? "" : terminal.error);
      equal(latestReads, 1);
      equal(
        firstResult.value.repositories[0]?.id,
        secondResult.value.repositories[0]?.id,
      );
      equal(secondResult.value.repositories.length, 1);

      const status = await rpc({ version: 1, op: "status" }, directory);
      assert(status.ok, status.ok ? "" : status.error);
      equal(status.value.repositories.length, 1);
      equal(status.value.repositories[0]?.latest?.id, terminal.value.id);
      assert(await exists(`${workspace}/duplicate-register-finished`));
    });
  }));

Deno.test("unregister rejects a submission waiting for allocation", () =>
  inWorkspace(async (workspace) => {
    const allocation = gate();
    const openStore = async (paths: ServicePaths): Promise<Result<DaemonStore>> => {
      const opened = await openDaemonStore(paths);
      if (!opened.ok) return opened;
      return ok({
        ...opened.value,
        allocate: async (path, id) => {
          allocation.arrive();
          await allocation.wait();
          return await opened.value.allocate(path, id);
        },
      });
    };

    await withRaceDaemon(openStore, async (directory) => {
      const registered = await rpc(
        { version: 1, op: "register", path: workspace },
        directory,
      );
      assert(registered.ok, registered.ok ? "" : registered.error);
      const repository = registered.value.repositories[0];
      assert(repository !== undefined);

      const submission = submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "unregister-race.yml",
          job: "check",
          source: fixture("      - run: touch unregister-race-finished"),
          env: capturedEnv(),
        },
        new AbortController().signal,
        directory,
      );
      await allocation.ready;
      const removed = await rpc(
        { version: 1, op: "unregister", repository: repository.id },
        directory,
      );
      allocation.release();
      assert(!removed.ok, removed.ok ? "" : removed.error);
      equal(removed.error, "busy: repository has accepted requests");
      const terminal = await submission;
      assert(terminal.ok, terminal.ok ? "" : terminal.error);
      assert(await exists(`${workspace}/unregister-race-finished`));

      const status = await rpc({ version: 1, op: "status" }, directory);
      assert(status.ok, status.ok ? "" : status.error);
      equal(status.value.repositories.length, 1);
      equal(status.value.repositories[0]?.id, repository.id);
      equal(status.value.repositories[0]?.latest?.id, terminal.value.id);

      const registry = await Deno.readTextFile(`${directory}/registry.json`);
      const snapshot = await Deno.readTextFile(`${directory}/snapshot.json`);
      assert(registry.includes(repository.id));
      assert(registry.includes(workspace));
      assert(snapshot.includes(repository.id));
      assert(snapshot.includes(terminal.value.id));
    });
  }));

// A detached process holds the worker output open after the worker exits. This opens a
// window between worker exit and job completion.
const lingeringStep = `      - run: |
          perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", "detached"); close $f; sleep 1' &
          while [ ! -f detached ]; do sleep 0.01; done
          touch done`;

// Submits the lingering step, then calls act after the worker exits and before the job
// completes.
const afterWorkerExit = (
  act: (late: {
    readonly workspace: string;
    readonly request: ReturnType<typeof submit>;
    readonly cancel: () => void;
    readonly close: () => Promise<void>;
  }) => Promise<void>,
) =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-late-" });
    const daemon = await startDaemon({ directory });
    assert(daemon.ok, daemon.ok ? "" : daemon.error);
    try {
      assert((await rpc({ version: 1, op: "register", path: workspace }, directory)).ok);
      const controller = new AbortController();
      const request = submit(
        {
          version: 1,
          op: "submit",
          path: workspace,
          workflow: "late.yml",
          job: "check",
          source: fixture(lingeringStep),
          env: capturedEnv(),
        },
        controller.signal,
        directory,
      );
      await waitFor(() => exists(`${workspace}/done`));
      await sleep(300);
      await act({
        workspace,
        request,
        cancel: () => controller.abort("SIGINT"),
        close: daemon.value.close,
      });
    } finally {
      await daemon.value.close();
      await Deno.remove(directory, { recursive: true });
    }
  });

Deno.test({
  name: "a cancel after the worker exits keeps the worker result",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    afterWorkerExit(async ({ request, cancel }) => {
      cancel();
      const result = await request;
      assert(result.ok, result.ok ? "" : result.error);
      equal(result.value.kind, "success");
    }),
});

Deno.test({
  name: "shutdown after the worker exits keeps the worker result",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    afterWorkerExit(async ({ workspace, request, close }) => {
      await close();
      await request;
      const latest = JSON.parse(
        await Deno.readTextFile(`${workspace}/.mci/ci/latest.json`),
      );
      equal(latest.kind, "success");
    }),
});

Deno.test("run removal treats a missing request directory as already removed", () =>
  inWorkspace(async (workspace) => {
    const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-service-" });
    try {
      const paths = servicePaths(directory);
      assert(paths.ok);
      const store = await openDaemonStore(paths.value);
      assert(store.ok, store.ok ? "" : store.error);
      assert(!await exists(`${workspace}/.mci/ci/requests`));
      const removed = await store.value.removeRun(workspace, "absent-request");
      assert(removed.ok, removed.ok ? "" : removed.error);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }));
