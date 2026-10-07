import {
  beginReceipt,
  type CiReceiptOutcome,
  decodeCiReceipt,
  finishReceipt,
  readSessionReceipts,
  receiptPath,
  sessionReceiptDirectory,
  sessionReceiptId,
} from "../src/ci-receipt.ts";
import { assert, equal, exists, inWorkspace, unwrap } from "./helpers.ts";

const sessionNames = [
  "MCI_SESSION_ID",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
] as const;

const withSessionEnvironment = async (
  values: Readonly<Partial<Record<(typeof sessionNames)[number], string>>>,
  act: () => Promise<void>,
): Promise<void> => {
  const prior = Object.fromEntries(
    sessionNames.map((name) => [name, Deno.env.get(name)]),
  );
  try {
    for (const name of sessionNames) {
      const value = values[name];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await act();
  } finally {
    for (const name of sessionNames) {
      const value = prior[name];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
};

Deno.test("CI receipts use the selected session and canonical workflow identity", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ prefix: "mci receipt home " });
    try {
      await withSessionEnvironment({ MCI_SESSION_ID: "receipt-session" }, async () => {
        await Deno.writeTextFile(`${workspace}/ci.yml`, "name: receipt\n");
        await Deno.symlink(`${workspace}/ci.yml`, `${workspace}/linked.yml`);
        const receipt = unwrap(
          await beginReceipt({
            workspace,
            workflow: "./linked.yml",
            job: "check",
            command: "ci",
            home,
          }),
        );
        assert(receipt !== null);
        equal(receipt.sessionId, "receipt-session");
        equal(receipt.workspace, workspace);
        equal(receipt.workflow, `${workspace}/ci.yml`);
        equal(receipt.outcome.kind, "pending");
        equal(receipt.finished, null);

        const completed = unwrap(
          await finishReceipt(receipt, {
            kind: "success",
            code: 0,
            detail: "",
            requestId: "daemon-request",
            log: `${home}/request.log`,
          }, home),
        );
        assert(completed !== null);
        equal(completed.outcome.detail, "");
        assert(completed.finished !== null);

        const second = unwrap(
          await beginReceipt({
            workspace,
            workflow: `${workspace}/ci.yml`,
            job: "check",
            command: "run",
            home,
          }),
        );
        assert(second !== null);
        const saved = unwrap(await readSessionReceipts("receipt-session", home));
        equal(saved.length, 2);
        equal(saved.find((entry) => entry.id === receipt.id), completed);
        equal(saved.find((entry) => entry.id === second.id), second);

        const path = unwrap(await receiptPath("receipt-session", receipt.id, home));
        equal((await Deno.stat(path)).mode! & 0o777, 0o600);
        assert(!path.includes("receipt-session"));
      });
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("CI receipts resolve a symlink before a following parent component", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-order-" });
    try {
      const outside = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-target-" });
      try {
        await Deno.mkdir(`${outside}/child`);
        await Deno.writeTextFile(`${outside}/ci.yml`, "name: selected\n");
        await Deno.writeTextFile(`${workspace}/ci.yml`, "name: other\n");
        await Deno.symlink(`${outside}/child`, `${workspace}/alias`);
        const module = new URL("../src/ci-receipt.ts", import.meta.url).href;
        const source = `import { beginReceipt } from ${JSON.stringify(module)};
const result = await beginReceipt({
  workspace: Deno.args[0], workflow: Deno.args[1], job: "check",
  command: "run", home: Deno.args[2],
});
if (!result.ok) { console.error(result.error); Deno.exit(1); }`;
        for (
          const [index, workflow] of [
            "alias/../ci.yml",
            `${workspace}/alias/../ci.yml`,
          ].entries()
        ) {
          const sessionId = `component-order-${index}`;
          const output = await new Deno.Command(Deno.execPath(), {
            args: ["eval", "--allow-all", source, workspace, workflow, home],
            cwd: workspace,
            env: {
              MCI_SESSION_ID: sessionId,
              CODEX_SESSION_ID: "",
              CODEX_THREAD_ID: "",
            },
            stdout: "piped",
            stderr: "piped",
          }).output();
          assert(output.success, new TextDecoder().decode(output.stderr));
          const recorded = unwrap(await readSessionReceipts(sessionId, home))[0];
          assert(recorded !== undefined);
          equal(recorded.workflow, await Deno.realPath(`${outside}/ci.yml`));
          equal(await Deno.readTextFile(recorded.workflow), "name: selected\n");
        }
      } finally {
        await Deno.remove(outside, { recursive: true });
      }
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("CI receipts keep missing workflow identity after creation through a symlink", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-identity-" });
    try {
      await Deno.mkdir(`${workspace}/actual`);
      await Deno.symlink(`${workspace}/actual`, `${workspace}/alias`);
      await withSessionEnvironment({ MCI_SESSION_ID: "missing-identity" }, async () => {
        const input = {
          workspace,
          workflow: "alias/nested/ci.yml",
          job: "check",
          command: "run" as const,
          home,
        };
        const missing = unwrap(await beginReceipt(input));
        assert(missing !== null);
        await Deno.mkdir(`${workspace}/actual/nested`);
        await Deno.writeTextFile(`${workspace}/actual/nested/ci.yml`, "created");
        const created = unwrap(await beginReceipt(input));
        assert(created !== null);
        equal(missing.workflow, created.workflow);
        equal(created.workflow, `${workspace}/actual/nested/ci.yml`);
      });
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("CI receipts preserve relative dangling-link identity after target creation", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-dangling-" });
    try {
      await Deno.symlink("future/child", `${workspace}/alias`);
      await withSessionEnvironment({ MCI_SESSION_ID: "dangling-identity" }, async () => {
        const input = {
          workspace,
          workflow: "./alias/../ci.yml",
          job: "check",
          command: "run" as const,
          home,
        };
        const missing = unwrap(await beginReceipt(input));
        assert(missing !== null);
        equal(missing.workflow, `${workspace}/future/ci.yml`);
        await Deno.mkdir(`${workspace}/future/child`, { recursive: true });
        await Deno.writeTextFile(`${workspace}/future/ci.yml`, "created");
        const created = unwrap(await beginReceipt(input));
        assert(created !== null);
        equal(created.workflow, missing.workflow);
      });
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("CI receipt identity rejects link cycles and non-directory components", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-path-error-" });
    try {
      await Deno.symlink("cycle-b", `${workspace}/cycle-a`);
      await Deno.symlink("cycle-a", `${workspace}/cycle-b`);
      await Deno.writeTextFile(`${workspace}/file`, "not a directory");
      await withSessionEnvironment({ MCI_SESSION_ID: "path-errors" }, async () => {
        const cycle = await beginReceipt({
          workspace,
          workflow: "cycle-a/ci.yml",
          job: "check",
          command: "run",
          home,
        });
        assert(!cycle.ok);
        assert(cycle.error.includes("symbolic link cycle"), cycle.error);

        const notDirectory = await beginReceipt({
          workspace,
          workflow: "file/ci.yml",
          job: "check",
          command: "run",
          home,
        });
        assert(!notDirectory.ok);
        assert(
          notDirectory.error.toLowerCase().includes("not a directory"),
          notDirectory.error,
        );

        const trailingSlash = await beginReceipt({
          workspace,
          workflow: "file/",
          job: "check",
          command: "run",
          home,
        });
        assert(!trailingSlash.ok);
        assert(trailingSlash.error.toLowerCase().includes("not a directory"));
      });
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("CI receipt identity resolves a long non-cyclic link chain", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-link-chain-" });
    try {
      await Deno.mkdir(`${workspace}/actual`);
      await Deno.writeTextFile(`${workspace}/actual/ci.yml`, "selected");
      const linkCount = 64;
      for (let index = 0; index < linkCount; index += 1) {
        const target = index === linkCount - 1 ? "actual" : `link-${index + 1}`;
        await Deno.symlink(target, `${workspace}/link-${index}`);
      }
      try {
        await Deno.realPath(`${workspace}/link-0/ci.yml`);
        assert(false, "the fixture did not exceed the kernel symbolic-link limit");
      } catch (error) {
        assert(error instanceof Deno.errors.FilesystemLoop, String(error));
      }
      await withSessionEnvironment({ MCI_SESSION_ID: "long-link-chain" }, async () => {
        const receipt = unwrap(
          await beginReceipt({
            workspace,
            workflow: "link-0/ci.yml",
            job: "check",
            command: "run",
            home,
          }),
        );
        assert(receipt !== null);
        equal(receipt.workflow, `${workspace}/actual/ci.yml`);
      });
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test({
  name: "CI receipt identity returns permission failures without guessing a path",
  ignore: Deno.build.os === "windows",
  fn: () =>
    inWorkspace(async (workspace) => {
      const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-permission-" });
      const blocked = `${workspace}/blocked`;
      try {
        await Deno.mkdir(blocked, { mode: 0o700 });
        await Deno.chmod(blocked, 0o000);
        await withSessionEnvironment({ MCI_SESSION_ID: "permission-error" }, async () => {
          const result = await beginReceipt({
            workspace,
            workflow: "blocked/ci.yml",
            job: "check",
            command: "run",
            home,
          });
          assert(!result.ok);
          assert(result.error.includes("Permission denied"), result.error);
        });
      } finally {
        await Deno.chmod(blocked, 0o700);
        await Deno.remove(home, { recursive: true });
      }
    }),
});

Deno.test("CI receipt completion survives a clock before its recorded start", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-clock-" });
    try {
      await withSessionEnvironment({ MCI_SESSION_ID: "clock-receipt" }, async () => {
        const pending = unwrap(
          await beginReceipt({
            workspace,
            workflow: "ci.yml",
            job: "check",
            command: "run",
            home,
          }),
        );
        assert(pending !== null);
        const future = {
          ...pending,
          started: new Date(Date.now() + 60_000).toISOString(),
        };
        const completed = unwrap(
          await finishReceipt(future, {
            kind: "success",
            code: 0,
            detail: "passed",
            requestId: null,
            log: null,
          }, home),
        );
        assert(completed !== null);
        equal(completed.finished, future.started);
        equal(unwrap(await readSessionReceipts("clock-receipt", home)), [completed]);
      });
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("CI receipt session selection uses the documented precedence", async () => {
  await withSessionEnvironment({
    MCI_SESSION_ID: "mci",
    CODEX_SESSION_ID: "codex",
    CODEX_THREAD_ID: "thread",
  }, () => {
    equal(sessionReceiptId(), "mci");
    return Promise.resolve();
  });
  await withSessionEnvironment({
    CODEX_SESSION_ID: "codex",
    CODEX_THREAD_ID: "thread",
  }, () => {
    equal(sessionReceiptId(), "codex");
    return Promise.resolve();
  });
  await withSessionEnvironment({ CODEX_THREAD_ID: "thread" }, () => {
    equal(sessionReceiptId(), "thread");
    return Promise.resolve();
  });
});

Deno.test("CI receipt writes have no effect outside a session", () =>
  inWorkspace(async (workspace) => {
    const home = `${workspace}/service`;
    await withSessionEnvironment({}, async () => {
      equal(
        unwrap(
          await beginReceipt({
            workspace,
            workflow: "ci.yml",
            job: "check",
            command: "run",
            home,
          }),
        ),
        null,
      );
    });
    assert(!await exists(home));
  }));

Deno.test("CI receipt outcomes decode every final state", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ prefix: "mci receipt outcomes " });
    const outcomes: readonly CiReceiptOutcome[] = [
      { kind: "error", code: 2, detail: "invalid", requestId: null, log: null },
      { kind: "unknown", code: 1, detail: "lost", requestId: null, log: null },
      { kind: "success", code: 0, detail: null, requestId: null, log: null },
      { kind: "failure", code: 1, detail: "failed", requestId: null, log: null },
      { kind: "timeout", code: 124, detail: "timeout", requestId: null, log: null },
      { kind: "cancelled", code: 130, detail: "SIGINT", requestId: null, log: null },
      { kind: "interrupted", code: 1, detail: "restart", requestId: null, log: null },
    ];
    try {
      await withSessionEnvironment({ MCI_SESSION_ID: "outcomes" }, async () => {
        for (const [index, outcome] of outcomes.entries()) {
          const pending = unwrap(
            await beginReceipt({
              workspace,
              workflow: `missing-${index}.yml`,
              job: "check",
              command: "run",
              home,
            }),
          );
          assert(pending !== null);
          const finished = unwrap(await finishReceipt(pending, outcome, home));
          assert(finished !== null);
          assert(decodeCiReceipt(finished).ok);
        }
      });
      equal(
        (unwrap(await readSessionReceipts("outcomes", home))).length,
        outcomes.length,
      );
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("CI receipt storage rejects symlink directories and files", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-r-" });
    const outside = `${workspace}/outside`;
    try {
      await Deno.mkdir(outside);
      await Deno.symlink(outside, `${home}/sessions`);
      const readRejected = await readSessionReceipts("linked", home);
      assert(!readRejected.ok);
      assert(readRejected.error.includes("real directory"), readRejected.error);
      await withSessionEnvironment({ MCI_SESSION_ID: "linked" }, async () => {
        const rejected = await beginReceipt({
          workspace,
          workflow: "ci.yml",
          job: "check",
          command: "ci",
          home,
        });
        assert(!rejected.ok);
        assert(rejected.error.includes("real directory"), rejected.error);
      });

      await Deno.remove(`${home}/sessions`);
      await withSessionEnvironment({ MCI_SESSION_ID: "linked-file" }, async () => {
        const pending = unwrap(
          await beginReceipt({
            workspace,
            workflow: "ci.yml",
            job: "check",
            command: "ci",
            home,
          }),
        );
        assert(pending !== null);
        const path = unwrap(await receiptPath("linked-file", pending.id, home));
        await Deno.remove(path);
        await Deno.writeTextFile(`${workspace}/outside.json`, "outside");
        await Deno.symlink(`${workspace}/outside.json`, path);
        const rejected = await finishReceipt(pending, {
          kind: "success",
          code: 0,
          detail: "done",
          requestId: null,
          log: null,
        }, home);
        assert(!rejected.ok);
        assert(rejected.error.includes("real file"), rejected.error);
      });

      const directory = unwrap(await sessionReceiptDirectory("linked-file", home));
      assert(directory.startsWith(`${home}/sessions/`));
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));
