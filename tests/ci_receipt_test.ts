import {
  beginReceipt,
  type CiReceipt,
  decodeCiReceipt,
  finishReceipt,
  readSessionReceipts,
  sessionReceiptDirectory,
  sessionReceiptId,
} from "../src/ci-receipt.ts";
import { assert, equal, inWorkspace, unwrap } from "./helpers.ts";

const sessionNames = ["MCI_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID"] as const;

const withSession = async (
  values: Readonly<Partial<Record<(typeof sessionNames)[number], string>>>,
  act: () => void | Promise<void>,
): Promise<void> => {
  const prior = sessionNames.map((name) => [name, Deno.env.get(name)] as const);
  const apply = (name: string, value: string | undefined) =>
    value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
  try {
    for (const name of sessionNames) apply(name, values[name]);
    await act();
  } finally {
    for (const [name, value] of prior) apply(name, value);
  }
};

const sha256 = async (value: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ).map((byte) => byte.toString(16).padStart(2, "0")).join("");

const failure = {
  kind: "failure",
  code: 1,
  detail: "tests failed",
  requestId: "request-1",
  log: "/tmp/request-1.log",
} as const;

const pending = {
  kind: "pending",
  code: null,
  detail: null,
  requestId: null,
  log: null,
} as const;

Deno.test("CI receipt session selection follows MCI, Codex session, then Codex thread", async () => {
  await withSession({}, () => equal(sessionReceiptId(), null));
  await withSession({ MCI_SESSION_ID: "" }, () => equal(sessionReceiptId(), null));
  await withSession({ CODEX_THREAD_ID: "thread" }, () => {
    equal(sessionReceiptId(), "thread");
  });
  await withSession(
    { CODEX_SESSION_ID: "session", CODEX_THREAD_ID: "thread" },
    () => equal(sessionReceiptId(), "session"),
  );
  await withSession(
    { MCI_SESSION_ID: "mci", CODEX_SESSION_ID: "session", CODEX_THREAD_ID: "thread" },
    () => equal(sessionReceiptId(), "mci"),
  );
});

Deno.test("CI receipts write nothing outside a session", () =>
  inWorkspace(async (workspace) =>
    await withSession({}, async () => {
      const home = `${workspace}/home`;
      const begun = await beginReceipt({
        workspace,
        workflow: "ci.yml",
        job: "check",
        command: "ci",
        home,
      });
      equal(unwrap(begun), null);
      unwrap(await finishReceipt(null, failure, home));
      await Deno.stat(home).then(
        () => assert(false, "home must stay absent"),
        (error) => assert(error instanceof Deno.errors.NotFound),
      );
    })
  ));

Deno.test("CI receipts write a pending file, then a final file with the same schema", () =>
  inWorkspace(async (workspace) =>
    await withSession({ MCI_SESSION_ID: "session-a" }, async () => {
      const home = `${workspace}/home`;
      await Deno.writeTextFile(`${workspace}/ci.yml`, "name: x\n");
      const begun = unwrap(
        await beginReceipt({
          workspace,
          workflow: "ci.yml",
          job: "check",
          command: "ci",
          home,
        }),
      );
      assert(begun !== null);
      const directory = unwrap(await sessionReceiptDirectory("session-a", home));
      equal(directory, `${home}/sessions/${await sha256("session-a")}`);
      const path = `${directory}/${begun.id}.json`;
      const written: unknown = JSON.parse(await Deno.readTextFile(path));
      equal(Object.keys(written as object), [
        "version",
        "id",
        "sessionId",
        "workspace",
        "workflow",
        "job",
        "command",
        "started",
        "finished",
        "outcome",
      ]);
      equal(begun.workflow, await Deno.realPath(`${workspace}/ci.yml`));
      equal(begun.outcome, pending);
      equal(begun.finished, null);

      unwrap(await finishReceipt(begun, failure, home));
      const [final] = unwrap(await readSessionReceipts("session-a", home));
      assert(final !== undefined && final.finished !== null);
      equal(final.id, begun.id);
      equal(final.outcome, failure);
      equal((await Deno.stat(path)).mode! & 0o777, 0o600);
      equal((await Deno.stat(directory)).mode! & 0o777, 0o700);
      equal([...Deno.readDirSync(directory)].map((entry) => entry.name), [
        `${begun.id}.json`,
      ]);
    })
  ));

Deno.test("CI receipts resolve links and keep the raw path of a missing workflow", () =>
  inWorkspace(async (workspace) =>
    await withSession({ MCI_SESSION_ID: "identity" }, async () => {
      const home = `${workspace}/home`;
      await Deno.mkdir(`${workspace}/real`);
      await Deno.writeTextFile(`${workspace}/real/ci.yml`, "name: x\n");
      await Deno.symlink(`${workspace}/real`, `${workspace}/link`);
      const input = {
        workspace: `${workspace}/link`,
        job: "check",
        command: "run",
        home,
      } as const;
      const linked = unwrap(await beginReceipt({ ...input, workflow: "ci.yml" }));
      equal(linked?.workspace, `${workspace}/real`);
      equal(linked?.workflow, `${workspace}/real/ci.yml`);
      const missing = unwrap(await beginReceipt({ ...input, workflow: "missing.yml" }));
      equal(missing?.workflow, `${workspace}/real/missing.yml`);
      const absolute = unwrap(
        await beginReceipt({ ...input, workflow: `${workspace}/nowhere.yml` }),
      );
      equal(absolute?.workflow, `${workspace}/nowhere.yml`);
    })
  ));

Deno.test("CI receipt completion never precedes the recorded start", () =>
  inWorkspace(async (workspace) => {
    const home = `${workspace}/home`;
    const future: CiReceipt = {
      version: 1,
      id: crypto.randomUUID(),
      sessionId: "clock",
      workspace,
      workflow: `${workspace}/ci.yml`,
      job: "check",
      command: "ci",
      started: "2999-01-01T00:00:00.000Z",
      finished: null,
      outcome: pending,
    };
    unwrap(await finishReceipt(future, failure, home));
    const [final] = unwrap(await readSessionReceipts("clock", home));
    equal(final?.finished, future.started);
  }));

Deno.test("CI receipt write failure is a Result error, not an exception", () =>
  inWorkspace(async (workspace) =>
    await withSession({ MCI_SESSION_ID: "blocked" }, async () => {
      const home = `${workspace}/home`;
      await Deno.writeTextFile(home, "a file where the service directory belongs");
      const begun = await beginReceipt({
        workspace,
        workflow: "ci.yml",
        job: "check",
        command: "ci",
        home,
      });
      assert(!begun.ok);
    })
  ));

Deno.test("CI receipt reader skips non-json entries and warns once per bad receipt", () =>
  inWorkspace(async (workspace) => {
    const home = `${workspace}/home`;
    const directory = unwrap(await sessionReceiptDirectory("reader", home));
    equal(unwrap(await readSessionReceipts("reader", home)), []);
    await Deno.mkdir(directory, { recursive: true });
    const good = (id: string, started: string): CiReceipt => ({
      version: 1,
      id,
      sessionId: "reader",
      workspace,
      workflow: `${workspace}/ci.yml`,
      job: "check",
      command: "ci",
      started,
      finished: started,
      outcome: failure,
    });
    const later = good(
      "00000000-0000-4000-8000-000000000002",
      "2026-10-05T00:00:00.000Z",
    );
    const earlier = good(
      "00000000-0000-4000-8000-000000000001",
      "2026-10-04T00:00:00.000Z",
    );
    for (const receipt of [later, earlier]) {
      await Deno.writeTextFile(
        `${directory}/${receipt.id}.json`,
        JSON.stringify(receipt),
      );
    }
    await Deno.writeTextFile(`${directory}/.codex-notified`, '["old"]');
    await Deno.writeTextFile(`${directory}/.codex-notified.lock`, "");
    await Deno.writeTextFile(`${directory}/broken.json`, "{");
    await Deno.writeTextFile(`${directory}/wrong.json`, '{"version":2}');
    const warnings: string[] = [];
    const receipts = unwrap(
      await readSessionReceipts("reader", home, (text) => warnings.push(text)),
    );
    equal(receipts.map((entry) => entry.id), [earlier.id, later.id]);
    equal(warnings.length, 2);
    assert(warnings.every((text) => text.includes("Skipped unreadable CI receipt")));
  }));

Deno.test("CI receipt decoder accepts every final state and rejects a wrong shape", () => {
  const base = {
    version: 1,
    id: crypto.randomUUID(),
    sessionId: "decode",
    workspace: "/w",
    workflow: "/w/ci.yml",
    job: "check",
    command: "ci",
    started: "2026-10-04T12:00:00.000Z",
    finished: "2026-10-04T12:01:00.000Z",
  };
  const outcome = (kind: string, code: number | null) => ({
    kind,
    code,
    detail: null,
    requestId: null,
    log: null,
  });
  for (
    const [kind, code] of [
      ["success", 0],
      ["failure", 1],
      ["timeout", 124],
      ["cancelled", 130],
      ["interrupted", 143],
      ["error", 2],
      ["unknown", 1],
    ] as const
  ) assert(decodeCiReceipt({ ...base, outcome: outcome(kind, code) }).ok, kind);
  assert(decodeCiReceipt({ ...base, finished: null, outcome: pending }).ok);
  assert(!decodeCiReceipt({ ...base, outcome: pending }).ok);
  assert(!decodeCiReceipt({ ...base, version: 2, outcome: outcome("success", 0) }).ok);
  assert(!decodeCiReceipt({ ...base, outcome: outcome("odd", 1) }).ok);
  assert(
    !decodeCiReceipt({ ...base, command: "check", outcome: outcome("success", 0) }).ok,
  );
  assert(!decodeCiReceipt(null).ok);
});
