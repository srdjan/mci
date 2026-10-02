import { acquireWorkspace } from "../src/workspace.ts";
import { assert, equal, exists, inWorkspace, unwrap } from "./helpers.ts";

Deno.test("workspace lease excludes competitors and releases its permanent lock", () =>
  inWorkspace(async (workspace) => {
    const first = unwrap(await acquireWorkspace(workspace));
    const second = await acquireWorkspace(workspace);
    assert(!second.ok && second.error.includes("already running"));
    unwrap(await first.close());
    assert(await exists(`${workspace}/.mci/lock`));
    const third = unwrap(await acquireWorkspace(workspace));
    unwrap(await third.close());
    assert(!await exists(`${workspace}/.mci/run.json`));
  }));

Deno.test("workspace preparation keeps scripts private and rejects escaping directories", () =>
  inWorkspace(async (workspace) => {
    const lease = unwrap(await acquireWorkspace(workspace));
    try {
      const prepared = unwrap(
        await lease.prepare({
          name: "Step",
          script: "echo complete",
          directory: ".",
          env: {},
        }, 0),
      );
      equal(prepared.cwd, workspace);
      equal((await Deno.stat(prepared.script)).mode! & 0o777, 0o600);
      await Deno.symlink("/tmp", `${workspace}/outside`);
      const escaped = await lease.prepare({
        name: "Escape",
        script: "echo forbidden",
        directory: "outside",
        env: {},
      }, 1);
      assert(!escaped.ok && escaped.error.includes("outside the workspace"));
    } finally {
      unwrap(await lease.close());
    }
  }));

Deno.test("workspace recovery removes orphan scripts without removing project files", () =>
  inWorkspace(async (workspace) => {
    await Deno.mkdir(`${workspace}/.mci/run-abandoned`, { recursive: true });
    await Deno.writeTextFile(`${workspace}/.mci/run-abandoned/step.sh`, "old");
    await Deno.writeTextFile(`${workspace}/keep`, "project");
    const lease = unwrap(await acquireWorkspace(workspace));
    try {
      assert(!await exists(`${workspace}/.mci/run-abandoned`));
      equal(await Deno.readTextFile(`${workspace}/keep`), "project");
    } finally {
      unwrap(await lease.close());
    }
  }));

Deno.test("invalid recovery journals preserve files and release the workspace lock", () =>
  inWorkspace(async (workspace) => {
    await Deno.mkdir(`${workspace}/.mci`);
    await Deno.mkdir(`${workspace}/keep`);
    await Deno.writeTextFile(`${workspace}/keep/file`, "project");
    await Deno.writeTextFile(
      `${workspace}/.mci/run.json`,
      JSON.stringify({ version: 1, runDir: `${workspace}/keep`, process: null }),
    );
    const invalid = await acquireWorkspace(workspace);
    assert(
      !invalid.ok && invalid.error.includes("journal"),
      invalid.ok ? "" : invalid.error,
    );
    equal(await Deno.readTextFile(`${workspace}/keep/file`), "project");
    assert(await exists(`${workspace}/.mci/run.json`));
    await Deno.remove(`${workspace}/.mci/run.json`);
    const lease = unwrap(await acquireWorkspace(workspace));
    unwrap(await lease.close());
  }));

Deno.test("workspace state cannot redirect cleanup through a symlink", () =>
  inWorkspace(async (workspace) => {
    const outside = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${outside}/keep`, "outside");
      await Deno.symlink(outside, `${workspace}/.mci`);
      const outcome = await acquireWorkspace(workspace);
      assert(!outcome.ok);
      equal(await Deno.readTextFile(`${outside}/keep`), "outside");
      assert(!await exists(`${outside}/lock`));
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  }));

Deno.test("uncertain process recovery preserves the journal and leaves the process alive", () =>
  inWorkspace(async (workspace) => {
    const lease = unwrap(await acquireWorkspace(workspace));
    const prepared = unwrap(
      await lease.prepare({
        name: "Recovery",
        script: "echo old",
        directory: ".",
        env: {},
      }, 0),
    );
    const child = new Deno.Command("/bin/sleep", {
      args: ["30"],
      detached: true,
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      unwrap(
        await lease.record({
          pid: child.pid,
          started: "wrong identity",
          script: prepared.script,
        }),
      );
      const closed = await lease.close();
      assert(!closed.ok && closed.error.includes("retained journal"));
      const recovery = await acquireWorkspace(workspace);
      assert(!recovery.ok && recovery.error.includes("recovery failed"));
      Deno.kill(child.pid, 0);
      assert(await exists(prepared.script));
      assert(await exists(`${workspace}/.mci/run.json`));
    } finally {
      child.kill("SIGKILL");
      await child.status;
    }
    await Deno.remove(`${workspace}/.mci/run.json`);
    await Deno.remove(lease.directory, { recursive: true });
    const next = unwrap(await acquireWorkspace(workspace));
    unwrap(await next.close());
  }));
