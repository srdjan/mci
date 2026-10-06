import {
  hookScript,
  installHookWith,
  nativeHookCapabilities,
  setupHookWith,
} from "../src/hooks.ts";
import { err, ok, type Result } from "../src/result.ts";
import { assert, equal, exists, unwrap } from "./helpers.ts";

const workflow = `name: Local
on: workflow_dispatch
jobs:
  check:
    runs-on: macos-latest
    steps:
      - run: deno task test
        shell: bash
`;

const generatedWorkflow = `name: Local validation
on: workflow_dispatch
defaults:
  run:
    shell: bash
jobs:
  check:
    runs-on: macos-latest
    steps:
      - name: Verify repository
        run: deno task verify
`;

const sourceHook = `#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
exec deno task ci
`;

type FixtureGitOptions =
  & Omit<
    Deno.CommandOptions,
    "args" | "clearEnv" | "env"
  >
  & {
    readonly env?: Readonly<Record<string, string>>;
  };

const fixtureGitCommand = (
  args: readonly string[],
  options: FixtureGitOptions = {},
): Deno.Command => {
  const { env = {}, ...commandOptions } = options;
  const inherited = Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([name]) => !name.startsWith("GIT_")),
  );
  return new Deno.Command("/usr/bin/git", {
    ...commandOptions,
    args: [...args],
    clearEnv: true,
    env: { ...inherited, ...env },
  });
};

const fixtureGitResult = async (
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<Result<string>> => {
  const output = await fixtureGitCommand(args, {
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  return output.code === 0
    ? ok(stdout)
    : err(stderr || `/usr/bin/git exited with ${output.code}`);
};

const withRepository = async (
  test: (repository: string, prefix: string) => Promise<void>,
): Promise<void> => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "mci hook " }));
  const repository = `${root}/repository's worktree`;
  const prefix = `${root}/brew/opt/mci`;
  try {
    await Deno.mkdir(repository);
    await fixtureGitCommand(["-C", repository, "init", "--quiet"]).output();
    await Deno.mkdir(`${repository}/.github/workflows`, { recursive: true });
    await Deno.mkdir(`${prefix}/bin`, { recursive: true });
    await Deno.mkdir(`${prefix}/libexec/hooks`, { recursive: true });
    await Deno.writeTextFile(`${prefix}/bin/mci`, "binary");
    await Deno.writeTextFile(`${prefix}/libexec/hooks/pre-commit`, hookScript);
    await Deno.chmod(`${prefix}/libexec/hooks/pre-commit`, 0o755);
    await Deno.writeTextFile(`${repository}/.github/workflows/ci.yml`, workflow);
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"test":"deno test"}}\n',
    );
    await test(repository, prefix);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

const gitWithGlobalConfig = (
  globalConfig: string,
): (args: readonly string[]) => Promise<Result<string>> =>
(args) =>
  fixtureGitResult(args, {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  });

const runGit = async (repository: string, args: readonly string[]): Promise<void> => {
  const output = await fixtureGitCommand(["-C", repository, ...args], {
    stdout: "piped",
    stderr: "piped",
  }).output();
  const detail = new TextDecoder().decode(output.stderr).trim();
  assert(output.success, detail);
};

const readGit = async (repository: string, args: readonly string[]): Promise<string> => {
  const output = await fixtureGitCommand(["-C", repository, ...args], {
    stdout: "piped",
    stderr: "piped",
  }).output();
  const detail = new TextDecoder().decode(output.stderr).trim();
  assert(output.success, detail);
  return new TextDecoder().decode(output.stdout).trim();
};

const capabilities = (prefix: string) => ({
  ...nativeHookCapabilities,
  brewPrefix: () => Promise.resolve(ok(prefix)),
  git: (args: readonly string[]) => fixtureGitResult(args),
});

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

type RollbackFaults = {
  readonly primaryCommand: string;
  readonly primaryDetail: string;
  readonly rollbackCommand?: string;
  readonly rollbackDetail?: string;
  readonly failFileRestore?: boolean;
};

const rollbackCapabilities = (
  repository: string,
  prefix: string,
  faults: RollbackFaults,
) => {
  const delegated = capabilities(prefix);
  return {
    ...delegated,
    git: async (args: readonly string[]): Promise<Result<string>> => {
      const command = args.slice(2).join("\0");
      if (command === faults.primaryCommand) {
        if (faults.failFileRestore === true) {
          await Deno.rename(
            `${repository}/deno.json`,
            `${repository}/updated-deno.json`,
          );
          await Deno.mkdir(`${repository}/deno.json`);
        }
        return err(faults.primaryDetail);
      }
      if (command === faults.rollbackCommand) {
        return err(faults.rollbackDetail ?? "missing rollback failure detail");
      }
      return delegated.git(args);
    },
  };
};

const hookSetCommand = (prefix: string): string =>
  `config\0--worktree\0core.hooksPath\0${prefix}/libexec/hooks`;

const extensionEnableCommand = "config\0--local\0extensions.worktreeConfig\0true";
const sharedHookReadCommand = "config\0--local\0--get\0core.hooksPath";

const customConfig = (prefix: string): string =>
  `{\n  "tasks" : {\n    "test":"deno test",\n    "mci:ci" : ${
    JSON.stringify(`'${prefix}/bin/mci' ci '.github/workflows/ci.yml' --job 'check'`)
  }\n  },\n  "custom" : true\n}\n`;

const assertFileRollbackFailure = (
  error: string,
  repository: string,
): void => {
  const configPath = `${repository}/deno.json`;
  assert(
    error.includes(
      `Rollback failed for ${configPath}: The repository deno.json changed before rollback.`,
    ),
  );
  assert(
    error.includes(
      `Recovery: restore ${
        shellQuote(configPath)
      } to its prior contents and confirm the file.`,
    ),
  );
  assert(!error.includes("fixture-secret"));
};

const assertGitRollbackFailure = async (
  error: string,
  repository: string,
  prior: "absent" | "false",
): Promise<void> => {
  assert(
    error.includes(
      `Rollback failed for extensions.worktreeConfig in ${repository}: injected Git rollback failure`,
    ),
  );
  const operation = prior === "absent"
    ? "--unset-all extensions.worktreeConfig"
    : "extensions.worktreeConfig false";
  const action = prior === "absent"
    ? "remove extensions.worktreeConfig and confirm that it is absent."
    : "restore the prior extensions.worktreeConfig value and confirm the setting.";
  const recoveryCommand = `git -C ${shellQuote(repository)} config --local ${operation}`;
  assert(
    error.includes(`Recovery: ${action}\nCommand:\n${recoveryCommand}`),
  );
  assert(error.split("\n").includes(recoveryCommand));

  const recovered = await new Deno.Command("/bin/sh", {
    args: ["-c", recoveryCommand],
    clearEnv: true,
    env: Object.fromEntries(
      Object.entries(Deno.env.toObject()).filter(([name]) => !name.startsWith("GIT_")),
    ),
    stdout: "piped",
    stderr: "piped",
  }).output();
  const detail = new TextDecoder().decode(recovered.stderr).trim();
  assert(recovered.success, detail);
  const extension = await fixtureGitResult([
    "-C",
    repository,
    "config",
    "--local",
    "--type=bool",
    "--get",
    "extensions.worktreeConfig",
  ]);
  if (prior === "absent") assert(!extension.ok);
  else assert(extension.ok && extension.value === "false");
};

Deno.test("hook setup generates the canonical workflow and repeats without changes", async () => {
  await withRepository(async (repository, prefix) => {
    const workflowPath = `${repository}/ci/local-ci.yml`;
    await Deno.remove(`${repository}/.github`, { recursive: true });
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"verify":"deno fmt --check"}}\n',
    );

    unwrap(await setupHookWith(repository, capabilities(prefix)));
    equal(await Deno.readTextFile(workflowPath), generatedWorkflow);
    equal(await Deno.readTextFile(`${repository}/.gitignore`), ".mci/\n");
    const config = await Deno.readTextFile(`${repository}/deno.json`);
    const gitConfig = await Deno.readTextFile(`${repository}/.git/config`);
    const ignore = await Deno.readTextFile(`${repository}/.gitignore`);

    unwrap(await setupHookWith(repository, capabilities(prefix)));
    equal(await Deno.readTextFile(workflowPath), generatedWorkflow);
    equal(await Deno.readTextFile(`${repository}/deno.json`), config);
    equal(await Deno.readTextFile(`${repository}/.git/config`), gitConfig);
    equal(await Deno.readTextFile(`${repository}/.gitignore`), ignore);
  });
});

Deno.test("hook setup preserves an existing mci ignore rule", async () => {
  for (const rule of [".mci/", "/.mci/"]) {
    await withRepository(async (repository, prefix) => {
      const before = `coverage/\n${rule}\nbuild/\n`;
      await Deno.writeTextFile(`${repository}/.gitignore`, before);
      await Deno.mkdir(`${repository}/ci`);
      await Deno.writeTextFile(`${repository}/ci/local-ci.yml`, workflow);

      unwrap(await setupHookWith(repository, capabilities(prefix)));
      equal(await Deno.readTextFile(`${repository}/.gitignore`), before);
    });
  }
});

Deno.test("hook setup appends the mci ignore rule with a newline", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.writeTextFile(`${repository}/.gitignore`, "dist/");
    await Deno.mkdir(`${repository}/ci`);
    await Deno.writeTextFile(`${repository}/ci/local-ci.yml`, workflow);

    unwrap(await setupHookWith(repository, capabilities(prefix)));
    equal(await Deno.readTextFile(`${repository}/.gitignore`), "dist/\n.mci/\n");
  });
});

Deno.test("hook setup preserves an existing workflow byte for byte", async () => {
  await withRepository(async (repository, prefix) => {
    const workflowPath = `${repository}/ci/local-ci.yml`;
    await Deno.mkdir(`${repository}/ci`);
    const existing = workflow.replace("name: Local", "name: Existing local workflow");
    await Deno.writeTextFile(workflowPath, existing);
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"verify":"deno test"}}\n',
    );

    unwrap(await setupHookWith(repository, capabilities(prefix)));
    equal(await Deno.readTextFile(workflowPath), existing);
  });
});

Deno.test("hook setup rejects a missing verify task without mutation", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    const configPath = `${repository}/deno.json`;
    const beforeConfig = await Deno.readTextFile(configPath);
    const beforeGit = await Deno.readTextFile(`${repository}/.git/config`);

    const result = await setupHookWith(repository, capabilities(prefix));
    assert(!result.ok && result.error.includes("verify"));
    equal(await Deno.readTextFile(configPath), beforeConfig);
    equal(await Deno.readTextFile(`${repository}/.git/config`), beforeGit);
    assert(!await exists(`${repository}/ci`));
    assert(!await exists(`${repository}/.gitignore`));
  });
});

Deno.test("hook setup validates verify before Homebrew", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    const delegated = capabilities(prefix);
    const result = await setupHookWith(repository, {
      ...delegated,
      brewPrefix: () => Promise.resolve(err("Homebrew must not run")),
    });
    assert(!result.ok && result.error.includes("verify"));
    assert(!result.ok && !result.error.includes("Homebrew must not run"));
  });
});

Deno.test("hook setup rejects direct and indirect recursive verify tasks", async () => {
  for (
    const tasks of [
      { verify: "mci ci ci/local-ci.yml --job check" },
      {
        verify: "'/opt/homebrew/opt/mci/bin/mci' ci 'ci/local-ci.yml' --job 'check'",
      },
      {
        verify: '"/opt/homebrew/opt/mci/bin/mci" ci "ci/local-ci.yml" --job "check"',
      },
      { verify: "deno task prepare", prepare: "deno task verify" },
      { verify: "deno task prepare", prepare: "deno task ci", ci: "deno test" },
    ]
  ) {
    await withRepository(async (repository, prefix) => {
      await Deno.remove(`${repository}/.github`, { recursive: true });
      await Deno.writeTextFile(
        `${repository}/deno.json`,
        `${JSON.stringify({ tasks })}\n`,
      );
      const beforeGit = await Deno.readTextFile(`${repository}/.git/config`);
      const result = await setupHookWith(repository, capabilities(prefix));
      assert(
        !result.ok && result.error.includes("recurs"),
        result.ok ? "setup succeeded" : result.error,
      );
      equal(await Deno.readTextFile(`${repository}/.git/config`), beforeGit);
      assert(!await exists(`${repository}/ci`));
    });
  }
});

Deno.test("hook setup refuses a redirected ci directory", async () => {
  await withRepository(async (repository, prefix) => {
    const outside = await Deno.makeTempDir({ prefix: "mci setup outside " });
    try {
      await Deno.writeTextFile(
        `${repository}/deno.json`,
        '{"tasks":{"verify":"deno test"}}\n',
      );
      await Deno.symlink(outside, `${repository}/ci`);
      const result = await setupHookWith(repository, capabilities(prefix));
      assert(!result.ok && result.error.includes("regular directory"));
      assert(!await exists(`${outside}/local-ci.yml`));
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("hook setup requires explicit pre-push replacement and preserves its bytes", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"verify":"deno test"}}\n',
    );
    await Deno.mkdir(`${repository}/.githooks`);
    const prePush = `${repository}/.githooks/pre-push`;
    const source = "#!/bin/sh\nprintf preserved-pre-push\\n\n";
    await Deno.writeTextFile(prePush, source);
    await Deno.chmod(prePush, 0o755);
    await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);

    const refused = await setupHookWith(repository, capabilities(prefix));
    assert(
      !refused.ok && refused.error.includes("pre-push"),
      refused.ok ? "setup succeeded" : refused.error,
    );
    assert(!await exists(`${repository}/ci`));
    assert(!await exists(`${repository}/.gitignore`));

    unwrap(
      await setupHookWith(repository, capabilities(prefix), { replacePrePush: true }),
    );
    equal(await Deno.readTextFile(prePush), source);
    equal(
      await readGit(repository, ["config", "--local", "--get", "core.hooksPath"]),
      ".githooks",
    );
    equal(
      await readGit(repository, ["config", "--worktree", "--get", "core.hooksPath"]),
      `${prefix}/libexec/hooks`,
    );
  });
});

Deno.test("hook setup migrates an equivalent repository-owned hook path", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"verify":"deno test"}}\n',
    );
    await Deno.mkdir(`${repository}/.githooks`);
    await Deno.writeTextFile(
      `${repository}/.githooks/pre-push`,
      "#!/bin/sh\nexit 0\n",
    );
    await Deno.chmod(`${repository}/.githooks/pre-push`, 0o755);
    await runGit(repository, [
      "config",
      "--local",
      "core.hooksPath",
      "./.githooks",
    ]);

    unwrap(
      await setupHookWith(repository, capabilities(prefix), {
        replacePrePush: true,
      }),
    );
    equal(
      await readGit(repository, ["config", "--local", "--get", "core.hooksPath"]),
      "./.githooks",
    );
    equal(
      await readGit(repository, ["config", "--worktree", "--get", "core.hooksPath"]),
      `${prefix}/libexec/hooks`,
    );
  });
});

Deno.test("hook setup refuses unknown pre-commit and unrelated executable hooks", async () => {
  for (const hook of ["pre-commit", "commit-msg"]) {
    await withRepository(async (repository, prefix) => {
      await Deno.writeTextFile(
        `${repository}/deno.json`,
        '{"tasks":{"verify":"deno test"}}\n',
      );
      await Deno.mkdir(`${repository}/.githooks`);
      await Deno.writeTextFile(`${repository}/.githooks/${hook}`, "#!/bin/sh\nexit 0\n");
      await Deno.chmod(`${repository}/.githooks/${hook}`, 0o755);
      await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);
      const result = await setupHookWith(
        repository,
        capabilities(prefix),
        { replacePrePush: true },
      );
      assert(
        !result.ok && result.error.includes(hook),
        result.ok ? "setup succeeded" : result.error,
      );
    });
  }
});

Deno.test("hook setup ignores sample and nonexecutable hook files", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"verify":"deno test"}}\n',
    );
    await Deno.mkdir(`${repository}/.githooks`);
    await Deno.writeTextFile(`${repository}/.githooks/pre-push`, "#!/bin/sh\nexit 0\n");
    await Deno.writeTextFile(
      `${repository}/.githooks/commit-msg.sample`,
      "#!/bin/sh\nexit 0\n",
    );
    await Deno.chmod(`${repository}/.githooks/commit-msg.sample`, 0o755);
    await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);

    unwrap(await setupHookWith(repository, capabilities(prefix)));
    equal(
      await readGit(repository, ["config", "--worktree", "--get", "core.hooksPath"]),
      `${prefix}/libexec/hooks`,
    );
  });
});

Deno.test("hook setup preserves an existing repository-owned mci hook", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    await Deno.mkdir(`${repository}/.githooks`);
    await Deno.writeTextFile(`${repository}/.githooks/pre-commit`, sourceHook);
    await Deno.chmod(`${repository}/.githooks/pre-commit`, 0o755);
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"ci":"deno task verify"}}\n',
    );
    await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);
    const beforeConfig = await Deno.readTextFile(`${repository}/deno.json`);
    const beforeGit = await Deno.readTextFile(`${repository}/.git/config`);

    unwrap(await setupHookWith(repository, capabilities(prefix)));
    equal(await Deno.readTextFile(`${repository}/deno.json`), beforeConfig);
    equal(await Deno.readTextFile(`${repository}/.git/config`), beforeGit);
    assert(!await exists(`${repository}/ci`));
  });
});

Deno.test("hook setup replaces pre-push beside a supported source hook", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    await Deno.mkdir(`${repository}/.githooks`);
    await Deno.writeTextFile(`${repository}/.githooks/pre-commit`, sourceHook);
    await Deno.chmod(`${repository}/.githooks/pre-commit`, 0o755);
    const prePush = `${repository}/.githooks/pre-push`;
    const prePushSource = "#!/bin/sh\nexit 0\n";
    await Deno.writeTextFile(prePush, prePushSource);
    await Deno.chmod(prePush, 0o755);
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"ci":"deno task verify","verify":"deno test"}}\n',
    );
    await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);

    unwrap(
      await setupHookWith(repository, capabilities(prefix), {
        replacePrePush: true,
      }),
    );
    equal(await Deno.readTextFile(prePush), prePushSource);
    equal(
      await readGit(repository, ["config", "--worktree", "--get", "core.hooksPath"]),
      `${prefix}/libexec/hooks`,
    );
  });
});

Deno.test("hook setup preserves deno.json changed before its task write", async () => {
  await withRepository(async (repository, prefix) => {
    const configPath = `${repository}/deno.json`;
    await Deno.writeTextFile(configPath, '{"tasks":{"verify":"deno test"}}\n');
    const replacement = '{"tasks":{"verify":"deno test"},"user":"concurrent edit"}\n';
    const delegated = capabilities(prefix);
    let changed = false;
    const result = await setupHookWith(repository, {
      ...delegated,
      git: async (args: readonly string[]): Promise<Result<string>> => {
        if (!changed && args.slice(2).join("\0") === sharedHookReadCommand) {
          changed = true;
          await Deno.writeTextFile(configPath, replacement);
        }
        return await delegated.git(args);
      },
    });

    assert(changed);
    assert(
      !result.ok && result.error.includes("deno.json changed during hook setup"),
      result.ok ? "setup succeeded" : result.error,
    );
    equal(await Deno.readTextFile(configPath), replacement);
  });
});

Deno.test("hook setup preserves deno.json changed before rollback", async () => {
  await withRepository(async (repository, prefix) => {
    const configPath = `${repository}/deno.json`;
    await Deno.writeTextFile(configPath, '{"tasks":{"verify":"deno test"}}\n');
    const replacement =
      '{"tasks":{"verify":"deno test"},"user":"concurrent rollback edit"}\n';
    const delegated = capabilities(prefix);
    const result = await setupHookWith(repository, {
      ...delegated,
      git: async (args: readonly string[]): Promise<Result<string>> => {
        if (args.slice(2).join("\0") === hookSetCommand(prefix)) {
          await Deno.writeTextFile(configPath, replacement);
          return err("injected failure after concurrent deno.json edit");
        }
        return await delegated.git(args);
      },
    });

    assert(!result.ok && result.error.includes("injected failure"));
    assert(!result.ok && result.error.includes("deno.json changed before rollback"));
    equal(await Deno.readTextFile(configPath), replacement);
  });
});

Deno.test("hook setup rolls back a generated workflow after a late Git failure", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    const configPath = `${repository}/deno.json`;
    await Deno.writeTextFile(configPath, '{"tasks":{"verify":"deno test"}}\n');
    await Deno.mkdir(`${repository}/.githooks`);
    const prePush = `${repository}/.githooks/pre-push`;
    await Deno.writeTextFile(prePush, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(prePush, 0o755);
    await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);
    const beforeConfig = await Deno.readTextFile(configPath);
    await Deno.writeTextFile(`${repository}/.gitignore`, "dist/\n");
    const beforeIgnore = await Deno.readTextFile(`${repository}/.gitignore`);

    const result = await setupHookWith(
      repository,
      rollbackCapabilities(repository, prefix, {
        primaryCommand: hookSetCommand(prefix),
        primaryDetail: "injected setup hook path failure",
      }),
      { replacePrePush: true },
    );

    assert(
      !result.ok && result.error.includes("injected setup hook path failure"),
      result.ok ? "setup succeeded" : result.error,
    );
    equal(await Deno.readTextFile(configPath), beforeConfig);
    equal(await Deno.readTextFile(`${repository}/.gitignore`), beforeIgnore);
    assert(!await exists(`${repository}/ci/local-ci.yml`));
    equal(
      await readGit(repository, ["config", "--local", "--get", "core.hooksPath"]),
      ".githooks",
    );
  });
});

Deno.test("hook setup removes a generated ignore file after a late Git failure", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.mkdir(`${repository}/ci`);
    await Deno.writeTextFile(`${repository}/ci/local-ci.yml`, workflow);
    await Deno.mkdir(`${repository}/.githooks`);
    await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);

    const result = await setupHookWith(
      repository,
      rollbackCapabilities(repository, prefix, {
        primaryCommand: hookSetCommand(prefix),
        primaryDetail: "injected setup hook path failure",
      }),
    );

    assert(!result.ok && result.error.includes("injected setup hook path failure"));
    assert(!await exists(`${repository}/.gitignore`));
  });
});

Deno.test("hook setup preserves a generated workflow changed before rollback", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"verify":"deno test"}}\n',
    );
    await Deno.mkdir(`${repository}/.githooks`);
    await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);
    const delegated = capabilities(prefix);
    const workflowPath = `${repository}/ci/local-ci.yml`;
    const replacement = "user replacement created during setup\n";

    const result = await setupHookWith(repository, {
      ...delegated,
      git: async (args: readonly string[]): Promise<Result<string>> => {
        if (args.slice(2).join("\0") === hookSetCommand(prefix)) {
          await Deno.writeTextFile(workflowPath, replacement);
          return err("injected failure after concurrent workflow edit");
        }
        return await delegated.git(args);
      },
    });

    assert(!result.ok && result.error.includes("injected failure"));
    assert(!result.ok && result.error.includes("Rollback failed"));
    assert(!result.ok && result.error.includes("generated file"));
    equal(await Deno.readTextFile(workflowPath), replacement);
    assert(!await exists(`${repository}/.gitignore`));
  });
});

Deno.test("hook setup isolates migration to one linked worktree", async () => {
  await withRepository(async (repository, prefix) => {
    await runGit(repository, ["config", "user.name", "mci tests"]);
    await runGit(repository, ["config", "user.email", "mci@example.invalid"]);
    await runGit(repository, ["add", ".github/workflows/ci.yml", "deno.json"]);
    await runGit(repository, ["commit", "--quiet", "-m", "fixture"]);
    await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);
    const installed = `${repository}-installed`;
    await runGit(repository, ["worktree", "add", "--quiet", "--detach", installed]);
    await Deno.writeTextFile(
      `${installed}/deno.json`,
      '{"tasks":{"verify":"deno test"}}\n',
    );
    await Deno.mkdir(`${installed}/.githooks`);
    await Deno.writeTextFile(`${installed}/.githooks/pre-push`, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(`${installed}/.githooks/pre-push`, 0o755);

    unwrap(
      await setupHookWith(installed, capabilities(prefix), { replacePrePush: true }),
    );
    equal(
      await readGit(installed, ["config", "--get", "core.hooksPath"]),
      `${prefix}/libexec/hooks`,
    );
    equal(await readGit(repository, ["config", "--get", "core.hooksPath"]), ".githooks");
    equal(
      await readGit(repository, ["config", "--local", "--get", "core.hooksPath"]),
      ".githooks",
    );

    const future = `${repository}-future-setup`;
    await runGit(repository, ["worktree", "add", "--quiet", "--detach", future]);
    equal(await readGit(future, ["config", "--get", "core.hooksPath"]), ".githooks");
  });
});

Deno.test("hook installation rejects a non-Git directory before config reads", async () => {
  const directory = await Deno.realPath(await Deno.makeTempDir({ prefix: "mci hook " }));
  try {
    const commands: string[] = [];
    const result = await installHookWith(
      directory,
      ".github/workflows/ci.yml",
      "check",
      {
        brewPrefix: () => Promise.resolve(err("unexpected Homebrew lookup")),
        git: (args: readonly string[]): Promise<Result<string>> => {
          commands.push(args.slice(2).join("\0"));
          return fixtureGitResult(args);
        },
      },
    );

    assert(!result.ok && result.error.includes("not a Git repository"));
    equal(commands, ["rev-parse\0--show-toplevel"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("hook installation rejects a nested directory before config reads", async () => {
  await withRepository(async (repository, prefix) => {
    const nested = `${repository}/nested`;
    await Deno.mkdir(nested);
    const commands: string[] = [];
    const delegated = capabilities(prefix);
    const result = await installHookWith(
      nested,
      ".github/workflows/ci.yml",
      "check",
      {
        ...delegated,
        git: (args: readonly string[]): Promise<Result<string>> => {
          commands.push(args.slice(2).join("\0"));
          return delegated.git(args);
        },
      },
    );

    assert(!result.ok && result.error.includes("Git worktree root"));
    equal(commands, ["rev-parse\0--show-toplevel"]);
  });
});

Deno.test("hook installation rejects a redirected worktree without mutation", async () => {
  await withRepository(async (repository, prefix) => {
    const redirected = `${repository}/redirected`;
    await Deno.mkdir(redirected);
    await runGit(repository, [
      "config",
      "--local",
      "extensions.worktreeConfig",
      "true",
    ]);
    await runGit(repository, ["config", "--local", "core.worktree", redirected]);
    const configPath = `${repository}/deno.json`;
    const gitConfigPath = `${repository}/.git/config`;
    const configBefore = await Deno.readTextFile(configPath);
    const gitConfigBefore = await Deno.readTextFile(gitConfigPath);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      capabilities(prefix),
    );

    assert(!result.ok && result.error.includes("Git worktree root"));
    equal(await Deno.readTextFile(configPath), configBefore);
    equal(await Deno.readTextFile(gitConfigPath), gitConfigBefore);
    assert(!await exists(`${repository}/.git/config.worktree`));
  });
});

Deno.test("hook installation preserves a matching custom deno.json", async () => {
  await withRepository(async (repository, prefix) => {
    const configPath = `${repository}/deno.json`;
    const before = customConfig(prefix);
    await Deno.writeTextFile(configPath, before);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      unwrap(
        await installHookWith(
          repository,
          ".github/workflows/ci.yml",
          "check",
          capabilities(prefix),
        ),
      );
      equal(await Deno.readTextFile(configPath), before);
    }
  });
});

Deno.test("hook installation repeats through the stable Homebrew symlink", async () => {
  await withRepository(async (repository, prefix) => {
    const cellar = prefix.replace("/opt/mci", "/Cellar/mci/0.3.0");
    await Deno.mkdir(cellar.slice(0, cellar.lastIndexOf("/")), { recursive: true });
    await Deno.rename(prefix, cellar);
    await Deno.symlink(cellar, prefix);
    const configPath = `${repository}/deno.json`;
    const before = customConfig(prefix);
    await Deno.writeTextFile(configPath, before);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      unwrap(
        await installHookWith(
          repository,
          ".github/workflows/ci.yml",
          "check",
          capabilities(prefix),
        ),
      );
      equal(await Deno.readTextFile(configPath), before);
      equal(
        await readGit(repository, ["config", "--worktree", "--get", "core.hooksPath"]),
        `${prefix}/libexec/hooks`,
      );
    }
    await runGit(repository, [
      "config",
      "--local",
      "core.hooksPath",
      `${cellar}/libexec/hooks`,
    ]);
    const gitBefore = await Deno.readTextFile(`${repository}/.git/config`);
    const refused = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      capabilities(prefix),
    );
    assert(!refused.ok && refused.error.includes("shared core.hooksPath"));
    equal(await Deno.readTextFile(`${repository}/.git/config`), gitBefore);
    equal(await Deno.readTextFile(configPath), before);
  });
});

Deno.test("later Git failure preserves a matching custom deno.json", async () => {
  await withRepository(async (repository, prefix) => {
    const configPath = `${repository}/deno.json`;
    const before = customConfig(prefix);
    await Deno.writeTextFile(configPath, before);
    const delegated = capabilities(prefix);
    let configAtFailure: string | undefined;
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      {
        ...delegated,
        git: async (args: readonly string[]): Promise<Result<string>> => {
          if (args.slice(2).join("\0") === hookSetCommand(prefix)) {
            configAtFailure = await Deno.readTextFile(configPath);
            return err("injected hook path failure");
          }
          return delegated.git(args);
        },
      },
    );

    assert(!result.ok && result.error.includes("injected hook path failure"));
    equal(configAtFailure, before);
    equal(await Deno.readTextFile(configPath), before);
  });
});

Deno.test("hook installation writes one stable task and configures Git", async () => {
  await withRepository(async (repository, prefix) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      unwrap(
        await installHookWith(
          repository,
          ".github/workflows/ci.yml",
          "check",
          capabilities(prefix),
        ),
      );
    }
    const config: unknown = JSON.parse(
      await Deno.readTextFile(`${repository}/deno.json`),
    );
    assert(typeof config === "object" && config !== null && "tasks" in config);
    const tasks = (config as { readonly tasks: Readonly<Record<string, unknown>> }).tasks;
    equal(
      tasks["mci:ci"],
      `'${prefix}/bin/mci' ci '.github/workflows/ci.yml' --job 'check'`,
    );
    equal(await Deno.readTextFile(`${prefix}/libexec/hooks/pre-commit`), hookScript);
    const mode = (await Deno.stat(`${prefix}/libexec/hooks/pre-commit`)).mode;
    assert(mode !== null && (mode & 0o111) !== 0);
    equal(
      await readGit(repository, ["config", "--worktree", "--get", "core.hooksPath"]),
      `${prefix}/libexec/hooks`,
    );
    equal(
      await readGit(repository, [
        "config",
        "--local",
        "--type=bool",
        "--get",
        "extensions.worktreeConfig",
      ]),
      "true",
    );
    const common = await fixtureGitCommand([
      "-C",
      repository,
      "config",
      "--local",
      "--get",
      "core.hooksPath",
    ]).output();
    equal(common.code, 1);
  });
});

Deno.test("hook installation stays scoped to one linked worktree", async () => {
  await withRepository(async (repository, prefix) => {
    await runGit(repository, ["config", "user.name", "mci tests"]);
    await runGit(repository, ["config", "user.email", "mci@example.invalid"]);
    await runGit(repository, ["add", ".github/workflows/ci.yml", "deno.json"]);
    await runGit(repository, ["commit", "--quiet", "-m", "fixture"]);
    await runGit(repository, [
      "config",
      "--local",
      "extensions.worktreeConfig",
      "true",
    ]);
    const installed = `${repository}-installed`;
    await runGit(repository, ["worktree", "add", "--quiet", "--detach", installed]);
    const mainHooks = `${repository}/.main-hooks`;
    await runGit(repository, [
      "config",
      "--worktree",
      "core.hooksPath",
      mainHooks,
    ]);
    await Deno.mkdir(mainHooks);
    const mainForeign = "#!/bin/sh\nexit 19\n";
    await Deno.writeTextFile(`${mainHooks}/pre-commit`, mainForeign);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      unwrap(
        await installHookWith(
          installed,
          ".github/workflows/ci.yml",
          "check",
          capabilities(prefix),
        ),
      );
    }
    equal(
      await readGit(installed, ["config", "--get", "core.hooksPath"]),
      `${prefix}/libexec/hooks`,
    );
    const common = await fixtureGitCommand([
      "-C",
      repository,
      "config",
      "--local",
      "--get",
      "core.hooksPath",
    ]).output();
    equal(common.code, 1);
    equal(
      await readGit(repository, ["config", "--get", "core.hooksPath"]),
      mainHooks,
    );
    equal(
      await readGit(repository, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "hooks",
      ]),
      mainHooks,
    );
    equal(await Deno.readTextFile(`${mainHooks}/pre-commit`), mainForeign);

    const future = `${repository}-future`;
    await runGit(repository, ["worktree", "add", "--quiet", "--detach", future]);
    equal(
      await readGit(future, ["config", "--get", "core.hooksPath"]),
      mainHooks,
    );
    assert(
      await readGit(future, ["config", "--get", "core.hooksPath"]) !==
        `${prefix}/libexec/hooks`,
    );
    equal(await Deno.readTextFile(`${mainHooks}/pre-commit`), mainForeign);
  });
});

Deno.test("hook installation refuses a foreign default pre-commit hook", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.writeTextFile(
      `${repository}/.git/hooks/pre-commit`,
      "#!/bin/sh\nexit 0\n",
    );
    const before = await Deno.readTextFile(`${repository}/deno.json`);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      capabilities(prefix),
    );
    assert(!result.ok && result.error.includes("foreign hook"));
    equal(await Deno.readTextFile(`${repository}/deno.json`), before);
    assert(!await exists(`${repository}/.mci-hooks`));
  });
});

Deno.test("hook installation refuses a foreign packaged hook", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.writeTextFile(
      `${prefix}/libexec/hooks/pre-commit`,
      "#!/bin/sh\nexit 0\n",
    );
    const before = await Deno.readTextFile(`${repository}/deno.json`);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      capabilities(prefix),
    );
    assert(!result.ok && result.error.includes("packaged hook"));
    equal(await Deno.readTextFile(`${repository}/deno.json`), before);
  });
});

for (
  const [name, prepare, detail] of [
    [
      "non-regular",
      async (path: string) => {
        await Deno.remove(path);
        await Deno.mkdir(path);
      },
      "not a regular file",
    ],
    [
      "non-executable",
      (path: string) => Deno.chmod(path, 0o644),
      "not executable",
    ],
  ] as const
) {
  Deno.test(`hook installation refuses a ${name} packaged hook`, async () => {
    await withRepository(async (repository, prefix) => {
      const packagedHook = `${prefix}/libexec/hooks/pre-commit`;
      await prepare(packagedHook);
      const before = await Deno.readTextFile(`${repository}/deno.json`);
      const result = await installHookWith(
        repository,
        ".github/workflows/ci.yml",
        "check",
        capabilities(prefix),
      );
      assert(!result.ok && result.error.includes(detail));
      equal(await Deno.readTextFile(`${repository}/deno.json`), before);
    });
  });
}

Deno.test("hook installation refuses an inherited Git hook path", async () => {
  await withRepository(async (repository, prefix) => {
    const globalConfig = `${repository}/global.gitconfig`;
    await Deno.writeTextFile(
      globalConfig,
      "[core]\n\thooksPath = global-hooks\n",
    );
    await Deno.mkdir(`${repository}/global-hooks`);
    await Deno.writeTextFile(
      `${repository}/global-hooks/pre-commit`,
      "#!/bin/sh\nexit 0\n",
    );
    const before = await Deno.readTextFile(`${repository}/deno.json`);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      {
        ...capabilities(prefix),
        git: gitWithGlobalConfig(globalConfig),
      },
    );
    assert(!result.ok && result.error.includes("already names global-hooks"));
    equal(await Deno.readTextFile(`${repository}/deno.json`), before);
    assert(!await exists(`${repository}/.mci-hooks`));
  });
});

Deno.test("hook installation inspects the common hooks directory in a worktree", async () => {
  await withRepository(async (repository, prefix) => {
    await runGit(repository, ["config", "user.name", "mci tests"]);
    await runGit(repository, ["config", "user.email", "mci@example.invalid"]);
    await runGit(repository, ["add", ".github/workflows/ci.yml", "deno.json"]);
    await runGit(repository, ["commit", "--quiet", "-m", "fixture"]);
    const worktree = `${repository}-worktree`;
    await runGit(repository, ["worktree", "add", "--quiet", "--detach", worktree]);
    await Deno.writeTextFile(
      `${repository}/.git/hooks/pre-commit`,
      "#!/bin/sh\nexit 0\n",
    );
    const before = await Deno.readTextFile(`${worktree}/deno.json`);
    const result = await installHookWith(
      worktree,
      ".github/workflows/ci.yml",
      "check",
      capabilities(prefix),
    );
    assert(!result.ok && result.error.includes("foreign hook"));
    equal(await Deno.readTextFile(`${worktree}/deno.json`), before);
    assert(!await exists(`${worktree}/.mci-hooks`));
  });
});

Deno.test("hook installation refuses a recursive workflow before mutation", async () => {
  await withRepository(async (repository, prefix) => {
    const before = await Deno.readTextFile(`${repository}/deno.json`);
    for (
      const recursive of [
        "deno task ci",
        `${shellQuote(`${prefix}/bin/mci`)} ci 'ci/local-ci.yml' --job 'check'`,
        `"${prefix}/bin/mci" ci "ci/local-ci.yml" --job "check"`,
      ]
    ) {
      await Deno.writeTextFile(
        `${repository}/.github/workflows/ci.yml`,
        workflow.replace(
          "      - run: deno task test\n        shell: bash",
          `      - run: |\n          ${recursive}\n        shell: bash`,
        ),
      );
      const result = await installHookWith(
        repository,
        ".github/workflows/ci.yml",
        "check",
        capabilities(prefix),
      );
      assert(
        !result.ok && result.error.includes("recurse"),
        result.ok ? "installation succeeded" : result.error,
      );
      equal(await Deno.readTextFile(`${repository}/deno.json`), before);
    }
  });
});

Deno.test("hook installation refuses a foreign Git hook path", async () => {
  await withRepository(async (repository, prefix) => {
    await fixtureGitCommand([
      "-C",
      repository,
      "config",
      "--local",
      "core.hooksPath",
      ".hooks",
    ]).output();
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      capabilities(prefix),
    );
    assert(!result.ok && result.error.includes("already names .hooks"));
  });
});

Deno.test("hook installation refuses shared managed hook paths", async () => {
  await withRepository(async (repository, prefix) => {
    for (const hooksPath of [".mci-hooks", `${prefix}/libexec/hooks`]) {
      await runGit(repository, [
        "config",
        "--local",
        "core.hooksPath",
        hooksPath,
      ]);
      const result = await installHookWith(
        repository,
        ".github/workflows/ci.yml",
        "check",
        capabilities(prefix),
      );
      assert(!result.ok && result.error.includes("shared core.hooksPath"));
    }
  });
});

Deno.test("a future worktree inherits the stable hook and fails without its task", async () => {
  await withRepository(async (repository, prefix) => {
    await runGit(repository, ["config", "user.name", "mci tests"]);
    await runGit(repository, ["config", "user.email", "mci@example.invalid"]);
    await runGit(repository, ["add", ".github/workflows/ci.yml", "deno.json"]);
    await runGit(repository, ["commit", "--quiet", "-m", "fixture"]);
    unwrap(
      await installHookWith(
        repository,
        ".github/workflows/ci.yml",
        "check",
        capabilities(prefix),
      ),
    );

    const future = `${repository}-future`;
    await runGit(repository, ["worktree", "add", "--quiet", "--detach", future]);
    const stableHooks = `${prefix}/libexec/hooks`;
    equal(
      await readGit(future, ["config", "--get", "core.hooksPath"]),
      stableHooks,
    );
    equal(await Deno.readTextFile(`${stableHooks}/pre-commit`), hookScript);
    await Deno.writeTextFile(`${future}/change`, "change");
    await runGit(future, ["add", "change"]);
    const commit = await fixtureGitCommand([
      "-C",
      future,
      "commit",
      "-m",
      "must fail",
    ], {
      stdout: "piped",
      stderr: "piped",
    }).output();
    const detail = new TextDecoder().decode(commit.stderr);
    assert(!commit.success);
    assert(detail.includes("mci:ci"), detail);
  });
});

for (
  const [name, value] of [
    ["core.worktree", "."],
    ["core.bare", "true"],
  ] as const
) {
  Deno.test(`hook installation refuses unsafe shared ${name}`, async () => {
    await withRepository(async (repository, prefix) => {
      await runGit(repository, ["config", "--local", name, value]);
      const result = await installHookWith(
        repository,
        ".github/workflows/ci.yml",
        "check",
        capabilities(prefix),
      );
      assert(!result.ok && result.error.includes(name));
      assert(result.ok || result.error.includes("worktreeConfig"));
    });
  });
}

Deno.test("rollback reports deno.json restoration failure after extension enablement fails", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"secret":"fixture-secret","tasks":{"test":"deno test"}}\n',
    );
    const before = await Deno.readTextFile(`${repository}/deno.json`);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      rollbackCapabilities(repository, prefix, {
        primaryCommand: extensionEnableCommand,
        primaryDetail: "injected extension enable failure",
        failFileRestore: true,
      }),
    );

    assert(!result.ok);
    assert(result.error.startsWith(
      "Cannot enable worktreeConfig: injected extension enable failure",
    ));
    assertFileRollbackFailure(result.error, repository);
    equal(
      await Deno.readTextFile(`${repository}/updated-deno.json`) === before,
      false,
    );
  });
});

Deno.test("rollback reports extension restoration failure and restores deno.json", async () => {
  await withRepository(async (repository, prefix) => {
    const before = await Deno.readTextFile(`${repository}/deno.json`);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      rollbackCapabilities(repository, prefix, {
        primaryCommand: hookSetCommand(prefix),
        primaryDetail: "injected hook path failure",
        rollbackCommand: "config\0--local\0--unset-all\0extensions.worktreeConfig",
        rollbackDetail: "injected Git rollback failure",
      }),
    );

    assert(!result.ok);
    assert(result.error.startsWith(
      "Cannot set worktree core.hooksPath: injected hook path failure",
    ));
    await assertGitRollbackFailure(result.error, repository, "absent");
    equal(await Deno.readTextFile(`${repository}/deno.json`), before);
  });
});

Deno.test("rollback reports deno.json restoration failure and restores Git", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"secret":"fixture-secret","tasks":{"test":"deno test"}}\n',
    );
    const before = await Deno.readTextFile(`${repository}/deno.json`);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      rollbackCapabilities(repository, prefix, {
        primaryCommand: hookSetCommand(prefix),
        primaryDetail: "injected hook path failure",
        failFileRestore: true,
      }),
    );

    assert(!result.ok);
    assert(result.error.startsWith(
      "Cannot set worktree core.hooksPath: injected hook path failure",
    ));
    assertFileRollbackFailure(result.error, repository);
    equal(
      await Deno.readTextFile(`${repository}/updated-deno.json`) === before,
      false,
    );
    const extension = await fixtureGitResult([
      "-C",
      repository,
      "config",
      "--local",
      "--get",
      "extensions.worktreeConfig",
    ]);
    assert(!extension.ok);
  });
});

for (const prior of ["absent", "false"] as const) {
  Deno.test(`rollback reports all restoration failures from prior ${prior} extension`, async () => {
    await withRepository(async (repository, prefix) => {
      if (prior === "false") {
        await runGit(repository, [
          "config",
          "--local",
          "extensions.worktreeConfig",
          "false",
        ]);
      }
      await Deno.writeTextFile(
        `${repository}/deno.json`,
        '{"secret":"fixture-secret","tasks":{"test":"deno test"}}\n',
      );
      const before = await Deno.readTextFile(`${repository}/deno.json`);
      const rollbackCommand = prior === "absent"
        ? "config\0--local\0--unset-all\0extensions.worktreeConfig"
        : "config\0--local\0extensions.worktreeConfig\0false";
      const result = await installHookWith(
        repository,
        ".github/workflows/ci.yml",
        "check",
        rollbackCapabilities(repository, prefix, {
          primaryCommand: hookSetCommand(prefix),
          primaryDetail: "injected hook path failure",
          rollbackCommand,
          rollbackDetail: "injected Git rollback failure",
          failFileRestore: true,
        }),
      );

      assert(!result.ok);
      assert(result.error.startsWith(
        "Cannot set worktree core.hooksPath: injected hook path failure",
      ));
      await assertGitRollbackFailure(result.error, repository, prior);
      assertFileRollbackFailure(result.error, repository);
      equal(
        await Deno.readTextFile(`${repository}/updated-deno.json`) === before,
        false,
      );
    });
  });
}

for (const primary of ["extension enablement", "hook path configuration"] as const) {
  Deno.test(`rollback succeeds after ${primary} failure`, async () => {
    await withRepository(async (repository, prefix) => {
      const before = await Deno.readTextFile(`${repository}/deno.json`);
      const primaryCommand = primary === "extension enablement"
        ? extensionEnableCommand
        : hookSetCommand(prefix);
      const primaryDetail = `injected ${primary} failure`;
      const result = await installHookWith(
        repository,
        ".github/workflows/ci.yml",
        "check",
        rollbackCapabilities(repository, prefix, {
          primaryCommand,
          primaryDetail,
        }),
      );

      assert(!result.ok);
      assert(result.error.includes(primaryDetail));
      assert(!result.error.includes("Rollback failed"));
      equal(await Deno.readTextFile(`${repository}/deno.json`), before);
      const extension = await fixtureGitResult([
        "-C",
        repository,
        "config",
        "--local",
        "--get",
        "extensions.worktreeConfig",
      ]);
      assert(!extension.ok);
    });
  });
}

Deno.test("rollback restores a prior false extension value", async () => {
  await withRepository(async (repository, prefix) => {
    await runGit(repository, [
      "config",
      "--local",
      "extensions.worktreeConfig",
      "false",
    ]);
    const before = await Deno.readTextFile(`${repository}/deno.json`);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      rollbackCapabilities(repository, prefix, {
        primaryCommand: hookSetCommand(prefix),
        primaryDetail: "injected hook path failure",
      }),
    );

    assert(!result.ok);
    assert(result.error.startsWith(
      "Cannot set worktree core.hooksPath: injected hook path failure",
    ));
    assert(!result.error.includes("Rollback failed"));
    equal(await Deno.readTextFile(`${repository}/deno.json`), before);
    equal(
      await readGit(repository, [
        "config",
        "--local",
        "--type=bool",
        "--get",
        "extensions.worktreeConfig",
      ]),
      "false",
    );
  });
});

Deno.test("rollback preserves an extension that was already true", async () => {
  await withRepository(async (repository, prefix) => {
    await runGit(repository, [
      "config",
      "--local",
      "extensions.worktreeConfig",
      "true",
    ]);
    const before = await Deno.readTextFile(`${repository}/deno.json`);
    const delegated = capabilities(prefix);
    const extensionMutations: string[] = [];
    const mutationCommands = [
      extensionEnableCommand,
      "config\0--local\0extensions.worktreeConfig\0false",
      "config\0--local\0--unset-all\0extensions.worktreeConfig",
    ];
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      {
        ...delegated,
        git: (args: readonly string[]): Promise<Result<string>> => {
          const command = args.slice(2).join("\0");
          if (mutationCommands.includes(command)) extensionMutations.push(command);
          return command === hookSetCommand(prefix)
            ? Promise.resolve(err("injected hook path failure"))
            : delegated.git(args);
        },
      },
    );

    assert(!result.ok);
    assert(result.error.startsWith(
      "Cannot set worktree core.hooksPath: injected hook path failure",
    ));
    equal(extensionMutations, []);
    equal(await Deno.readTextFile(`${repository}/deno.json`), before);
    equal(
      await readGit(repository, [
        "config",
        "--local",
        "--type=bool",
        "--get",
        "extensions.worktreeConfig",
      ]),
      "true",
    );
  });
});
