import { assert, equal, exists, fixture, inWorkspace, waitFor } from "./helpers.ts";
import { rpc } from "../src/client.ts";
import { withDaemon } from "./daemon_helpers.ts";
import { cliSourceArgs } from "../src/runtime.ts";
import denoConfig from "../deno.json" with { type: "json" };

const command = (
  workspace: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) =>
  new Deno.Command(Deno.execPath(), {
    args: cliSourceArgs(args),
    cwd: workspace,
    env,
    stdout: "piped",
    stderr: "piped",
  });
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const taskCommand = async (
  workspace: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => {
  await Deno.writeTextFile(
    `${workspace}/deno.json`,
    JSON.stringify({
      ...denoConfig,
      tasks: {
        mci: denoConfig.tasks.mci.replace(
          "src/main.ts",
          new URL("../src/main.ts", import.meta.url).href,
        ),
      },
    }),
  );
  return new Deno.Command(Deno.execPath(), {
    args: ["task", "mci", ...args],
    cwd: workspace,
    env,
    stdout: "piped",
    stderr: "piped",
  });
};

Deno.test("CLI help and version use the public configuration", () =>
  inWorkspace(async (workspace) => {
    const help = await command(workspace, ["--help"]).output();
    equal(help.code, 0);
    assert(text(help.stdout).includes(`mci ${denoConfig.version}`));
    assert(text(help.stdout).includes("<check|run|ci>"));
    equal(text(help.stderr), "");

    const version = await command(workspace, ["--version"]).output();
    equal(version.code, 0);
    equal(text(version.stdout).trim(), denoConfig.version);
    equal(text(version.stderr), "");
  }));

Deno.test("CLI reports missing workflow and Bash preflight failures", () =>
  inWorkspace(async (workspace) => {
    const missing = await command(
      workspace,
      ["check", "missing.yml", "--job", "check"],
    ).output();
    equal(missing.code, 2);
    assert(text(missing.stderr).includes("missing.yml"));

    await Deno.writeTextFile(
      `${workspace}/ci.yml`,
      fixture("      - run: echo unreachable"),
    );
    const noBash = await command(
      workspace,
      ["check", "ci.yml", "--job", "check"],
      { PATH: `${workspace}/without-bash` },
    ).output();
    equal(noBash.code, 2);
    assert(text(noBash.stderr).includes("bash was not found"));
  }));

Deno.test("CLI check prints plan but never executes it", () =>
  inWorkspace(async (workspace) => {
    await Deno.writeTextFile(
      `${workspace}/ci.yml`,
      fixture("      - run: touch must-not-run"),
    );
    const result = await command(workspace, ["check", "ci.yml", "--job", "check"])
      .output();
    equal(result.code, 0);
    assert(text(result.stdout).includes("Valid plan"), text(result.stderr));
    assert(text(result.stdout).includes(`Deno ${Deno.version.deno}`));
    assert(text(result.stdout).includes("Result covers the selected job only"));
    assert(!await exists(`${workspace}/must-not-run`));
    const invalid = await command(workspace, ["check", "ci.yml"]).output();
    equal(invalid.code, 2);
  }));

Deno.test({
  name: "CLI rejects execution outside macOS",
  ignore: Deno.build.os === "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      const result = await command(workspace, ["run", "any.yml", "--job", "check"])
        .output();
      equal(result.code, 2);
      assert(text(result.stderr).includes("macOS only"));
      const logged = await command(workspace, ["ci", "any.yml", "--job", "check"])
        .output();
      equal(logged.code, 2);
      assert(text(logged.stderr).includes("macOS only"));
      assert(!await exists(`${workspace}/.mci/ci`));
    }),
});

Deno.test("CLI ci without a job returns 2 and saves nothing", () =>
  inWorkspace(async (workspace) => {
    await Deno.writeTextFile(`${workspace}/ci.yml`, fixture("      - run: echo hello"));
    const result = await command(workspace, ["ci", "ci.yml"]).output();
    equal(result.code, 2);
    assert(text(result.stderr).includes("Usage: mci <check|run|ci>"));
    assert(!await exists(`${workspace}/.mci/ci`));
  }));

Deno.test({
  name: "macOS CLI ci saves a passing daemon job",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await withDaemon(workspace, async (directory) => {
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture("      - run: echo hello"),
        );
        const result = await command(workspace, ["ci", "ci.yml", "--job", "check"], {
          MCI_HOME: directory,
        }).output();
        equal(result.code, 0);
        assert(text(result.stdout).includes("hello"), text(result.stderr));
        const status = await rpc({ version: 1, op: "status" }, directory);
        assert(status.ok);
        equal(status.value.repositories[0]?.latest?.kind, "success");
        equal(status.value.repositories[0]?.latest?.code, 0);
        assert(
          (await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`)).includes("hello"),
        );
      });
    }),
});

Deno.test({
  name: "macOS CLI ci returns the standalone run failure code",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await withDaemon(workspace, async (directory) => {
        await Deno.writeTextFile(`${workspace}/ci.yml`, fixture("      - run: exit 3"));
        const direct = await command(workspace, ["run", "ci.yml", "--job", "check"])
          .output();
        equal(direct.code, 1);
        const result = await command(workspace, ["ci", "ci.yml", "--job", "check"], {
          MCI_HOME: directory,
        }).output();
        equal(result.code, direct.code);
        const status = await rpc({ version: 1, op: "status" }, directory);
        assert(status.ok);
        equal(status.value.repositories[0]?.latest?.kind, "failure");
        equal(status.value.repositories[0]?.latest?.code, 1);
      });
    }),
});

Deno.test({
  name: "macOS CLI ci validates before submission and preserves completed evidence",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await withDaemon(workspace, async (directory) => {
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture("      - run: echo completed"),
        );
        const prior = await command(workspace, ["ci", "ci.yml", "--job", "check"], {
          MCI_HOME: directory,
        }).output();
        equal(prior.code, 0);
        const saved = await Deno.readTextFile(`${workspace}/.mci/ci/status.json`);
        const log = await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`);
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture("      - run: touch unreachable\n        unsupported-field: true"),
        );
        const result = await command(workspace, ["ci", "ci.yml", "--job", "check"], {
          MCI_HOME: directory,
        }).output();
        equal(result.code, 2);
        assert(text(result.stderr).includes("unsupported-field"));
        equal(await Deno.readTextFile(`${workspace}/.mci/ci/status.json`), saved);
        equal(await Deno.readTextFile(`${workspace}/.mci/ci/latest.log`), log);
        assert(!await exists(`${workspace}/unreachable`));
      });
    }),
});

Deno.test({
  name: "macOS CLI ci refuses a missing daemon without standalone execution",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await Deno.writeTextFile(
        `${workspace}/ci.yml`,
        fixture("      - run: touch unreachable"),
      );
      const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-absent-" });
      try {
        const result = await command(workspace, ["ci", "ci.yml", "--job", "check"], {
          MCI_HOME: directory,
        }).output();
        equal(result.code, 1);
        assert(text(result.stderr).includes("Daemon unavailable"));
        assert(!await exists(`${workspace}/unreachable`));
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    }),
});

Deno.test({
  name: "macOS daemon CI forwards SIGINT and releases the repository",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await withDaemon(workspace, async (directory) => {
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture(
            "      - run: |\n          touch ready\n          sleep 30\n      - run: touch skipped",
          ),
        );
        const child = command(workspace, ["ci", "ci.yml", "--job", "check"], {
          MCI_HOME: directory,
        }).spawn();
        const output = child.output();
        try {
          await waitFor(() => exists(`${workspace}/ready`));
        } finally {
          child.kill("SIGINT");
        }
        equal((await output).code, 130);
        assert(!await exists(`${workspace}/skipped`));
        assert(!await exists(`${workspace}/.mci/run.json`));
      });
    }),
});

Deno.test({
  name: "macOS killed CI task cancels its daemon request",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await withDaemon(workspace, async (directory) => {
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture(
            "      - run: |\n          trap 'touch stopped; exit 0' TERM\n          touch ready\n          while :; do sleep 0.01; done\n      - run: touch skipped",
          ),
        );
        const owner = (await taskCommand(workspace, ["ci", "ci.yml", "--job", "check"], {
          MCI_HOME: directory,
        })).spawn();
        const output = owner.output();
        try {
          await waitFor(() => exists(`${workspace}/ready`));
        } finally {
          owner.kill("SIGKILL");
        }
        await output;
        await waitFor(async () => {
          const current = await rpc({ version: 1, op: "status" }, directory);
          return current.ok && current.value.repositories[0]?.active === null;
        });
        assert(await exists(`${workspace}/stopped`));
        assert(!await exists(`${workspace}/skipped`));
        assert(!await exists(`${workspace}/.mci/run.json`));
        const current = await rpc({ version: 1, op: "status" }, directory);
        assert(current.ok);
        equal(current.value.repositories[0]?.latest?.kind, "cancelled");
        equal(current.value.repositories[0]?.latest?.code, 143);
      });
    }),
});

Deno.test({
  name: "macOS CLI runs a job and forwards actual SIGINT",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await Deno.writeTextFile(
        `${workspace}/ci.yml`,
        fixture("      - run: echo ok > success"),
      );
      equal(
        (await command(workspace, ["run", "ci.yml", "--job", "check"]).output()).code,
        0,
      );
      assert(await exists(`${workspace}/success`));
      await Deno.writeTextFile(
        `${workspace}/ci.yml`,
        fixture(
          "      - run: |\n          touch ready\n          sleep 30\n      - run: touch skipped",
        ),
      );
      const child = command(workspace, ["run", "ci.yml", "--job", "check"]).spawn();
      const output = child.output();
      try {
        await waitFor(() => exists(`${workspace}/ready`));
      } finally {
        child.kill("SIGINT");
      }
      const result = await output;
      equal(result.code, 130);
      assert(!await exists(`${workspace}/skipped`));
    }),
});

Deno.test({
  name: "macOS Deno task forwards SIGINT to the CLI",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await Deno.writeTextFile(
        `${workspace}/ci.yml`,
        fixture(
          "      - run: |\n          touch ready\n          sleep 30\n      - run: touch skipped",
        ),
      );
      const child = (await taskCommand(workspace, ["run", "ci.yml", "--job", "check"]))
        .spawn();
      const output = child.output();
      try {
        await waitFor(() => exists(`${workspace}/ready`));
      } finally {
        child.kill("SIGINT");
      }
      const outcome = await output;
      equal(outcome.code, 130);
      assert(!await exists(`${workspace}/skipped`));
    }),
});

Deno.test({
  name: "macOS task SIGKILL stops its CLI and releases the workspace",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await Deno.writeTextFile(
        `${workspace}/ci.yml`,
        fixture(
          "      - run: |\n          echo $PPID > cli.pid\n          trap 'touch stopped; exit 0' TERM\n          touch ready\n          while :; do sleep 0.01; done\n      - run: touch skipped",
        ),
      );
      const owner = (await taskCommand(workspace, ["run", "ci.yml", "--job", "check"]))
        .spawn();
      const output = owner.output();
      let killed = false;
      let cliPid: number | undefined;
      try {
        await waitFor(async () => {
          if (!await exists(`${workspace}/ready`)) return false;
          const journal: unknown = JSON.parse(
            await Deno.readTextFile(`${workspace}/.mci/run.json`),
          );
          return typeof journal === "object" && journal !== null &&
            "process" in journal && journal.process !== null;
        });
        cliPid = Number((await Deno.readTextFile(`${workspace}/cli.pid`)).trim());
        assert(Number.isSafeInteger(cliPid) && cliPid > 1);
        owner.kill("SIGKILL");
        killed = true;
        await owner.status;
        await waitFor(async () => !await exists(`${workspace}/.mci/run.json`));
        const stopped = await output;
        assert(text(stopped.stdout).includes("cancelled:"), text(stopped.stderr));
        assert(await exists(`${workspace}/stopped`));
        assert(!await exists(`${workspace}/skipped`));
        cliPid = undefined;
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture("      - run: touch next-run"),
        );
        const next = await (await taskCommand(workspace, [
          "run",
          "ci.yml",
          "--job",
          "check",
        ])).output();
        equal(next.code, 0);
        assert(await exists(`${workspace}/next-run`));
      } finally {
        if (cliPid !== undefined) {
          try {
            Deno.kill(cliPid, "SIGTERM");
          } catch (error) {
            assert(error instanceof Deno.errors.NotFound, `CLI cleanup failed: ${error}`);
          }
        }
        if (!killed) owner.kill("SIGKILL");
        await output;
      }
    }),
});
