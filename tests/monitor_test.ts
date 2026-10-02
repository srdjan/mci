import { inspectProcessIdentity } from "../src/process.ts";
import { renderMonitor } from "../scripts/monitor.ts";
import { installMonitor } from "../scripts/install-monitor.ts";
import { assert, equal, exists, inWorkspace, unwrap } from "./helpers.ts";

const statusPath = (workspace: string) => `${workspace}/.mci/ci/status.json`;
const logPath = (workspace: string) => `${workspace}/.mci/ci/latest.log`;

const writeStatus = async (
  workspace: string,
  status: Readonly<Record<string, unknown>>,
): Promise<void> => {
  await Deno.mkdir(`${workspace}/.mci/ci`, { recursive: true });
  await Deno.writeTextFile(statusPath(workspace), JSON.stringify(status));
};

const completed = (
  state: "pass" | "fail" | "cancelled",
  code: number,
): Readonly<Record<string, unknown>> => ({
  version: 1,
  state,
  pid: Deno.pid,
  started: "2026-10-02T12:00:00.000Z",
  finished: "2026-10-02T12:00:01.000Z",
  code,
});

Deno.test("monitor shows no runs without a status record", async () => {
  await inWorkspace(async (workspace) => {
    const menu = await renderMonitor(workspace);
    assert(menu.startsWith("mci: NO RUNS"));
    assert(menu.includes("Open repository"));
    assert(menu.includes("Refresh | refresh=true"));
    assert(!menu.includes("Open log"));
  });
});

Deno.test("monitor shows a live running record", async () => {
  await inWorkspace(async (workspace) => {
    const identity = unwrap(await inspectProcessIdentity(Deno.pid));
    assert(identity !== null);
    await writeStatus(workspace, {
      version: 1,
      logger: { started: identity.started, command: identity.command },
      state: "running",
      pid: Deno.pid,
      started: "2026-10-02T12:00:00.000Z",
      finished: null,
      code: null,
    });
    const menu = await renderMonitor(workspace);
    assert(menu.startsWith("mci: RUNNING"));
    assert(menu.includes("Last run: 2026-10-02T12:00:00.000Z"));
    assert(!menu.includes("Exit code:"));
  });
});

Deno.test("monitor shows each completed state and its exit code", async () => {
  await inWorkspace(async (workspace) => {
    for (
      const [state, code, label] of [
        ["pass", 0, "PASS"],
        ["fail", 7, "FAIL"],
        ["cancelled", 130, "CANCELLED"],
      ] as const
    ) {
      await writeStatus(workspace, completed(state, code));
      const menu = await renderMonitor(workspace);
      assert(menu.startsWith(`mci: ${label}`));
      assert(menu.includes("Last run: 2026-10-02T12:00:01.000Z"));
      assert(menu.includes(`Exit code: ${code}`));
    }
  });
});

Deno.test("monitor shows interrupted when the recorded logger is absent", async () => {
  await inWorkspace(async (workspace) => {
    await writeStatus(workspace, {
      version: 1,
      state: "running",
      pid: 2_147_483_647,
      started: "2026-10-02T12:00:00.000Z",
      finished: null,
      code: null,
    });
    const menu = await renderMonitor(workspace);
    assert(menu.startsWith("mci: INTERRUPTED"));
  });
});

Deno.test("monitor reports malformed records without SwiftBar markup injection", async () => {
  await inWorkspace(async (workspace) => {
    await Deno.mkdir(`${workspace}/.mci/ci`, { recursive: true });
    await Deno.writeTextFile(statusPath(workspace), "{\n| href=https://invalid");
    const menu = await renderMonitor(workspace);
    assert(menu.startsWith("mci: ERROR"));
    assert(!menu.includes("\n| href=https://invalid"));
    assert(!menu.includes("https://invalid"));
  });
});

Deno.test("monitor reports an invalid state", async () => {
  await inWorkspace(async (workspace) => {
    await writeStatus(workspace, {
      version: 1,
      state: "unknown",
      pid: Deno.pid,
      started: "2026-10-02T12:00:00.000Z",
      finished: null,
      code: null,
    });
    const menu = await renderMonitor(workspace);
    assert(menu.startsWith("mci: ERROR"));
    assert(menu.includes("invalid CI status shape"));
  });
});

Deno.test("monitor percent-encodes action paths and omits a missing log", async () => {
  const temporary = await Deno.makeTempDir({ prefix: "mci action path " });
  const workspace = `${temporary}/mci | '$ test space`;
  try {
    await Deno.mkdir(workspace);
    await writeStatus(workspace, completed("pass", 0));
    let menu = await renderMonitor(workspace);
    assert(menu.includes("Open repository"));
    assert(menu.includes("%20"));
    assert(menu.includes("%7C"));
    assert(!menu.includes(`param1=${workspace}`));
    assert(!menu.includes("Open log"));

    await Deno.writeTextFile(logPath(workspace), "untrusted | refresh=true\n");
    menu = await renderMonitor(workspace);
    assert(menu.includes("Open log"));
    assert(menu.includes("param1=-a param2=TextEdit"));
    assert(!menu.includes("untrusted"));
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
});

Deno.test("installer creates one executable plugin and preserves unrelated files", async () => {
  await inWorkspace(async (workspace) => {
    const pluginDirectory = `${workspace}/plugins`;
    await Deno.mkdir(pluginDirectory);
    await Deno.writeTextFile(`${pluginDirectory}/unrelated.1h.sh`, "keep\n");

    const installed = unwrap(
      await installMonitor({
        repository: Deno.cwd(),
        pluginDirectory,
        denoPath: Deno.execPath(),
      }),
    );
    equal(installed, `${pluginDirectory}/mci-meeci.5s.sh`);
    equal(await Deno.readTextFile(`${pluginDirectory}/unrelated.1h.sh`), "keep\n");
    const info = await Deno.stat(installed);
    assert((info.mode ?? 0) & 0o111, "plugin must be executable");
    const entries = [];
    for await (const entry of Deno.readDir(pluginDirectory)) entries.push(entry.name);
    equal(entries.sort(), ["mci-meeci.5s.sh", "unrelated.1h.sh"]);
  });
});

Deno.test("installer rejects unrelated collisions and permits its own reinstall", async () => {
  await inWorkspace(async (workspace) => {
    const pluginDirectory = `${workspace}/plugins`;
    await Deno.mkdir(pluginDirectory);
    const plugin = `${pluginDirectory}/mci-meeci.5s.sh`;
    await Deno.writeTextFile(plugin, "#!/bin/sh\necho unrelated\n");
    const collision = await installMonitor({
      repository: Deno.cwd(),
      pluginDirectory,
      denoPath: Deno.execPath(),
    });
    assert(!collision.ok);
    equal(await Deno.readTextFile(plugin), "#!/bin/sh\necho unrelated\n");

    await Deno.remove(plugin);
    unwrap(
      await installMonitor({
        repository: Deno.cwd(),
        pluginDirectory,
        denoPath: Deno.execPath(),
      }),
    );
    unwrap(
      await installMonitor({
        repository: Deno.cwd(),
        pluginDirectory,
        denoPath: Deno.execPath(),
      }),
    );
    assert(await exists(plugin));
  });
});

Deno.test("installed plugin handles shell punctuation in the repository path", async () => {
  await inWorkspace(async (workspace) => {
    const repository = `${workspace}/source, | '$\` folder`;
    await Deno.mkdir(`${repository}/scripts`, { recursive: true });
    await Deno.mkdir(`${repository}/src`, { recursive: true });
    await Promise.all([
      Deno.copyFile("deno.json", `${repository}/deno.json`),
      Deno.copyFile(
        "scripts/monitor.ts",
        `${repository}/scripts/monitor.ts`,
      ),
      Deno.copyFile("src/ci.ts", `${repository}/src/ci.ts`),
      Deno.copyFile("src/command.ts", `${repository}/src/command.ts`),
      Deno.copyFile("src/result.ts", `${repository}/src/result.ts`),
      Deno.copyFile("src/process.ts", `${repository}/src/process.ts`),
    ]);
    const pluginDirectory = `${workspace}/plugin output`;
    const installed = unwrap(
      await installMonitor({ repository, pluginDirectory, denoPath: Deno.execPath() }),
    );
    const output = await new Deno.Command(installed, {
      cwd: workspace,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      output.success,
      new TextDecoder().decode(output.stderr),
    );
    assert(new TextDecoder().decode(output.stdout).startsWith("mci: NO RUNS"));
  });
});

Deno.test("monitor refuses a live PID whose recorded identity differs", () =>
  inWorkspace(async (workspace) => {
    const identity = unwrap(await inspectProcessIdentity(Deno.pid));
    assert(identity !== null);
    await writeStatus(workspace, {
      version: 1,
      logger: { started: identity.started, command: "a different logger command" },
      state: "running",
      pid: Deno.pid,
      started: "2026-10-02T12:00:00.000Z",
      finished: null,
      code: null,
    });
    assert((await renderMonitor(workspace)).startsWith("mci: INTERRUPTED"));
  }));

Deno.test("monitor refuses an unconfirmed legacy running identity", () =>
  inWorkspace(async (workspace) => {
    await writeStatus(workspace, {
      version: 1,
      state: "running",
      pid: Deno.pid,
      started: "2026-10-02T12:00:00.000Z",
      finished: null,
      code: null,
    });
    assert((await renderMonitor(workspace)).startsWith("mci: ERROR"));
  }));

Deno.test("installer refuses the internal cache through a parent symlink", () =>
  inWorkspace(async (workspace) => {
    const fixtureHome = `${workspace}/home`;
    const support = `${fixtureHome}/Library/Application Support/SwiftBar`;
    await Deno.mkdir(`${support}/Plugins`, { recursive: true });
    const alias = `${workspace}/alias`;
    await Deno.symlink(support, alias);
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--quiet",
        "--permission-set=mci",
        "--config",
        `${Deno.cwd()}/deno.json`,
        `${Deno.cwd()}/scripts/install-monitor.ts`,
        `${alias}/Plugins`,
      ],
      env: { HOME: fixtureHome },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(!output.success);
    assert(new TextDecoder().decode(output.stderr).includes("internal plugin cache"));
    assert(!await exists(`${support}/Plugins/mci-meeci.5s.sh`));
  }));
