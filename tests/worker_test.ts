import { cliSourceArgs } from "../src/runtime.ts";
import { decodeWorkerRecord } from "../src/worker.ts";
import { planWorkflow } from "../src/workflow.ts";
import { assert, equal, exists, fixture, inWorkspace, unwrap } from "./helpers.ts";

Deno.test("worker records accept only strict step and result shapes", () => {
  assert(decodeWorkerRecord({ type: "step", index: 0, total: 1, name: "build" }).ok);
  assert(
    decodeWorkerRecord({
      type: "result",
      result: {
        kind: "timeout",
        code: 124,
        completed: 0,
        total: 1,
        detail: "timeout",
      },
    }).ok,
  );
  assert(!decodeWorkerRecord({ type: "step", index: 1, total: 1, name: "build" }).ok);
  assert(
    !decodeWorkerRecord({
      type: "result",
      result: { kind: "success", code: 1, completed: 1, total: 1, detail: "bad" },
    }).ok,
  );
});

Deno.test("worker runs an immutable plan and writes control records", () =>
  inWorkspace(async (workspace) => {
    const source = fixture(
      "      - name: Create artifact\n        run: printf raw-output; touch artifact",
    );
    const plan = unwrap(planWorkflow(source, "check"));
    const control = `${workspace}/control.jsonl`;
    await Deno.writeTextFile(control, "", { mode: 0o600 });
    const child = new Deno.Command(Deno.execPath(), {
      args: cliSourceArgs(["__worker", control]),
      cwd: workspace,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify({
      version: 1,
      parentPid: Deno.pid,
      workspace,
      shell: "/bin/bash",
      inherited: { PATH: Deno.env.get("PATH") ?? "/bin:/usr/bin" },
      plan,
    })));
    await writer.close();
    const [status, stdout] = await Promise.all([
      child.status,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    equal(status.code, 0);
    assert(stdout.includes("raw-output"), stdout);
    assert(await exists(`${workspace}/artifact`));
    const records = (await Deno.readTextFile(control)).trim().split("\n").map((line) =>
      unwrap(decodeWorkerRecord(JSON.parse(line)))
    );
    equal(records[0], { type: "step", index: 0, total: 1, name: "Create artifact" });
    assert(records[1]?.type === "result" && records[1].result.kind === "success");
  }));
