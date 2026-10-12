import {
  assert,
  equal,
  exists,
  fixture,
  inWorkspace,
  unwrap,
  waitFor,
} from "./helpers.ts";
import { rpc, submit } from "../src/client.ts";
import { readSessionReceipts } from "../src/ci-receipt.ts";
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
    env: isolatedEnv(env),
    stdout: "piped",
    stderr: "piped",
  });
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const capturedEnv = () => ({ PATH: Deno.env.get("PATH") ?? "/bin:/usr/bin" });
const isolatedEnv = (env?: Readonly<Record<string, string>>) => ({
  MCI_SESSION_ID: "",
  CODEX_SESSION_ID: "",
  CODEX_THREAD_ID: "",
  ...env,
});

Deno.test({
  name: "macOS CLI displays unselected metadata and runs the selected job",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      const source = fixture("      - run: touch artifact").replace(
        "  check:",
        '  "": null\n  "\\0job": null\n  check:',
      );
      await Deno.writeTextFile(`${workspace}/metadata.yml`, source);
      const checked = await command(workspace, [
        "check",
        "metadata.yml",
        "--job",
        "check",
      ])
        .output();
      equal(checked.code, 0);
      assert(text(checked.stdout).includes("Unselected jobs: , \0job"));
      assert(!await exists(`${workspace}/artifact`));
      const executed = await command(workspace, ["run", "metadata.yml", "--job", "check"])
        .output();
      assert(executed.code === 0, text(executed.stderr));
      assert(await exists(`${workspace}/artifact`));
    }),
});

const killIfPresent = (send: () => void): void => {
  try {
    send();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};

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
    env: isolatedEnv(env),
    stdout: "piped",
    stderr: "piped",
  });
};

const initializeHookRepository = async (
  workspace: string,
  config = '{"tasks":{"test":"deno test"}}\n',
): Promise<void> => {
  const initialized = await new Deno.Command("/usr/bin/git", {
    args: ["init", "--quiet", workspace],
    clearEnv: true,
    env: Object.fromEntries(
      Object.entries(Deno.env.toObject()).filter(([name]) => !name.startsWith("GIT_")),
    ),
    stdout: "piped",
    stderr: "piped",
  }).output();
  equal(initialized.code, 0);
  await Deno.mkdir(`${workspace}/ci`, { recursive: true });
  await Deno.writeTextFile(
    `${workspace}/ci/local-ci.yml`,
    fixture("      - run: deno task test"),
  );
  await Deno.writeTextFile(`${workspace}/.gitignore`, ".mci/\n");
  await Deno.writeTextFile(`${workspace}/deno.json`, config);
};

Deno.test("CLI help and version use the public configuration", () =>
  inWorkspace(async (workspace) => {
    const help = await command(workspace, ["--help"]).output();
    equal(help.code, 0);
    assert(text(help.stdout).includes(`mci ${denoConfig.version}`));
    assert(text(help.stdout).includes("<check|run|ci>"));
    assert(
      text(help.stdout).includes(
        "hooks setup <repository> [--replace-pre-push]",
      ),
    );
    assert(
      text(help.stdout).includes(
        "hooks install <repository> --workflow <file> --job <id>",
      ),
    );
    equal(text(help.stderr), "");

    const version = await command(workspace, ["--version"]).output();
    equal(version.code, 0);
    equal(text(version.stdout).trim(), denoConfig.version);
    equal(text(version.stderr), "");
  }));

Deno.test("CLI hook setup validates arguments and requires a standard task", () =>
  inWorkspace(async (workspace) => {
    const invalid = await command(workspace, [
      "hooks",
      "setup",
      workspace,
      "--unknown",
    ]).output();
    equal(invalid.code, 2);
    assert(text(invalid.stderr).includes("Usage:"));
    assert(!await exists(`${workspace}/ci`));

    const initialized = await new Deno.Command("/usr/bin/git", {
      args: ["init", "--quiet", workspace],
      clearEnv: true,
      env: Object.fromEntries(
        Object.entries(Deno.env.toObject()).filter(([name]) => !name.startsWith("GIT_")),
      ),
      stdout: "piped",
      stderr: "piped",
    }).output();
    equal(initialized.code, 0);
    const config = '{"tasks":{"build":"deno compile main.ts"}}\n';
    await Deno.writeTextFile(`${workspace}/deno.json`, config);
    const missing = await command(workspace, [
      "hooks",
      "setup",
      workspace,
      "--replace-pre-push",
    ], { GIT_DIR: `${workspace}/.git`, GIT_WORK_TREE: workspace }).output();
    equal(missing.code, 1);
    assert(text(missing.stderr).includes("fmt:check"));
    equal(text(missing.stdout), "");
    equal(await Deno.readTextFile(`${workspace}/deno.json`), config);
    assert(!await exists(`${workspace}/ci`));
  }));

Deno.test("CLI hook commands reject the removed timeout option", () =>
  inWorkspace(async (workspace) => {
    const setup = await command(workspace, [
      "hooks",
      "setup",
      workspace,
      "--timeout-ms",
      "1000",
    ]).output();
    equal(setup.code, 2);
    assert(text(setup.stderr).includes("Usage:"));
    assert(!await exists(`${workspace}/ci`));

    const install = await command(workspace, [
      "hooks",
      "install",
      workspace,
      "--workflow",
      "ci/local-ci.yml",
      "--job",
      "check",
      "--timeout-ms",
      "1000",
    ]).output();
    equal(install.code, 2);
    assert(text(install.stderr).includes("Usage:"));
    assert(!await exists(`${workspace}/ci`));
  }));

Deno.test("CLI hook install configures the repository", () =>
  inWorkspace(async (workspace) => {
    await initializeHookRepository(workspace);
    const result = await command(workspace, [
      "hooks",
      "install",
      workspace,
      "--workflow",
      "ci/local-ci.yml",
      "--job",
      "check",
    ]).output();
    assert(result.code === 0, text(result.stderr));
  }));

Deno.test("CLI reports missing workflow and Bash preflight failures", () =>
  inWorkspace(async (workspace) => {
    const missing = await command(
      workspace,
      ["check", "missing.yml", "--job", "check"],
    ).output();
    equal(missing.code, 2);
    assert(text(missing.stderr).includes("missing.yml"));
    assert(!text(missing.stderr).includes("mci run"));
    assert(!text(missing.stderr).includes("CI did not pass"));

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
    assert(!text(noBash.stderr).includes("mci run"));
  }));

Deno.test({
  name: "macOS CLI preserves command-specific preflight read precedence",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      const outside = await Deno.makeTempDir({ prefix: "mci-cli-preflight-" });
      const missing = `${outside}/missing.yml`;
      const restricted = (operation: "check" | "run" | "ci") => {
        const args = cliSourceArgs([operation, missing, "--job", "check"]);
        const config = args.indexOf("--config");
        args.splice(config, 0, "--no-prompt", `--deny-read=${workspace}`);
        return new Deno.Command(Deno.execPath(), {
          args,
          cwd: workspace,
          env: isolatedEnv(),
          stdout: "piped",
          stderr: "piped",
        });
      };
      try {
        for (const operation of ["check", "run"] as const) {
          const result = await restricted(operation).output();
          equal(result.code, 2);
          const diagnostic = text(result.stderr);
          assert(diagnostic.includes("No such file or directory"), diagnostic);
          assert(!diagnostic.includes("Requires read access"), diagnostic);
        }

        const result = await restricted("ci").output();
        equal(result.code, 2);
        const diagnostic = text(result.stderr);
        assert(diagnostic.includes("Requires read access"), diagnostic);
        assert(!diagnostic.includes("No such file or directory"), diagnostic);
      } finally {
        await Deno.remove(outside, { recursive: true });
      }
    }),
});

Deno.test({
  name: "macOS CLI run and ci retain Bash preflight receipts",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      const home = await Deno.makeTempDir({ prefix: "mci-cli-bash-" });
      await Deno.writeTextFile(
        `${workspace}/ci.yml`,
        fixture("      - run: touch must-not-run"),
      );
      try {
        for (const operation of ["run", "ci"] as const) {
          const session = `missing-bash-${operation}`;
          const result = await command(
            workspace,
            [operation, "ci.yml", "--job", "check"],
            {
              MCI_HOME: home,
              MCI_SESSION_ID: session,
              PATH: `${workspace}/without-bash`,
            },
          ).output();
          equal(result.code, 2);
          const diagnostic = text(result.stderr);
          assert(diagnostic.includes("CI did not pass: bash was not found"), diagnostic);
          assert(diagnostic.includes("Fix the CI failure before continuing"), diagnostic);
          assert(!diagnostic.includes("Daemon unavailable"), diagnostic);
          const receipts = unwrap(await readSessionReceipts(session, home));
          equal(receipts.length, 1);
          equal(receipts[0]?.outcome.kind, "error");
          equal(receipts[0]?.outcome.code, 2);
          assert(typeof receipts[0]?.finished === "string");
        }
        assert(!await exists(`${workspace}/must-not-run`));
      } finally {
        await Deno.remove(home, { recursive: true });
      }
    }),
});

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

Deno.test({
  name: "CLI receipt storage failure prevents execution or overrides job success",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-storage-" });
      const env = { MCI_HOME: home, MCI_SESSION_ID: "storage-contract" };
      try {
        await Deno.mkdir(`${home}/outside`);
        await Deno.symlink(`${home}/outside`, `${home}/sessions`);
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture("      - run: touch passed"),
        );
        const creation = await command(
          workspace,
          ["run", "ci.yml", "--job", "check"],
          env,
        ).output();
        equal(creation.code, 1);
        assert(text(creation.stderr).includes("CI receipt creation failed"));
        assert(!await exists(`${workspace}/passed`));
        await Deno.remove(`${home}/sessions`);
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture(
            '      - run: |\n          touch passed\n          mv "$MCI_HOME/sessions" "$MCI_HOME/saved-sessions"\n          ln -s "$MCI_HOME/saved-sessions" "$MCI_HOME/sessions"',
          ),
        );
        const completion = await command(
          workspace,
          ["run", "ci.yml", "--job", "check"],
          env,
        ).output();
        equal(completion.code, 1);
        assert(await exists(`${workspace}/passed`));
        assert(text(completion.stdout).includes("success: all selected steps passed"));
        assert(text(completion.stderr).includes("CI receipt update failed"));
        assert(text(completion.stderr).includes("CI result is unresolved"));
        assert(!(await readSessionReceipts("storage-contract", home)).ok);
        await Deno.remove(`${home}/sessions`);
        await Deno.rename(`${home}/saved-sessions`, `${home}/sessions`);
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture(
            '      - run: |\n          mv "$MCI_HOME/sessions" "$MCI_HOME/saved-sessions"\n          ln -s "$MCI_HOME/saved-sessions" "$MCI_HOME/sessions"\n          touch ready\n          sleep 30',
          ),
        );
        const child = command(workspace, ["run", "ci.yml", "--job", "check"], env)
          .spawn();
        const output = child.output();
        try {
          await waitFor(() => exists(`${workspace}/ready`));
        } finally {
          child.kill("SIGINT");
        }
        const cancelled = await output;
        equal(cancelled.code, 130);
        assert(text(cancelled.stderr).includes("CI receipt update failed"));
      } finally {
        await Deno.remove(home, { recursive: true });
      }
    }),
});

Deno.test({
  name: "CLI run records a session receipt before workflow validation",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      const home = await Deno.makeTempDir({ prefix: "mci receipt CLI " });
      try {
        const result = await command(
          workspace,
          ["run", "missing.yml", "--job", "check"],
          { MCI_HOME: home, MCI_SESSION_ID: "cli-validation" },
        ).output();
        equal(result.code, 2);
        assert(text(result.stderr).includes("CI did not pass"));
        assert(text(result.stderr).includes("mci run missing.yml --job check"));
        const receipts = unwrap(
          await readSessionReceipts("cli-validation", home),
        );
        equal(receipts.length, 1);
        equal(receipts[0]?.command, "run");
        equal(receipts[0]?.workflow, `${workspace}/missing.yml`);
        equal(receipts[0]?.outcome.kind, "error");
        equal(receipts[0]?.outcome.code, 2);
      } finally {
        await Deno.remove(home, { recursive: true });
      }
    }),
});

Deno.test({
  name: "macOS CLI receipt identifies the workflow selected after a link and parent",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-cli-path-" });
      const outside = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-cli-target-" });
      try {
        await Deno.mkdir(`${outside}/child`);
        await Deno.writeTextFile(
          `${outside}/ci.yml`,
          fixture("      - run: touch selected-outside"),
        );
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture("      - run: touch selected-workspace"),
        );
        await Deno.symlink(`${outside}/child`, `${workspace}/alias`);
        const args = cliSourceArgs(["run", "alias/../ci.yml", "--job", "check"])
          .map((argument) =>
            argument === "--permission-set=mci" ? "--allow-all" : argument
          );
        const result = await new Deno.Command(Deno.execPath(), {
          args,
          cwd: workspace,
          env: isolatedEnv({
            MCI_HOME: home,
            MCI_SESSION_ID: "cli-path-identity",
          }),
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(result.code === 0, text(result.stderr));
        assert(await exists(`${workspace}/selected-outside`), text(result.stderr));
        assert(!await exists(`${workspace}/selected-workspace`));
        const receipts = unwrap(
          await readSessionReceipts("cli-path-identity", home),
        );
        equal(receipts.length, 1);
        equal(receipts[0]?.workflow, await Deno.realPath(`${outside}/ci.yml`));
        equal(receipts[0]?.outcome.kind, "success");
      } finally {
        await Deno.remove(home, { recursive: true });
        await Deno.remove(outside, { recursive: true });
      }
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
          MCI_SESSION_ID: "cli-pass",
        }).output();
        equal(result.code, 0);
        assert(text(result.stdout).includes("hello"), text(result.stderr));
        const status = await rpc({ version: 1, op: "status" }, directory);
        assert(status.ok);
        equal(status.value.repositories[0]?.latest?.kind, "success");
        equal(status.value.repositories[0]?.latest?.code, 0);
        const latestLog = status.value.repositories[0]?.latest?.log;
        assert(latestLog !== undefined);
        assert((await Deno.readTextFile(latestLog)).includes("hello"));
        const receipts = unwrap(await readSessionReceipts("cli-pass", directory));
        equal(receipts.length, 1);
        equal(receipts[0]?.outcome.kind, "success");
        equal(receipts[0]?.outcome.requestId, status.value.repositories[0]?.latest?.id);
        equal(receipts[0]?.outcome.log, status.value.repositories[0]?.latest?.log);
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
        const direct = await command(workspace, ["run", "ci.yml", "--job", "check"], {
          MCI_HOME: directory,
          MCI_SESSION_ID: "direct-failure",
        }).output();
        equal(direct.code, 1);
        const directReceipts = unwrap(
          await readSessionReceipts("direct-failure", directory),
        );
        equal(directReceipts.length, 1);
        equal(directReceipts[0]?.outcome.kind, "failure");
        assert(typeof directReceipts[0]?.finished === "string");
        const result = await command(workspace, ["ci", "ci.yml", "--job", "check"], {
          MCI_HOME: directory,
          MCI_SESSION_ID: "cli-failure",
        }).output();
        equal(result.code, direct.code);
        const status = await rpc({ version: 1, op: "status" }, directory);
        assert(status.ok);
        equal(status.value.repositories[0]?.latest?.kind, "failure");
        equal(status.value.repositories[0]?.latest?.code, 1);
        const terminal = status.value.repositories[0]?.latest;
        assert(terminal !== null && terminal !== undefined);
        const stderr = text(result.stderr);
        assert(stderr.includes("CI did not pass"));
        assert(stderr.includes(terminal.id));
        assert(stderr.includes(terminal.log));
        const receipts = unwrap(await readSessionReceipts("cli-failure", directory));
        equal(receipts.length, 1);
        equal(receipts[0]?.outcome.kind, "failure");
        equal(receipts[0]?.outcome.requestId, terminal.id);
        equal(receipts[0]?.outcome.log, terminal.log);
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
        const saved = await Deno.readTextFile(`${workspace}/.mci/ci/latest.json`);
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture("      - run: touch unreachable\n        unsupported-field: true"),
        );
        const result = await command(workspace, ["ci", "ci.yml", "--job", "check"], {
          MCI_HOME: directory,
          MCI_SESSION_ID: "validation-error",
        }).output();
        equal(result.code, 2);
        assert(text(result.stderr).includes("unsupported-field"));
        equal(await Deno.readTextFile(`${workspace}/.mci/ci/latest.json`), saved);
        assert(!await exists(`${workspace}/unreachable`));
        equal(
          (unwrap(await readSessionReceipts("validation-error", directory)))[0]
            ?.outcome.kind,
          "error",
        );
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
          MCI_SESSION_ID: "missing-daemon",
        }).output();
        equal(result.code, 1);
        assert(text(result.stderr).includes("Daemon unavailable"));
        assert(!await exists(`${workspace}/unreachable`));
        const receipts = unwrap(await readSessionReceipts("missing-daemon", directory));
        equal(receipts.length, 1);
        equal(receipts[0]?.outcome.kind, "error");
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    }),
});

Deno.test({
  name: "macOS killed CI client leaves its session receipt pending",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace((workspace) =>
      withDaemon(workspace, async (directory) => {
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture("      - run: |\n          touch ready\n          sleep 30"),
        );
        const child = command(workspace, ["ci", "ci.yml", "--job", "check"], {
          MCI_HOME: directory,
          MCI_SESSION_ID: "killed-client",
        }).spawn();
        const output = child.output();
        try {
          await waitFor(() => exists(`${workspace}/ready`));
        } finally {
          child.kill("SIGKILL");
        }
        await output;
        const receipts = unwrap(await readSessionReceipts("killed-client", directory));
        equal(receipts.length, 1);
        equal(receipts[0]?.outcome.kind, "pending");
        equal(receipts[0]?.finished, null);
      })
    ),
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
      const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-direct-" });
      const env = { MCI_HOME: home, MCI_SESSION_ID: "direct-completion" };
      try {
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture("      - run: echo ok > success"),
        );
        equal(
          (await command(workspace, ["run", "ci.yml", "--job", "check"], env).output())
            .code,
          0,
        );
        assert(await exists(`${workspace}/success`));
        await Deno.writeTextFile(
          `${workspace}/ci.yml`,
          fixture(
            "      - run: |\n          touch ready\n          sleep 30\n      - run: touch skipped",
          ),
        );
        const child = command(workspace, ["run", "ci.yml", "--job", "check"], env)
          .spawn();
        const output = child.output();
        try {
          await waitFor(() => exists(`${workspace}/ready`));
        } finally {
          child.kill("SIGINT");
        }
        const result = await output;
        equal(result.code, 130);
        assert(!await exists(`${workspace}/skipped`));
        const receipts = unwrap(await readSessionReceipts("direct-completion", home));
        equal(receipts.length, 2);
        equal(receipts.map((entry) => entry.outcome.kind).sort(), [
          "cancelled",
          "success",
        ]);
        assert(receipts.every((entry) => entry.finished !== null));
        equal(
          receipts.find((entry) => entry.outcome.kind === "cancelled")?.outcome.code,
          130,
        );
      } finally {
        await Deno.remove(home, { recursive: true });
      }
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

Deno.test({
  name: "macOS daemon CI cancels its workflow when the disposable parent dies",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace((workspace) =>
      withDaemon(workspace, async (directory) => {
        await Deno.mkdir(`${workspace}/ci`);
        await Deno.writeTextFile(
          `${workspace}/ci/local-ci.yml`,
          `defaults:
  run:
    shell: bash
jobs:
  check:
    runs-on: macos-latest
    steps:
      - run: |
          trap 'printf stopped > stopped; exit 143' TERM
          echo $$ > job.pid
          touch ready
          while :; do :; done
`,
        );
        const childArgs = cliSourceArgs(["ci", "ci/local-ci.yml", "--job", "check"]);
        const parentSource = `const child = new Deno.Command(${
          JSON.stringify(Deno.execPath())
        }, {
      args: ${JSON.stringify(childArgs)}, cwd: ${JSON.stringify(workspace)},
      stdin: "null", stdout: "null", stderr: "null",
    }).spawn();
    await Deno.writeTextFile("logger.pid", String(child.pid));
    await child.status;`;
        const parentPath = `${workspace}/parent.ts`;
        await Deno.writeTextFile(parentPath, parentSource);
        const parent = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--quiet",
            "--permission-set=mci",
            "--config",
            `${Deno.cwd()}/deno.json`,
            parentPath,
          ],
          cwd: workspace,
          env: isolatedEnv({ MCI_HOME: directory }),
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
        let parentSettled = false;
        const parentStatus = parent.status.then((status) => {
          parentSettled = true;
          return status;
        });
        try {
          await waitFor(() => exists(`${workspace}/ready`));
          parent.kill("SIGKILL");
          await parentStatus;
          await waitFor(async () => {
            const status = await rpc({ version: 1, op: "status" }, directory);
            return status.ok &&
              status.value.repositories[0]?.latest?.kind === "cancelled";
          });
          equal(await Deno.readTextFile(`${workspace}/stopped`), "stopped");
          assert(!await exists(`${workspace}/.mci/run.json`));
          const current = unwrap(await rpc({ version: 1, op: "status" }, directory));
          const status = current.repositories[0]?.latest;
          assert(status !== null && status !== undefined);
          equal(status.code, 143);
          // The daemon saves cancellation before the client exits.
          const logger = Number(await Deno.readTextFile(`${workspace}/logger.pid`));
          await waitFor(() =>
            Promise.resolve().then(() => {
              try {
                Deno.kill(logger, 0);
                return false;
              } catch (error) {
                return error instanceof Deno.errors.NotFound;
              }
            })
          );
          const reused = await submit(
            {
              version: 1,
              op: "submit",
              path: workspace,
              workflow: "ci/reuse.yml",
              job: "check",
              source: fixture("      - run: touch reused"),
              env: capturedEnv(),
            },
            new AbortController().signal,
            directory,
          );
          assert(reused.ok, reused.ok ? "" : reused.error);
          equal(reused.value.kind, "success");
          assert(await exists(`${workspace}/reused`));
        } finally {
          if (!parentSettled) {
            killIfPresent(() => parent.kill("SIGTERM"));
          }
          await parentStatus;
          if (await exists(`${workspace}/logger.pid`)) {
            const pid = Number(await Deno.readTextFile(`${workspace}/logger.pid`));
            killIfPresent(() => Deno.kill(pid, "SIGTERM"));
          }
        }
      })
    ),
});
