import {
  type HookCancellationReason,
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
      - name: Run fmt:check
        run: deno task fmt:check
      - name: Run lint
        run: deno task lint
      - name: Run check
        run: deno task check
      - name: Run test
        run: deno task test
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

type RepositorySnapshot = {
  readonly workflow: string;
  readonly config: string;
  readonly gitignore: string;
  readonly sharedGit: string;
  readonly worktreeGit: string;
};

const repositorySnapshot = async (
  repository: string,
  workflowPath: string,
): Promise<RepositorySnapshot> => ({
  workflow: await Deno.readTextFile(workflowPath),
  config: await Deno.readTextFile(`${repository}/deno.json`),
  gitignore: await Deno.readTextFile(`${repository}/.gitignore`),
  sharedGit: await Deno.readTextFile(`${repository}/.git/config`),
  worktreeGit: await Deno.readTextFile(`${repository}/.git/config.worktree`),
});

const prepareSnapshotFiles = async (repository: string): Promise<void> => {
  await Deno.writeTextFile(`${repository}/.gitignore`, "dist/\n");
  await runGit(repository, [
    "config",
    "--local",
    "extensions.worktreeConfig",
    "true",
  ]);
  await runGit(repository, [
    "config",
    "--worktree",
    "mci.snapshot",
    "preserved",
  ]);
};

const writeBareWorktreeConfig = async (repository: string): Promise<void> => {
  const path = `${repository}/.git/config`;
  const source = await Deno.readTextFile(path);
  await Deno.writeTextFile(path, `${source}\n[extensions]\n\tworktreeConfig\n`);
};

const replaceWorktreeConfigWithBare = async (repository: string): Promise<void> => {
  const path = `${repository}/.git/config`;
  const source = await Deno.readTextFile(path);
  const replacement = source.replace(
    /^[ \t]*worktreeConfig = true$/m,
    "\tworktreeConfig",
  );
  assert(replacement !== source);
  await Deno.writeTextFile(path, replacement);
};

type InstallationRoute = {
  readonly name: string;
  readonly workflowPath: (repository: string) => string;
  readonly install: (
    repository: string,
    prefix: string,
  ) => Promise<Result<void>>;
};

const installationRoutes: readonly InstallationRoute[] = [
  {
    name: "setup",
    workflowPath: (repository) => `${repository}/ci/local-ci.yml`,
    install: (repository, prefix) => setupHookWith(repository, capabilities(prefix)),
  },
  {
    name: "explicit installation",
    workflowPath: (repository) => `${repository}/.github/workflows/ci.yml`,
    install: (repository, prefix) =>
      installHookWith(
        repository,
        ".github/workflows/ci.yml",
        "check",
        capabilities(prefix),
      ),
  },
];

for (const route of installationRoutes) {
  Deno.test(`hook ${route.name} preserves a bare worktreeConfig entry`, async () => {
    await withRepository(async (repository, prefix) => {
      await writeBareWorktreeConfig(repository);
      const before = await Deno.readTextFile(`${repository}/.git/config`);

      unwrap(await route.install(repository, prefix));

      equal(await Deno.readTextFile(`${repository}/.git/config`), before);
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
}

const workflowWithScript = (script: string, directory?: string): string =>
  workflow.replace(
    "      - run: deno task test\n        shell: bash",
    `      - run: |\n${
      script.split("\n").map((line) => `          ${line}`).join("\n")
    }\n        shell: bash${
      directory === undefined ? "" : `\n        working-directory: ${directory}`
    }`,
  );

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

const cancellationSignalWhen = (
  predicate: () => boolean,
  reason: HookCancellationReason = { tag: "SIGTERM" },
): AbortSignal => {
  const controller = new AbortController();
  return new Proxy(controller.signal, {
    get: (target, property): unknown => {
      if (property === "aborted" && predicate()) controller.abort(reason);
      return Reflect.get(target, property, target);
    },
  });
};

const textFileWhenPresent = (path: string): string | null => {
  try {
    return Deno.readTextFileSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
};

const directoryWhenPresent = (path: string): boolean => {
  try {
    const info = Deno.lstatSync(path);
    return info.isDirectory && !info.isSymlink;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

const absentGitValue = async (
  repository: string,
  args: readonly string[],
): Promise<void> => {
  const value = await fixtureGitResult(["-C", repository, ...args]);
  assert(!value.ok, value.ok ? value.value : "");
};

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
    : `extensions.worktreeConfig ${shellQuote("false")}`;
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
      '{"tasks":{"test":"deno test","check":"deno check .","lint":"deno lint","fmt:check":"deno fmt --check"}}\n',
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

Deno.test("hook setup preserves deno.json permissions", async () => {
  for (const mode of [0o600, 0o400, 0o1600]) {
    await withRepository(async (repository, prefix) => {
      const configPath = `${repository}/deno.json`;
      await Deno.chmod(configPath, mode);

      unwrap(await setupHookWith(repository, capabilities(prefix)));
      equal((await Deno.stat(configPath)).mode! & 0o7777, mode);

      unwrap(await setupHookWith(repository, capabilities(prefix)));
      equal((await Deno.stat(configPath)).mode! & 0o7777, mode);
    });
  }
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
      '{"tasks":{"test":"deno test"}}\n',
    );

    unwrap(await setupHookWith(repository, capabilities(prefix)));
    equal(await Deno.readTextFile(workflowPath), existing);
  });
});

Deno.test("hook setup rejects a repository without standard tasks", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    const configPath = `${repository}/deno.json`;
    await Deno.writeTextFile(configPath, '{"tasks":{"build":"deno task bundle"}}\n');
    await Deno.chmod(configPath, 0o600);
    const beforeConfig = await Deno.readTextFile(configPath);
    const beforeGit = await Deno.readTextFile(`${repository}/.git/config`);

    const result = await setupHookWith(repository, capabilities(prefix));
    assert(!result.ok && result.error.includes("standard task"));
    equal(await Deno.readTextFile(configPath), beforeConfig);
    equal((await Deno.stat(configPath)).mode! & 0o777, 0o600);
    equal(await Deno.readTextFile(`${repository}/.git/config`), beforeGit);
    assert(!await exists(`${repository}/ci`));
    assert(!await exists(`${repository}/.gitignore`));
  });
});

Deno.test("hook setup validates standard tasks before Homebrew", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"build":"deno task bundle"}}\n',
    );
    const delegated = capabilities(prefix);
    const result = await setupHookWith(repository, {
      ...delegated,
      brewPrefix: () => Promise.resolve(err("Homebrew must not run")),
    });
    assert(!result.ok && result.error.includes("standard task"));
    assert(!result.ok && !result.error.includes("Homebrew must not run"));
  });
});

Deno.test("hook setup rejects direct and indirect recursive selected tasks", async () => {
  for (
    const tasks of [
      { test: "mci ci ci/local-ci.yml --job check" },
      {
        test: "'/opt/homebrew/opt/mci/bin/mci' ci 'ci/local-ci.yml' --job 'check'",
      },
      {
        test: '"/opt/homebrew/opt/mci/bin/mci" ci "ci/local-ci.yml" --job "check"',
      },
      { test: "deno task prepare", prepare: "deno task test" },
      { test: "deno task prepare", prepare: "deno task ci", ci: "deno test" },
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

Deno.test("hook setup generates present standard tasks in canonical order", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"test":"deno test","fmt:check":"deno fmt --check"}}\n',
    );

    unwrap(await setupHookWith(repository, capabilities(prefix)));
    equal(
      await Deno.readTextFile(`${repository}/ci/local-ci.yml`),
      generatedWorkflow.replace(
        "      - name: Run lint\n        run: deno task lint\n      - name: Run check\n        run: deno task check\n",
        "",
      ),
    );
  });
});

for (
  const invocation of [
    "deno task --config deno.json lint",
    "deno task --config=deno.json lint",
    "deno task -c deno.json lint",
    "deno task -cdeno.json lint",
    "deno task --config './deno.json' -j 1 lint",
    'deno task --config="deno.json" --jobs=1 lint',
    "deno task --env-file --node-modules-dir --frozen-lockfile lint",
    "deno task --env-file=.env --lock deno.lock --no-prefix lint",
    "deno task --lock=deno.lock --if-present lint --config other.json",
  ]
) {
  Deno.test(`hook setup accepts task options: ${invocation}`, async () => {
    await withRepository(async (repository, prefix) => {
      await Deno.writeTextFile(
        `${repository}/deno.json`,
        JSON.stringify({
          tasks: { test: invocation, lint: "deno lint" },
        }),
      );
      unwrap(await setupHookWith(repository, capabilities(prefix)));
      equal(
        await Deno.readTextFile(`${repository}/ci/local-ci.yml`),
        generatedWorkflow.replace(
          "      - name: Run fmt:check\n        run: deno task fmt:check\n",
          "",
        )
          .replace("      - name: Run check\n        run: deno task check\n", ""),
      );
    });
  });
}

for (
  const invocation of [
    "deno task --config deno.json mci:ci",
    "deno task -cdeno.json --jobs 1 ci",
    "deno task --config=other.json --cwd other mci:ci",
    "deno task --env-file --lock=deno.lock mci:ci",
  ]
) {
  Deno.test(`hook setup refuses actual recursive task after options: ${invocation}`, async () => {
    await withRepository(async (repository, prefix) => {
      const source = JSON.stringify({ tasks: { test: invocation } });
      await Deno.writeTextFile(`${repository}/deno.json`, source);
      const beforeGit = await Deno.readTextFile(`${repository}/.git/config`);
      const result = await setupHookWith(repository, capabilities(prefix));
      assert(
        !result.ok && result.error.includes("recurs"),
        result.ok ? "setup succeeded" : result.error,
      );
      equal(await Deno.readTextFile(`${repository}/deno.json`), source);
      equal(await Deno.readTextFile(`${repository}/.git/config`), beforeGit);
      assert(!await exists(`${repository}/ci`));
      assert(!await exists(`${repository}/.gitignore`));
    });
  });
}

for (
  const invocation of [
    "deno task --config other.json build",
    "deno task -cother.json build",
    "deno task --cwd other build",
    "deno task --recursive build",
    "deno task --members build",
    "deno task --filter member build",
    "deno task -fmember build",
    "printf 'deno task absent; deno task mci:ci\\n'",
    'echo "deno task absent && deno task mci:ci"',
  ]
) {
  Deno.test(`hook setup preserves opaque or printed command: ${invocation}`, async () => {
    await withRepository(async (repository, prefix) => {
      await Deno.writeTextFile(
        `${repository}/deno.json`,
        JSON.stringify({ tasks: { test: invocation } }),
      );
      unwrap(await setupHookWith(repository, capabilities(prefix)));
    });
  });
}

Deno.test("hook setup rejects invalid present standard tasks before mutation", async () => {
  for (const invalid of ["", "   ", null, 42]) {
    await withRepository(async (repository, prefix) => {
      await Deno.remove(`${repository}/.github`, { recursive: true });
      await Deno.writeTextFile(
        `${repository}/deno.json`,
        `${JSON.stringify({ tasks: { test: invalid } })}\n`,
      );
      const beforeGit = await Deno.readTextFile(`${repository}/.git/config`);
      const result = await setupHookWith(repository, {
        ...capabilities(prefix),
        brewPrefix: () => Promise.resolve(err("Homebrew must not run")),
      });

      assert(!result.ok && result.error.includes("nonempty string task named test"));
      assert(!result.ok && !result.error.includes("Homebrew must not run"));
      equal(await Deno.readTextFile(`${repository}/.git/config`), beforeGit);
      assert(!await exists(`${repository}/ci`));
      assert(!await exists(`${repository}/.gitignore`));
    });
  }
});

Deno.test("hook setup preserves optional workflow tasks byte for byte", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.mkdir(`${repository}/ci`);
    const existing = workflow.replace(
      "      - run: deno task test\n        shell: bash",
      "      - run: |\n          deno task build\n          deno task browser\n        shell: bash",
    );
    await Deno.writeTextFile(`${repository}/ci/local-ci.yml`, existing);
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"test":"deno test"}}\n',
    );

    unwrap(await setupHookWith(repository, capabilities(prefix)));
    equal(await Deno.readTextFile(`${repository}/ci/local-ci.yml`), existing);
  });
});

const existingWorkflowRefusals: readonly {
  readonly name: string;
  readonly tasks: (repository: string) => Readonly<Record<string, unknown>>;
  readonly error: string;
  readonly workflow?: string;
}[] = [
  {
    name: "test to mci:ci",
    tasks: () => ({ test: "deno task mci:ci" }),
    error: "recurs",
  },
  {
    name: "two dependency edges",
    tasks: () => ({
      test: "deno task prepare",
      prepare: "deno task mci:ci",
    }),
    error: "recurs",
  },
  {
    name: "defined dependency cycle",
    tasks: () => ({
      test: "deno task prepare",
      prepare: "deno task test",
    }),
    error: "recursive Deno task dependency",
  },
  {
    name: "root task --config option",
    tasks: () => ({
      test: "deno task --config deno.json prepare",
      prepare: "deno task mci:ci",
    }),
    error: "recurs",
  },
  {
    name: "root task --config equals option",
    tasks: () => ({
      test: "deno task --config=./deno.json prepare",
      prepare: "deno task mci:ci",
    }),
    error: "recurs",
  },
  {
    name: "root task -c option",
    tasks: () => ({
      test: "deno task -c deno.json prepare",
      prepare: "deno task mci:ci",
    }),
    error: "recurs",
  },
  {
    name: "root task absolute config option",
    tasks: (repository) => ({
      test: `deno task -c ${shellQuote(`${repository}/deno.json`)} prepare`,
      prepare: "deno task mci:ci",
    }),
    error: "recurs",
  },
  {
    name: "reached literal mci ci",
    tasks: () => ({
      test: "deno task prepare",
      prepare: "mci ci ci/local-ci.yml --job check",
    }),
    error: "recurs",
  },
  {
    name: "invalid defined dependency",
    tasks: () => ({ test: "deno task broken", broken: null }),
    error: "nonempty string task named broken",
  },
  {
    name: "direct recursion from a changed step directory",
    tasks: () => ({ test: "deno test" }),
    error: "recurse",
    workflow: workflowWithScript("deno task mci:ci", "package"),
  },
  {
    name: "task recursion from a pure dot step directory",
    tasks: () => ({ test: "deno task mci:ci" }),
    error: "recurs",
    workflow: workflowWithScript("deno task test", "././"),
  },
];

for (const route of installationRoutes) {
  for (const refusal of existingWorkflowRefusals) {
    Deno.test(
      `hook ${route.name} refuses existing workflow ${refusal.name} before mutation`,
      async () => {
        await withRepository(async (repository, prefix) => {
          const workflowPath = route.workflowPath(repository);
          if (route.name === "setup") await Deno.mkdir(`${repository}/ci`);
          await Deno.writeTextFile(workflowPath, refusal.workflow ?? workflow);
          await Deno.writeTextFile(
            `${repository}/deno.json`,
            `${JSON.stringify({ tasks: refusal.tasks(repository) })}\n`,
          );
          await prepareSnapshotFiles(repository);
          const before = await repositorySnapshot(repository, workflowPath);

          const result = await route.install(repository, prefix);

          assert(
            !result.ok && result.error.includes(refusal.error),
            result.ok ? "installation succeeded" : result.error,
          );
          equal(await repositorySnapshot(repository, workflowPath), before);
        });
      },
    );
  }
}

for (const route of installationRoutes) {
  Deno.test(
    `hook ${route.name} accepts compatible task contexts in an existing workflow`,
    async () => {
      await withRepository(async (repository, prefix) => {
        const workflowPath = route.workflowPath(repository);
        if (route.name === "setup") await Deno.mkdir(`${repository}/ci`);
        const existing = workflowWithScript(
          [
            "deno task build",
            "deno task optional",
            "deno task --config other.json test",
            "deno task --cwd package test",
          ].join("\n"),
        ).replace(
          "    steps:\n",
          "    steps:\n" +
            "      - run: deno task test\n" +
            "        shell: bash\n" +
            "        working-directory: package\n",
        );
        await Deno.writeTextFile(workflowPath, existing);
        await Deno.writeTextFile(
          `${repository}/deno.json`,
          JSON.stringify({
            tasks: {
              build: "deno check .",
              test: "deno task mci:ci",
            },
          }),
        );

        unwrap(await route.install(repository, prefix));
        equal(await Deno.readTextFile(workflowPath), existing);
      });
    },
  );
}

Deno.test("hook setup refuses a redirected ci directory", async () => {
  await withRepository(async (repository, prefix) => {
    const outside = await Deno.makeTempDir({ prefix: "mci setup outside " });
    try {
      await Deno.writeTextFile(
        `${repository}/deno.json`,
        '{"tasks":{"test":"deno test"}}\n',
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
      '{"tasks":{"test":"deno test"}}\n',
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
      '{"tasks":{"test":"deno test"}}\n',
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
        '{"tasks":{"test":"deno test"}}\n',
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
      '{"tasks":{"test":"deno test"}}\n',
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

Deno.test("hook setup refuses the repository source hook without mutation", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    await Deno.mkdir(`${repository}/.githooks`);
    await Deno.writeTextFile(`${repository}/.githooks/pre-commit`, sourceHook);
    await Deno.chmod(`${repository}/.githooks/pre-commit`, 0o755);
    await Deno.writeTextFile(
      `${repository}/deno.json`,
      '{"tasks":{"ci":"deno task test","test":"deno test"}}\n',
    );
    await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);
    const beforeConfig = await Deno.readTextFile(`${repository}/deno.json`);
    const beforeGit = await Deno.readTextFile(`${repository}/.git/config`);

    const result = await setupHookWith(repository, capabilities(prefix));
    assert(!result.ok && result.error.includes("unsupported pre-commit hook"));
    equal(await Deno.readTextFile(`${repository}/deno.json`), beforeConfig);
    equal(await Deno.readTextFile(`${repository}/.git/config`), beforeGit);
    assert(!await exists(`${repository}/ci`));
  });
});

Deno.test("hook setup refuses a source hook even with pre-push replacement", async () => {
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
      '{"tasks":{"ci":"deno task test","test":"deno test"}}\n',
    );
    await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);

    const result = await setupHookWith(repository, capabilities(prefix), {
      replacePrePush: true,
    });
    assert(!result.ok && result.error.includes("unsupported pre-commit hook"));
    equal(await Deno.readTextFile(prePush), prePushSource);
    equal(
      await readGit(repository, ["config", "--local", "--get", "core.hooksPath"]),
      ".githooks",
    );
  });
});

Deno.test("hook setup preserves deno.json changed before its task write", async () => {
  await withRepository(async (repository, prefix) => {
    const configPath = `${repository}/deno.json`;
    await Deno.writeTextFile(configPath, '{"tasks":{"test":"deno test"}}\n');
    const replacement = '{"tasks":{"test":"deno test"},"user":"concurrent edit"}\n';
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
    await Deno.writeTextFile(configPath, '{"tasks":{"test":"deno test"}}\n');
    const replacement =
      '{"tasks":{"test":"deno test"},"user":"concurrent rollback edit"}\n';
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
    await Deno.writeTextFile(configPath, '{"tasks":{"test":"deno test"}}\n');
    await Deno.mkdir(`${repository}/.githooks`);
    const prePush = `${repository}/.githooks/pre-push`;
    await Deno.writeTextFile(prePush, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(prePush, 0o755);
    await runGit(repository, ["config", "--local", "core.hooksPath", ".githooks"]);
    await Deno.chmod(configPath, 0o400);
    const beforeConfig = await Deno.readTextFile(configPath);
    const beforeMode = (await Deno.stat(configPath)).mode! & 0o7777;
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
    equal((await Deno.stat(configPath)).mode! & 0o7777, beforeMode);
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
      '{"tasks":{"test":"deno test"}}\n',
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
      '{"tasks":{"test":"deno test"}}\n',
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

Deno.test("rollback restores a prior empty extension value", async () => {
  await withRepository(async (repository, prefix) => {
    await runGit(repository, [
      "config",
      "--local",
      "extensions.worktreeConfig",
      "",
    ]);
    const before = await Deno.readTextFile(`${repository}/.git/config`);
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
    equal(await Deno.readTextFile(`${repository}/.git/config`), before);
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

Deno.test("rollback preserves a concurrent extension edit", async () => {
  await withRepository(async (repository, prefix) => {
    const delegated = capabilities(prefix);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      {
        ...delegated,
        git: async (args: readonly string[]): Promise<Result<string>> => {
          const command = args.slice(2).join("\0");
          if (command === hookSetCommand(prefix)) {
            await delegated.git([
              "-C",
              repository,
              "config",
              "--local",
              "extensions.worktreeConfig",
              "false",
            ]);
            return err("injected hook path failure");
          }
          return await delegated.git(args);
        },
      },
    );

    assert(!result.ok);
    assert(result.error.includes("extensions.worktreeConfig changed before rollback"));
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

Deno.test("rollback preserves a concurrent bare extension edit", async () => {
  await withRepository(async (repository, prefix) => {
    const delegated = capabilities(prefix);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      {
        ...delegated,
        git: async (args: readonly string[]): Promise<Result<string>> => {
          const command = args.slice(2).join("\0");
          if (command === hookSetCommand(prefix)) {
            await replaceWorktreeConfigWithBare(repository);
            return err("injected hook path failure");
          }
          return await delegated.git(args);
        },
      },
    );

    assert(!result.ok);
    assert(result.error.includes("extensions.worktreeConfig changed before rollback"));
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
    const config = await Deno.readTextFile(`${repository}/.git/config`);
    assert(config.includes("\n\tworktreeConfig\n"));
    assert(!config.includes("worktreeConfig = true"));
  });
});

for (const concurrent of ["yes", "additional true"] as const) {
  Deno.test(`rollback preserves concurrent extension ${concurrent}`, async () => {
    await withRepository(async (repository, prefix) => {
      const delegated = capabilities(prefix);
      const result = await installHookWith(
        repository,
        ".github/workflows/ci.yml",
        "check",
        {
          ...delegated,
          git: async (args: readonly string[]): Promise<Result<string>> => {
            if (args.slice(2).join("\0") === hookSetCommand(prefix)) {
              await delegated.git([
                "-C",
                repository,
                "config",
                "--local",
                ...(concurrent === "additional true" ? ["--add"] : []),
                "extensions.worktreeConfig",
                concurrent === "yes" ? "yes" : "true",
              ]);
              return err("injected hook path failure");
            }
            return await delegated.git(args);
          },
        },
      );

      assert(!result.ok);
      assert(result.error.includes("extensions.worktreeConfig changed before rollback"));
      equal(
        await readGit(repository, [
          "config",
          "--local",
          "--get-all",
          "extensions.worktreeConfig",
        ]),
        concurrent === "yes" ? "yes" : "true\ntrue",
      );
    });
  });
}

for (const prior of ["off", "no"] as const) {
  Deno.test(`rollback restores the exact prior ${prior} extension spelling`, async () => {
    await withRepository(async (repository, prefix) => {
      await runGit(repository, [
        "config",
        "--local",
        "extensions.worktreeConfig",
        prior,
      ]);
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
      assert(!result.error.includes("Rollback failed"));
      equal(
        await readGit(repository, [
          "config",
          "--local",
          "--get",
          "extensions.worktreeConfig",
        ]),
        prior,
      );
    });
  });
}

Deno.test("hook setup cancels before mutation without changing state", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    const beforeConfig = await Deno.readTextFile(`${repository}/deno.json`);
    const controller = new AbortController();
    controller.abort({ tag: "timeout", timeoutMs: 75 } satisfies HookCancellationReason);
    const result = await setupHookWith(repository, capabilities(prefix), {
      signal: controller.signal,
    });

    assert(!result.ok && result.error.includes("75 ms"));
    equal(await Deno.readTextFile(`${repository}/deno.json`), beforeConfig);
    assert(!await exists(`${repository}/ci/local-ci.yml`));
    assert(!await exists(`${repository}/.gitignore`));
  });
});

Deno.test("hook setup cancels after directory creation before workflow creation", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    const directoryPath = `${repository}/ci`;
    const workflowPath = `${directoryPath}/local-ci.yml`;
    const beforeConfig = await Deno.readTextFile(`${repository}/deno.json`);
    let workflowObserved = false;
    const result = await setupHookWith(repository, capabilities(prefix), {
      signal: cancellationSignalWhen(() => {
        if (!directoryWhenPresent(directoryPath)) return false;
        workflowObserved = textFileWhenPresent(workflowPath) !== null;
        return true;
      }),
    });

    assert(!result.ok && result.error.includes("SIGTERM"));
    assert(!workflowObserved, "hook setup created the workflow before cancellation");
    assert(!await exists(workflowPath));
    assert(!await exists(directoryPath));
    assert(!await exists(`${repository}/.gitignore`));
    equal(await Deno.readTextFile(`${repository}/deno.json`), beforeConfig);
  });
});

Deno.test("hook setup preserves concurrent directory contents after cancellation", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    const directoryPath = `${repository}/ci`;
    const workflowPath = `${directoryPath}/local-ci.yml`;
    const concurrentPath = `${directoryPath}/concurrent.txt`;
    const beforeConfig = await Deno.readTextFile(`${repository}/deno.json`);
    let workflowObserved = false;
    const result = await setupHookWith(repository, capabilities(prefix), {
      signal: cancellationSignalWhen(() => {
        if (!directoryWhenPresent(directoryPath)) return false;
        Deno.writeTextFileSync(concurrentPath, "concurrent\n", { createNew: true });
        workflowObserved = textFileWhenPresent(workflowPath) !== null;
        return true;
      }),
    });

    assert(!result.ok && result.error.includes("SIGTERM"));
    assert(result.error.includes(`Rollback failed for ${directoryPath}`));
    assert(!workflowObserved, "hook setup created the workflow before cancellation");
    assert(!await exists(workflowPath));
    assert(!await exists(`${repository}/.gitignore`));
    equal(await Deno.readTextFile(`${repository}/deno.json`), beforeConfig);
    equal(await Deno.readTextFile(concurrentPath), "concurrent\n");
  });
});

Deno.test("hook setup cancellation preserves an existing workflow directory", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    const directoryPath = `${repository}/ci`;
    const markerPath = `${directoryPath}/existing.txt`;
    await Deno.mkdir(directoryPath);
    await Deno.writeTextFile(markerPath, "existing\n");
    const result = await setupHookWith(repository, capabilities(prefix), {
      signal: cancellationSignalWhen(() => directoryWhenPresent(directoryPath)),
    });

    assert(!result.ok && result.error.includes("SIGTERM"));
    equal(await Deno.readTextFile(markerPath), "existing\n");
    assert(!await exists(`${directoryPath}/local-ci.yml`));
  });
});

Deno.test("hook setup cancels after workflow creation and removes the workflow", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    const workflowPath = `${repository}/ci/local-ci.yml`;
    const beforeConfig = await Deno.readTextFile(`${repository}/deno.json`);
    const result = await setupHookWith(repository, capabilities(prefix), {
      signal: cancellationSignalWhen(
        () => textFileWhenPresent(workflowPath) !== null,
        { tag: "SIGINT" },
      ),
    });

    assert(!result.ok && result.error.includes("SIGINT"));
    equal(await Deno.readTextFile(`${repository}/deno.json`), beforeConfig);
    assert(!await exists(workflowPath));
    assert(!await exists(`${repository}/.gitignore`));
  });
});

Deno.test("hook setup cancels after ignore creation and restores setup files", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    const ignorePath = `${repository}/.gitignore`;
    const beforeConfig = await Deno.readTextFile(`${repository}/deno.json`);
    const result = await setupHookWith(repository, capabilities(prefix), {
      signal: cancellationSignalWhen(
        () => textFileWhenPresent(ignorePath)?.includes(".mci/") === true,
      ),
    });

    assert(!result.ok && result.error.includes("SIGTERM"));
    equal(await Deno.readTextFile(`${repository}/deno.json`), beforeConfig);
    assert(!await exists(`${repository}/ci/local-ci.yml`));
    assert(!await exists(ignorePath));
  });
});

Deno.test("hook installation cancels after config mutation and restores config", async () => {
  await withRepository(async (repository, prefix) => {
    const configPath = `${repository}/deno.json`;
    const beforeConfig = await Deno.readTextFile(configPath);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      capabilities(prefix),
      {
        signal: cancellationSignalWhen(
          () => textFileWhenPresent(configPath)?.includes('"mci:ci"') === true,
        ),
      },
    );

    assert(
      !result.ok && result.error.includes("SIGTERM"),
      "hook installation returned success after config cancellation",
    );
    equal(await Deno.readTextFile(configPath), beforeConfig);
    await absentGitValue(repository, [
      "config",
      "--local",
      "--get",
      "extensions.worktreeConfig",
    ]);
  });
});

Deno.test("hook installation cancels after extension mutation and restores state", async () => {
  await withRepository(async (repository, prefix) => {
    const configPath = `${repository}/deno.json`;
    const beforeConfig = await Deno.readTextFile(configPath);
    const controller = new AbortController();
    const delegated = capabilities(prefix);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      {
        ...delegated,
        git: async (args: readonly string[]): Promise<Result<string>> => {
          const changed = await delegated.git(args);
          if (args.slice(2).join("\0") === extensionEnableCommand) {
            controller.abort({ tag: "SIGTERM" } satisfies HookCancellationReason);
          }
          return changed;
        },
      },
      { signal: controller.signal },
    );

    assert(!result.ok && result.error.includes("SIGTERM"));
    equal(await Deno.readTextFile(configPath), beforeConfig);
    await absentGitValue(repository, [
      "config",
      "--local",
      "--get",
      "extensions.worktreeConfig",
    ]);
    await absentGitValue(repository, [
      "config",
      "--worktree",
      "--get",
      "core.hooksPath",
    ]);
  });
});

Deno.test("hook installation cancels at precommit after preflight", async () => {
  await withRepository(async (repository, prefix) => {
    const configPath = `${repository}/deno.json`;
    const config = customConfig(prefix);
    await Deno.writeTextFile(configPath, config);
    await runGit(repository, [
      "config",
      "--local",
      "extensions.worktreeConfig",
      "true",
    ]);
    const controller = new AbortController();
    const delegated = capabilities(prefix);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      {
        ...delegated,
        git: async (args: readonly string[]): Promise<Result<string>> => {
          const inspected = await delegated.git(args);
          if (
            args.slice(2).join("\0") ===
              "rev-parse\0--path-format=absolute\0--git-path\0hooks"
          ) {
            controller.abort({ tag: "SIGTERM" } satisfies HookCancellationReason);
          }
          return inspected;
        },
      },
      { signal: controller.signal },
    );

    assert(!result.ok && result.error.includes("SIGTERM"));
    equal(await Deno.readTextFile(configPath), config);
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
    await absentGitValue(repository, [
      "config",
      "--worktree",
      "--get",
      "core.hooksPath",
    ]);
  });
});

Deno.test("hook cancellation waits for an active helper before rollback", async () => {
  await withRepository(async (repository, prefix) => {
    const beforeConfig = await Deno.readTextFile(`${repository}/deno.json`);
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delegated = capabilities(prefix);
    let settled = false;
    const installing = installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      {
        ...delegated,
        git: async (args: readonly string[]): Promise<Result<string>> => {
          if (args.slice(2).join("\0") === extensionEnableCommand) {
            started.resolve();
            await release.promise;
          }
          return await delegated.git(args);
        },
      },
      { signal: controller.signal },
    ).then((result) => {
      settled = true;
      return result;
    });

    await started.promise;
    controller.abort({ tag: "SIGTERM" } satisfies HookCancellationReason);
    await Promise.resolve();
    assert(!settled);
    release.resolve();
    const result = await installing;

    assert(!result.ok && result.error.includes("SIGTERM"));
    equal(await Deno.readTextFile(`${repository}/deno.json`), beforeConfig);
    await absentGitValue(repository, [
      "config",
      "--local",
      "--get",
      "extensions.worktreeConfig",
    ]);
  });
});

Deno.test("hook cancellation reports every rollback failure and preserves concurrent edits", async () => {
  await withRepository(async (repository, prefix) => {
    const configPath = `${repository}/deno.json`;
    const replacement = '{"tasks":{"test":"deno test"},"user":"concurrent"}\n';
    const controller = new AbortController();
    const delegated = capabilities(prefix);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      {
        ...delegated,
        git: async (args: readonly string[]): Promise<Result<string>> => {
          const command = args.slice(2).join("\0");
          if (command === extensionEnableCommand) {
            const enabled = await delegated.git(args);
            await Deno.writeTextFile(configPath, replacement);
            controller.abort({ tag: "SIGINT" } satisfies HookCancellationReason);
            return enabled;
          }
          if (command === "config\0--local\0--unset-all\0extensions.worktreeConfig") {
            return err("injected cancellation rollback failure");
          }
          return await delegated.git(args);
        },
      },
      { signal: controller.signal },
    );

    assert(!result.ok && result.error.includes("SIGINT"));
    assert(result.error.includes("injected cancellation rollback failure"));
    assert(result.error.includes("deno.json changed before rollback"));
    equal(await Deno.readTextFile(configPath), replacement);
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

Deno.test("hook installation commits when cancellation follows the final mutation", async () => {
  await withRepository(async (repository, prefix) => {
    const controller = new AbortController();
    const delegated = capabilities(prefix);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      {
        ...delegated,
        git: async (args: readonly string[]): Promise<Result<string>> => {
          const configured = await delegated.git(args);
          if (args.slice(2).join("\0") === hookSetCommand(prefix)) {
            controller.abort({ tag: "SIGTERM" } satisfies HookCancellationReason);
          }
          return configured;
        },
      },
      { signal: controller.signal },
    );

    assert(result.ok, result.ok ? "" : result.error);
    assert((await Deno.readTextFile(`${repository}/deno.json`)).includes('"mci:ci"'));
    equal(
      await readGit(repository, ["config", "--worktree", "--get", "core.hooksPath"]),
      `${prefix}/libexec/hooks`,
    );
  });
});

Deno.test("hook cancellation during rollback waits for every restoration attempt", async () => {
  await withRepository(async (repository, prefix) => {
    await Deno.remove(`${repository}/.github`, { recursive: true });
    const configPath = `${repository}/deno.json`;
    const beforeConfig = await Deno.readTextFile(configPath);
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delegated = capabilities(prefix);
    let settled = false;
    const installing = setupHookWith(repository, {
      ...delegated,
      git: async (args: readonly string[]): Promise<Result<string>> => {
        const command = args.slice(2).join("\0");
        if (command === hookSetCommand(prefix)) {
          return err("injected final mutation failure");
        }
        if (command === "config\0--local\0--unset-all\0extensions.worktreeConfig") {
          started.resolve();
          await release.promise;
        }
        return await delegated.git(args);
      },
    }, { signal: controller.signal }).then((result) => {
      settled = true;
      return result;
    });

    await started.promise;
    controller.abort({ tag: "SIGTERM" } satisfies HookCancellationReason);
    await Promise.resolve();
    assert(!settled);
    assert((await Deno.readTextFile(configPath)).includes('"mci:ci"'));
    assert(await exists(`${repository}/ci/local-ci.yml`));
    assert(await exists(`${repository}/.gitignore`));
    release.resolve();
    const result = await installing;
    assert(!result.ok && result.error.includes("injected final mutation failure"));
    equal(await Deno.readTextFile(configPath), beforeConfig);
    assert(!await exists(`${repository}/ci/local-ci.yml`));
    assert(!await exists(`${repository}/.gitignore`));
    await absentGitValue(repository, [
      "config",
      "--local",
      "--get",
      "extensions.worktreeConfig",
    ]);
  });
});
