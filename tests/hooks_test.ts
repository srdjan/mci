import {
  type HookCapabilities,
  hookScript,
  hookTask,
  installHookWith,
  nativeHookCapabilities,
  setupHookWith,
} from "../src/hooks.ts";
import { err, ok } from "../src/result.ts";
import { assert, equal, exists, inWorkspace } from "./helpers.ts";

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

const missingValue = "/usr/bin/git exited with 1";

type Fixture = {
  readonly root: string;
  readonly prefix: string;
  readonly hooksPath: string;
  readonly gitHooks: string;
  readonly calls: string[][];
  readonly capabilities: HookCapabilities;
  readonly configured: { value: string | null };
  readonly failSet: { value: boolean };
  readonly toplevel: { value: string };
};

// The git double answers the four commands that the hook code uses.
const withFixture = (
  test: (fixture: Fixture) => Promise<void>,
): Promise<void> =>
  inWorkspace(async (root) => {
    const prefix = `${root}/brew`;
    const hooksPath = `${prefix}/libexec/hooks`;
    const gitHooks = `${root}/.git/hooks`;
    await Deno.mkdir(`${prefix}/bin`, { recursive: true });
    await Deno.mkdir(hooksPath, { recursive: true });
    await Deno.mkdir(gitHooks, { recursive: true });
    await Deno.writeTextFile(`${prefix}/bin/mci`, "binary");
    await Deno.writeTextFile(`${hooksPath}/pre-commit`, hookScript);
    await Deno.chmod(`${hooksPath}/pre-commit`, 0o755);
    await Deno.mkdir(`${root}/ci`);
    await Deno.writeTextFile(`${root}/ci/local-ci.yml`, workflow);
    await Deno.writeTextFile(`${root}/deno.json`, '{"tasks":{"test":"deno test"}}\n');
    const calls: string[][] = [];
    const configured = { value: null as string | null };
    const failSet = { value: false };
    const toplevel = { value: root };
    const capabilities: HookCapabilities = {
      brewPrefix: () => Promise.resolve(ok(prefix)),
      git: (args) => {
        calls.push([...args]);
        const command = args.slice(2).join(" ");
        if (command === "rev-parse --show-toplevel") {
          return Promise.resolve(ok(toplevel.value));
        }
        if (command === "config --get core.hooksPath") {
          return Promise.resolve(
            configured.value === null ? err(missingValue) : ok(configured.value),
          );
        }
        if (command === "rev-parse --path-format=absolute --git-path hooks") {
          return Promise.resolve(ok(gitHooks));
        }
        if (
          args[2] === "config" && args[3] === "--local" && args[4] === "core.hooksPath"
        ) {
          return Promise.resolve(failSet.value ? err("config is locked") : ok(""));
        }
        return Promise.resolve(err(`unexpected git ${command}`));
      },
    };
    await test({
      root,
      prefix,
      hooksPath,
      gitHooks,
      calls,
      capabilities,
      configured,
      failSet,
      toplevel,
    });
  });

const install = (fixture: Fixture, file = "ci/local-ci.yml", job = "check") =>
  installHookWith(fixture.root, file, job, fixture.capabilities);

const refusal = async (
  result: ReturnType<typeof install>,
  detail: string,
): Promise<void> => {
  const settled = await result;
  assert(!settled.ok, "expected a refusal");
  assert(settled.error.includes(detail), settled.error);
};

const setCalls = (fixture: Fixture) =>
  fixture.calls.filter((call) => call.includes("--local"));

const denoJson = async (root: string) =>
  JSON.parse(await Deno.readTextFile(`${root}/deno.json`));

Deno.test("install refuses a path that is not a worktree root", () =>
  withFixture(async (fixture) => {
    await Deno.mkdir(`${fixture.root}/sub`);
    fixture.toplevel.value = fixture.root;
    await refusal(
      installHookWith(
        `${fixture.root}/sub`,
        "ci/local-ci.yml",
        "check",
        fixture.capabilities,
      ),
      "must be the Git worktree root",
    );
    await refusal(
      installHookWith("relative", "ci/local-ci.yml", "check", fixture.capabilities),
      "must be absolute",
    );
    const noGit: HookCapabilities = {
      ...fixture.capabilities,
      git: () => Promise.resolve(err("not a repository")),
    };
    await refusal(
      installHookWith(fixture.root, "ci/local-ci.yml", "check", noGit),
      "not a Git repository",
    );
    equal(setCalls(fixture).length, 0);
  }));

Deno.test("install refuses an invalid workflow, job, or workflow path", () =>
  withFixture(async (fixture) => {
    await refusal(install(fixture, "ci/local-ci.yml", "absent"), "cannot run job absent");
    await refusal(install(fixture, "ci/missing.yml"), "does not identify a file");
    await refusal(install(fixture, "../escape.yml"), "must stay inside");
    await refusal(install(fixture, "/etc/hosts"), "must stay inside");
    await Deno.writeTextFile(`${fixture.root}/ci/bad.yml`, "jobs: [");
    await refusal(install(fixture, "ci/bad.yml"), "cannot run job check");
    equal(await Deno.readTextFile(`${fixture.root}/deno.json`).then(JSON.parse), {
      tasks: { test: "deno test" },
    });
  }));

Deno.test("install refuses a missing or foreign packaged hook installation", () =>
  withFixture(async (fixture) => {
    const hook = `${fixture.hooksPath}/pre-commit`;
    await Deno.writeTextFile(hook, "#!/bin/sh\nexit 0\n");
    await refusal(install(fixture), "not managed by mci");
    await Deno.writeTextFile(hook, hookScript);
    await Deno.chmod(hook, 0o644);
    await refusal(install(fixture), "not executable");
    await Deno.remove(hook);
    await refusal(install(fixture), "absent");
    await Deno.remove(`${fixture.prefix}/bin/mci`);
    await refusal(install(fixture), "stable Homebrew binary is not available");
    const noBrew: HookCapabilities = {
      ...fixture.capabilities,
      brewPrefix: () => Promise.resolve(err("no formula")),
    };
    await refusal(
      installHookWith(fixture.root, "ci/local-ci.yml", "check", noBrew),
      "no formula",
    );
    equal(setCalls(fixture).length, 0);
    assert(!("mci:ci" in (await denoJson(fixture.root)).tasks));
  }));

Deno.test("install refuses a core.hooksPath that names another directory", () =>
  withFixture(async (fixture) => {
    fixture.configured.value = "/somewhere/else";
    await refusal(install(fixture), "core.hooksPath already names /somewhere/else");
    equal(setCalls(fixture).length, 0);
    assert(!("mci:ci" in (await denoJson(fixture.root)).tasks));
  }));

Deno.test("install refuses active hooks and ignores samples and inactive files", () =>
  withFixture(async (fixture) => {
    const write = async (name: string, mode: number) => {
      await Deno.writeTextFile(`${fixture.gitHooks}/${name}`, "#!/bin/sh\n");
      await Deno.chmod(`${fixture.gitHooks}/${name}`, mode);
    };
    await write("pre-commit.sample", 0o755);
    await write("pre-push", 0o644);
    await write("unrelated", 0o755);
    const clear = await install(fixture);
    assert(clear.ok, clear.ok ? "" : clear.error);
    equal(setCalls(fixture).length, 1);

    await write("pre-push", 0o755);
    await write("commit-msg", 0o755);
    fixture.calls.length = 0;
    const refused = await install(fixture);
    assert(!refused.ok);
    assert(refused.error.includes("commit-msg, pre-push"), refused.error);
    assert(!refused.error.includes("pre-commit.sample"), refused.error);
    equal(setCalls(fixture).length, 0);
  }));

Deno.test("install keeps a matching task and skips Git when the hook path is set", () =>
  withFixture(async (fixture) => {
    const task = hookTask(`${fixture.prefix}/bin/mci`, "ci/local-ci.yml", "check");
    const source = `{"tasks":{"mci:ci":${JSON.stringify(task)}}}`;
    await Deno.writeTextFile(`${fixture.root}/deno.json`, source);
    await Deno.chmod(`${fixture.root}/deno.json`, 0o600);
    const before = await Deno.stat(`${fixture.root}/deno.json`);
    fixture.configured.value = fixture.hooksPath;
    const result = await install(fixture);
    assert(result.ok, result.ok ? "" : result.error);
    equal(await Deno.readTextFile(`${fixture.root}/deno.json`), source);
    equal((await Deno.stat(`${fixture.root}/deno.json`)).ino, before.ino);
    equal(setCalls(fixture).length, 0);
    equal(
      [...Deno.readDirSync(fixture.root)].filter((entry) => entry.name.endsWith(".tmp"))
        .length,
      0,
    );
  }));

Deno.test("install accepts the real path of the packaged hooks directory", () =>
  withFixture(async (fixture) => {
    const link = `${fixture.root}/link`;
    await Deno.symlink(fixture.prefix, link);
    const throughLink: HookCapabilities = {
      ...fixture.capabilities,
      brewPrefix: () => Promise.resolve(ok(link)),
    };
    fixture.configured.value = await Deno.realPath(`${link}/libexec/hooks`);
    const result = await installHookWith(
      fixture.root,
      "ci/local-ci.yml",
      "check",
      throughLink,
    );
    assert(result.ok, result.ok ? "" : result.error);
    equal(setCalls(fixture).length, 0);
    equal(
      (await denoJson(fixture.root)).tasks["mci:ci"],
      hookTask(
        `${link}/bin/mci`,
        "ci/local-ci.yml",
        "check",
      ),
    );
  }));

Deno.test("install adds the task, keeps other keys and permission bits, sets the path", () =>
  withFixture(async (fixture) => {
    await Deno.writeTextFile(
      `${fixture.root}/deno.json`,
      '{"name":"x","tasks":{"test":"deno test"}}\n',
    );
    await Deno.chmod(`${fixture.root}/deno.json`, 0o640);
    const result = await install(fixture);
    assert(result.ok, result.ok ? "" : result.error);
    const config = await denoJson(fixture.root);
    equal(config.name, "x");
    equal(config.tasks.test, "deno test");
    equal(
      config.tasks["mci:ci"],
      `'${fixture.prefix}/bin/mci' ci 'ci/local-ci.yml' --job 'check'`,
    );
    equal((await Deno.stat(`${fixture.root}/deno.json`)).mode! & 0o7777, 0o640);
    equal(setCalls(fixture), [[
      "-C",
      fixture.root,
      "config",
      "--local",
      "core.hooksPath",
      fixture.hooksPath,
    ]]);
    const again = await install(fixture);
    assert(again.ok, again.ok ? "" : again.error);
  }));

Deno.test("install creates the tasks object when deno.json has none", () =>
  withFixture(async (fixture) => {
    await Deno.writeTextFile(`${fixture.root}/deno.json`, '{"name":"x"}\n');
    const result = await install(fixture);
    assert(result.ok, result.ok ? "" : result.error);
    equal(Object.keys((await denoJson(fixture.root)).tasks), ["mci:ci"]);
    await Deno.writeTextFile(`${fixture.root}/deno.json`, '{"tasks":[]}\n');
    await refusal(install(fixture), "tasks must be an object");
    await Deno.writeTextFile(`${fixture.root}/deno.json`, "not json");
    await refusal(install(fixture), "not valid JSON");
    await Deno.remove(`${fixture.root}/deno.json`);
    await refusal(install(fixture), "regular deno.json");
  }));

Deno.test("install refuses a different mci:ci task and changes nothing", () =>
  withFixture(async (fixture) => {
    const source = '{"tasks":{"mci:ci":"echo other"}}\n';
    await Deno.writeTextFile(`${fixture.root}/deno.json`, source);
    await refusal(install(fixture), "different mci:ci task");
    equal(await Deno.readTextFile(`${fixture.root}/deno.json`), source);
    equal(setCalls(fixture).length, 0);
  }));

Deno.test("a failed git config names the step and a rerun completes the work", () =>
  withFixture(async (fixture) => {
    fixture.failSet.value = true;
    const failed = await install(fixture);
    assert(!failed.ok);
    assert(failed.error.includes("step 6"), failed.error);
    assert(failed.error.includes("config is locked"), failed.error);
    assert(failed.error.includes("Run the same command again"), failed.error);
    assert("mci:ci" in (await denoJson(fixture.root)).tasks);
    fixture.failSet.value = false;
    const rerun = await install(fixture);
    assert(rerun.ok, rerun.ok ? "" : rerun.error);
    equal(setCalls(fixture).length, 2);
  }));

Deno.test("setup generates the workflow from defined standard tasks in order", () =>
  withFixture(async (fixture) => {
    await Deno.remove(`${fixture.root}/ci`, { recursive: true });
    await Deno.writeTextFile(
      `${fixture.root}/deno.json`,
      '{"tasks":{"test":"a","check":"b","lint":"c","fmt:check":"d","other":"e"}}\n',
    );
    const result = await setupHookWith(fixture.root, fixture.capabilities);
    assert(result.ok, result.ok ? "" : result.error);
    equal(await Deno.readTextFile(`${fixture.root}/ci/local-ci.yml`), generatedWorkflow);
    equal((await Deno.stat(`${fixture.root}/ci/local-ci.yml`)).mode! & 0o777, 0o644);
    equal(await Deno.readTextFile(`${fixture.root}/.gitignore`), ".mci/\n");
    const config = await denoJson(fixture.root);
    equal(
      config.tasks["mci:ci"],
      `'${fixture.prefix}/bin/mci' ci 'ci/local-ci.yml' --job 'check'`,
    );
    equal(setCalls(fixture).length, 1);
  }));

Deno.test("setup omits undefined standard tasks and requires at least one", () =>
  withFixture(async (fixture) => {
    await Deno.remove(`${fixture.root}/ci`, { recursive: true });
    await Deno.writeTextFile(`${fixture.root}/deno.json`, '{"tasks":{"lint":"c"}}\n');
    const result = await setupHookWith(fixture.root, fixture.capabilities);
    assert(result.ok, result.ok ? "" : result.error);
    const generated = await Deno.readTextFile(`${fixture.root}/ci/local-ci.yml`);
    assert(generated.includes("deno task lint"));
    assert(!generated.includes("fmt:check") && !generated.includes("deno task test"));

    await Deno.remove(`${fixture.root}/ci`, { recursive: true });
    await Deno.remove(`${fixture.root}/.gitignore`);
    await Deno.writeTextFile(`${fixture.root}/deno.json`, '{"tasks":{"build":"x"}}\n');
    const none = await setupHookWith(fixture.root, fixture.capabilities);
    assert(!none.ok);
    assert(none.error.includes("at least one standard task"), none.error);
    assert(!await exists(`${fixture.root}/ci`));
    assert(!await exists(`${fixture.root}/.gitignore`));
  }));

Deno.test("setup keeps an existing workflow byte for byte and appends .gitignore", () =>
  withFixture(async (fixture) => {
    await Deno.writeTextFile(`${fixture.root}/deno.json`, '{"tasks":{"build":"x"}}\n');
    await Deno.writeTextFile(`${fixture.root}/.gitignore`, "dist/");
    await Deno.chmod(`${fixture.root}/.gitignore`, 0o600);
    const result = await setupHookWith(fixture.root, fixture.capabilities);
    assert(result.ok, result.ok ? "" : result.error);
    equal(await Deno.readTextFile(`${fixture.root}/ci/local-ci.yml`), workflow);
    equal(await Deno.readTextFile(`${fixture.root}/.gitignore`), "dist/\n.mci/\n");
    equal((await Deno.stat(`${fixture.root}/.gitignore`)).mode! & 0o777, 0o600);
    const again = await setupHookWith(fixture.root, fixture.capabilities);
    assert(again.ok, again.ok ? "" : again.error);
    equal(await Deno.readTextFile(`${fixture.root}/.gitignore`), "dist/\n.mci/\n");
    await Deno.writeTextFile(`${fixture.root}/.gitignore`, "/.mci/\r\nout/\r\n");
    const rooted = await setupHookWith(fixture.root, fixture.capabilities);
    assert(rooted.ok, rooted.ok ? "" : rooted.error);
    equal(await Deno.readTextFile(`${fixture.root}/.gitignore`), "/.mci/\r\nout/\r\n");
  }));

Deno.test("setup writes nothing when an install check refuses", () =>
  withFixture(async (fixture) => {
    await Deno.remove(`${fixture.root}/ci`, { recursive: true });
    await Deno.writeTextFile(`${fixture.root}/deno.json`, '{"tasks":{"test":"x"}}\n');
    fixture.configured.value = "/somewhere/else";
    const result = await setupHookWith(fixture.root, fixture.capabilities);
    assert(!result.ok);
    assert(result.error.includes("/somewhere/else"), result.error);
    assert(!await exists(`${fixture.root}/ci`));
    assert(!await exists(`${fixture.root}/.gitignore`));
    equal(
      await Deno.readTextFile(`${fixture.root}/deno.json`),
      '{"tasks":{"test":"x"}}\n',
    );
  }));

const git = async (cwd: string, ...args: string[]) => {
  const output = await new Deno.Command("/usr/bin/git", {
    args,
    cwd,
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin", HOME: cwd },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
  };
};

Deno.test("install works with real Git and refuses a real active hook", () =>
  withFixture(async (fixture) => {
    equal((await git(fixture.root, "init", "--quiet")).code, 0);
    const real: HookCapabilities = {
      brewPrefix: fixture.capabilities.brewPrefix,
      git: nativeHookCapabilities.git,
    };
    await Deno.writeTextFile(`${fixture.root}/.git/hooks/pre-push`, "#!/bin/sh\n");
    await Deno.chmod(`${fixture.root}/.git/hooks/pre-push`, 0o755);
    const refused = await installHookWith(fixture.root, "ci/local-ci.yml", "check", real);
    assert(
      !refused.ok && refused.error.includes("pre-push"),
      "expected pre-push refusal",
    );
    await Deno.remove(`${fixture.root}/.git/hooks/pre-push`);
    const result = await installHookWith(fixture.root, "ci/local-ci.yml", "check", real);
    assert(result.ok, result.ok ? "" : result.error);
    const configured = await git(fixture.root, "config", "--get", "core.hooksPath");
    equal(configured.stdout, fixture.hooksPath);
    const again = await installHookWith(fixture.root, "ci/local-ci.yml", "check", real);
    assert(again.ok, again.ok ? "" : again.error);
  }));

Deno.test("setup refuses a ci directory that resolves outside the repository", () =>
  withFixture(async (fixture) => {
    await Deno.remove(`${fixture.root}/ci`, { recursive: true });
    const outside = await Deno.makeTempDir({ prefix: "mci-outside-" });
    try {
      await Deno.symlink(outside, `${fixture.root}/ci`);
      await Deno.writeTextFile(`${fixture.root}/deno.json`, '{"tasks":{"lint":"c"}}\n');
      const result = await setupHookWith(fixture.root, fixture.capabilities);
      assert(!result.ok);
      assert(result.error.includes("inside the repository"), result.error);
      assert(!await exists(`${outside}/local-ci.yml`));
      equal(setCalls(fixture).length, 0);
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  }));
