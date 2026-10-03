import { decodeRequest, decodeResponse, decodeSnapshot } from "../src/protocol.ts";
import { assert } from "./helpers.ts";

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
