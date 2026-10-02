import { resolveBash, runPlan, stepEnvironment } from "../src/runner.ts";
import { cliSourceArgs } from "../src/runtime.ts";
import { type Plan, planWorkflow } from "../src/workflow.ts";
import {
  assert,
  equal,
  exists,
  fixture,
  inWorkspace,
  unwrap,
  waitFor,
} from "./helpers.ts";

const execute = async (source: string, workspace: string, extra: {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
} = {}) => {
  const parsed = planWorkflow(source, "check");
  if (!parsed.ok) return { kind: "invalid", code: 2, completed: 0, detail: parsed.error };
  const plan: Plan = {
    ...parsed.value,
    timeoutMs: extra.timeoutMs ?? parsed.value.timeoutMs,
  };
  const inherited: Record<string, string> = {
    ...Deno.env.toObject(),
    FROM_PARENT: "yes",
    GITHUB_TOKEN: "must-be-cleared",
  };
  const shell = unwrap(await resolveBash(workspace, inherited.PATH ?? ""));
  return runPlan(plan, {
    workspace,
    shell,
    inherited,
    signal: extra.signal,
    log: () => {},
  });
};

const stopGroup = (pid: number): void => {
  try {
    Deno.kill(-pid, "SIGKILL");
  } catch (error) {
    assert(error instanceof Deno.errors.NotFound, String(error));
  }
};

Deno.test("later unsupported step causes zero effects", () =>
  inWorkspace(async (workspace) => {
    const outcome = await execute(
      fixture("      - run: touch must-not-exist\n      - uses: actions/checkout@v4"),
      workspace,
    );
    equal(outcome.code, 2);
    assert(!await exists(`${workspace}/must-not-exist`));
  }));

Deno.test("fresh shells, shared files, precedence, stdin and paths with spaces", () =>
  inWorkspace(async (workspace) => {
    const source = fixture(`      - run: |
          test "$FROM_PARENT" = yes
          test "$CI" = true
          test "$MCI_LOCAL" = true
          test -z "\${GITHUB_TOKEN+x}"
          test "$VALUE" = first
          if read -r input; then exit 9; fi
          mkdir 'created directory'
          export PRIVATE_TO_STEP=secret
          cd 'created directory'
          printf 'created' > artifact
        env:
          VALUE: first
      - run: |
          test -z "\${PRIVATE_TO_STEP+x}"
          test "$VALUE" = job
          test -f artifact
          printf 'checked' > checked
        working-directory: created directory
      - run: test -f 'created directory/checked'`)
      .replace("    runs-on:", "    env: {VALUE: job}\n    runs-on:");
    equal((await execute(source, workspace)).code, 0);
    equal(await Deno.readTextFile(`${workspace}/created directory/checked`), "checked");
  }));

Deno.test("pipeline failure stops later steps and preserves working files", () =>
  inWorkspace(async (workspace) => {
    await Deno.writeTextFile(`${workspace}/uncommitted`, "keep me");
    const result = await execute(
      fixture("      - run: false | cat\n      - run: touch skipped"),
      workspace,
    );
    equal(result.code, 1);
    equal(result.completed, 1);
    assert(!await exists(`${workspace}/skipped`));
    equal(await Deno.readTextFile(`${workspace}/uncommitted`), "keep me");
  }));

Deno.test("symlink escape and missing command are explicit failures", () =>
  inWorkspace(async (workspace) => {
    await Deno.symlink("/tmp", `${workspace}/outside`);
    const result = await execute(
      fixture("      - run: pwd\n        working-directory: outside"),
      workspace,
    );
    equal(result.code, 1);
    assert(result.detail.includes("outside the workspace"));
    const missing = await execute(
      fixture("      - run: mci_intentionally_missing_command_xyz"),
      workspace,
    );
    equal(missing.code, 1);
    assert(missing.detail.includes("127"));
  }));

Deno.test("environment filters inherited runner state and startup files", () => {
  equal(
    stepEnvironment({
      PATH: "/bin",
      BASH_ENV: "evil",
      ENV: "evil",
      GITHUB_ENV: "file",
      RUNNER_TEMP: "path",
      MCI_TASK_PARENT: "true",
      X: "old",
    }, { X: "new" }),
    { PATH: "/bin", X: "new", CI: "true", MCI_LOCAL: "true" },
  );
});

Deno.test("runner-owned scripts are removed after execution", () =>
  inWorkspace(async (workspace) => {
    equal(
      (await execute(fixture('      - run: echo "$0" > script-path'), workspace)).code,
      0,
    );
    const script = (await Deno.readTextFile(`${workspace}/script-path`)).trim();
    assert(!await exists(script), "temporary script was not removed");
  }));

Deno.test("deadline is shared across steps rather than restarted", () =>
  inWorkspace(async (workspace) => {
    const source = fixture(
      "      - run: sleep 0.2\n      - run: sleep 0.4\n      - run: touch skipped",
    );
    const result = await execute(source, workspace, { timeoutMs: 400 });
    equal(result.code, 124);
    equal(result.completed, 1);
    assert(!await exists(`${workspace}/skipped`));
  }));

// Real process-group checks; no mocked kill API. A TERM trap gives observable evidence
// that the descendant received the signal without depending on zombie-reaping behavior.
const background = `      - run: |
          bash --noprofile --norc -c 'trap "echo stopped > child-stopped; exit 0" TERM; echo ready > child-ready; while :; do sleep 0.05; done' &
          while [ ! -f child-ready ]; do sleep 0.01; done
`;

Deno.test("success cleans up background descendants before the next step", () =>
  inWorkspace(async (workspace) => {
    const result = await execute(
      fixture(background + "      - run: test -f child-stopped"),
      workspace,
    );
    equal(result.code, 0);
    assert(await exists(`${workspace}/child-stopped`));
  }));

Deno.test("job timeout reaches children and skips later steps", () =>
  inWorkspace(async (workspace) => {
    const source = fixture(background + "          wait\n      - run: touch skipped");
    const result = await execute(source, workspace, { timeoutMs: 400 });
    equal(result.code, 124);
    assert(await exists(`${workspace}/child-stopped`));
    assert(!await exists(`${workspace}/skipped`));
  }));

Deno.test("cancellation terminates the active group", () =>
  inWorkspace(async (workspace) => {
    const controller = new AbortController();
    const running = execute(
      fixture(background + "          wait\n      - run: touch skipped"),
      workspace,
      { signal: controller.signal },
    );
    try {
      await waitFor(() => exists(`${workspace}/child-ready`));
    } finally {
      controller.abort("SIGTERM");
    }
    equal((await running).code, 143);
    assert(await exists(`${workspace}/child-stopped`));
    assert(!await exists(`${workspace}/skipped`));
  }));

Deno.test("already-cancelled invocation launches no step", () =>
  inWorkspace(async (workspace) => {
    const controller = new AbortController();
    controller.abort("SIGINT");
    const result = await execute(fixture("      - run: touch forbidden"), workspace, {
      signal: controller.signal,
    });
    equal(result.code, 130);
    assert(!await exists(`${workspace}/forbidden`));
  }));

Deno.test("competing runs cannot change the same workspace", () =>
  inWorkspace(async (workspace) => {
    const first = execute(
      fixture(
        "      - run: |\n          touch ready\n          while [ ! -f release ]; do sleep 0.01; done",
      ),
      workspace,
    );
    let second;
    try {
      await waitFor(() => exists(`${workspace}/ready`));
      second = await execute(fixture("      - run: touch forbidden"), workspace);
    } finally {
      await Deno.writeTextFile(`${workspace}/release`, "release");
      await first;
    }
    equal(second.code, 1);
    assert(second.detail.includes("already running"), second.detail);
    assert(!await exists(`${workspace}/forbidden`));
    equal(
      (await execute(fixture("      - run: touch after-release"), workspace)).code,
      0,
    );
  }));

Deno.test("cleanup failure retains the failed step detail", () =>
  inWorkspace(async (workspace) => {
    let directory: string | undefined;
    try {
      const outcome = await execute(
        fixture(
          '      - run: |\n          dirname "$0" > private-directory\n          chmod 000 "$(dirname "$0")"\n          exit 23',
        ),
        workspace,
      );
      directory = (await Deno.readTextFile(`${workspace}/private-directory`)).trim();
      equal(outcome.code, 1);
      assert(outcome.detail.includes("exit 23"), outcome.detail);
      assert(outcome.detail.includes("cleanup"), outcome.detail);
    } finally {
      if (directory) {
        await Deno.chmod(directory, 0o700);
        await Deno.remove(directory, { recursive: true });
      }
    }
  }));

Deno.test({
  name: "macOS next run recovers a recorded process after runner SIGKILL",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await Deno.writeTextFile(
        `${workspace}/crash.yml`,
        fixture(
          "      - run: |\n          trap 'echo stopped > stopped; exit 0' TERM\n          echo $$ > active-pid\n          touch ready\n          while :; do sleep 0.02; done",
        ),
      );
      const command = (file: string) =>
        new Deno.Command(Deno.execPath(), {
          args: cliSourceArgs(["run", file, "--job", "check"]),
          cwd: workspace,
          stdout: "piped",
          stderr: "piped",
        });
      const owner = command("crash.yml").spawn();
      const output = owner.output();
      let pid: number | undefined;
      let ownerStopped = false;
      try {
        await waitFor(async () => {
          if (!await exists(`${workspace}/ready`)) return false;
          const value: unknown = JSON.parse(
            await Deno.readTextFile(`${workspace}/.mci/run.json`),
          );
          return typeof value === "object" && value !== null && "process" in value &&
            typeof value.process === "object" && value.process !== null;
        });
        pid = Number((await Deno.readTextFile(`${workspace}/active-pid`)).trim());
        assert(Number.isSafeInteger(pid) && pid > 0);
        owner.kill("SIGKILL");
        ownerStopped = true;
        await owner.status;
        assert(await exists(`${workspace}/.mci/run.json`));
        await Deno.writeTextFile(
          `${workspace}/next.yml`,
          fixture("      - run: touch recovered"),
        );
        const next = await command("next.yml").output();
        equal(next.code, 0);
        assert(await exists(`${workspace}/stopped`));
        assert(await exists(`${workspace}/recovered`));
        assert(!await exists(`${workspace}/.mci/run.json`));
        await output;
      } finally {
        if (pid !== undefined) {
          stopGroup(pid);
        }
        if (!ownerStopped) {
          owner.kill("SIGKILL");
        }
        await output;
      }
    }),
});
