import {
  decodeRequest,
  decodeResponse,
  decodeSnapshot,
  decodeTerminal,
  finishTime,
} from "../src/protocol.ts";
import { assert, equal } from "./helpers.ts";

Deno.test("IPC rejects unknown versions, fields, and malformed environments", () => {
  assert(decodeRequest({ version: 1, op: "ping" }).ok);
  for (
    const request of [
      { version: 2, op: "ping" },
      { version: 1, op: "ping", extra: true },
      { version: 1, op: "register", path: "relative" },
      { version: 1, op: "cancel", reason: "timeout" },
      {
        version: 1,
        op: "submit",
        path: "/repo",
        workflow: "ci.yml",
        job: "check",
        source: "",
        env: { SECRET: 5 },
      },
      {
        version: 1,
        op: "submit",
        path: "/repo",
        workflow: "ci.yml",
        job: "check",
        source: "",
        env: { "BAD=KEY": "value" },
      },
    ]
  ) assert(!decodeRequest(request).ok);
  assert(
    !decodeResponse({ version: 1, type: "accepted", id: "run", log: "relative" }).ok,
  );
});

Deno.test("daemon snapshot fixtures use the same boundary as the native monitor", async () => {
  const directory = new URL("./fixtures/daemon/", import.meta.url);
  let checked = 0;
  for await (const entry of Deno.readDir(directory)) {
    if (
      !entry.name.startsWith("snapshot-") ||
      !(entry.name.endsWith(".json") || entry.name.endsWith(".txt"))
    ) continue;
    const raw = await Deno.readTextFile(new URL(entry.name, directory));
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    assert(
      decodeSnapshot(value).ok === entry.name.startsWith("snapshot-valid-"),
      entry.name,
    );
    checked++;
  }
  assert(checked > 0, "Missing shared daemon fixtures");
});

Deno.test("a finish time never comes before its start time", () => {
  const started = "2026-10-04T12:00:00.000Z";
  equal(finishTime(started, "2026-10-04T12:00:01.000Z"), "2026-10-04T12:00:01.000Z");
  equal(finishTime(started, started), started);
  equal(finishTime(started, "2026-10-04T11:59:59.000Z"), started);
  equal(
    finishTime("+010000-01-01T00:00:00.000Z", started),
    "+010000-01-01T00:00:00.000Z",
  );
  equal(
    finishTime("9999-12-31T23:59:59.999Z", "+010000-01-01T00:00:00.000Z"),
    "+010000-01-01T00:00:00.000Z",
  );
});

Deno.test("terminal decoding compares extended ISO years by time", () => {
  const terminal = {
    id: "run",
    repositoryId: "repository",
    workflow: "check.yml",
    job: "check",
    kind: "success",
    code: 0,
    completed: 1,
    total: 1,
    detail: "",
    log: "/tmp/run.log",
  };
  assert(
    decodeTerminal({
      ...terminal,
      started: "9999-12-31T23:59:59.999Z",
      finished: "+010000-01-01T00:00:00.000Z",
    }).ok,
  );
  assert(
    !decodeTerminal({
      ...terminal,
      started: "+010000-01-01T00:00:00.000Z",
      finished: "9999-12-31T23:59:59.999Z",
    }).ok,
  );
});
