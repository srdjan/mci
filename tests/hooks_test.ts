import { hookScript, installHookWith, nativeHookCapabilities } from "../src/hooks.ts";
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
  const repository = `${root}/repository`;
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
    await Deno.writeTextFile(
      `${repository}/.github/workflows/ci.yml`,
      workflow.replace("deno task test", "deno task ci"),
    );
    const before = await Deno.readTextFile(`${repository}/deno.json`);
    const result = await installHookWith(
      repository,
      ".github/workflows/ci.yml",
      "check",
      capabilities(prefix),
    );
    assert(!result.ok && result.error.includes("recurse"));
    equal(await Deno.readTextFile(`${repository}/deno.json`), before);
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
