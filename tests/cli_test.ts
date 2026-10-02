import { assert, equal, exists, fixture, inWorkspace, waitFor } from "./helpers.ts";
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

const taskCommand = async (workspace: string, args: readonly string[]) => {
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
    stdout: "piped",
    stderr: "piped",
  });
};

Deno.test("CLI help and version use the public configuration", () =>
  inWorkspace(async (workspace) => {
    const help = await command(workspace, ["--help"]).output();
    equal(help.code, 0);
    assert(text(help.stdout).includes(`mci ${denoConfig.version}`));
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
