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
