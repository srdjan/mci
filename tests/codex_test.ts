import { type CiReceipt, sessionReceiptDirectory } from "../src/ci-receipt.ts";
import {
  type HookEvent,
  hookResponse,
  installCodexHooks,
  nativeHookCommand,
} from "../src/codex.ts";
import { cliSourceArgs } from "../src/runtime.ts";
import { assert, equal, inWorkspace, unwrap } from "./helpers.ts";
import { ok } from "../src/result.ts";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const names = ["MCI_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID"] as const;

// The hook reads MCI_SESSION_ID from the process, so tests set it explicitly.
const withEnv = async (
  values: Readonly<Partial<Record<(typeof names)[number], string>>>,
  act: () => Promise<void>,
): Promise<void> => {
  const prior = names.map((name) => [name, Deno.env.get(name)] as const);
  const apply = (name: string, value: string | undefined) =>
    value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
  try {
    for (const name of names) apply(name, values[name]);
    await act();
  } finally {
    for (const [name, value] of prior) apply(name, value);
  }
};

const failure = (job = "check"): CiReceipt["outcome"] => ({
  kind: "failure",
  code: 1,
  detail: `${job} failed`,
  requestId: "request-1",
  log: "/tmp/request-1.log",
});

const success: CiReceipt["outcome"] = {
  kind: "success",
  code: 0,
  detail: "ok",
  requestId: null,
  log: null,
};

let counter = 0;
const receipt = (
  session: string,
  workspace: string,
  values: Partial<CiReceipt> = {},
): CiReceipt => {
  counter += 1;
  return {
    version: 1,
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    sessionId: session,
    workspace,
    workflow: `${workspace}/ci.yml`,
    job: "check",
    command: "ci",
    started: "2026-10-04T12:00:00.000Z",
    finished: "2026-10-04T12:01:00.000Z",
    outcome: failure(),
    ...values,
  };
};

const save = async (home: string, values: CiReceipt): Promise<void> => {
  const directory = unwrap(await sessionReceiptDirectory(values.sessionId, home));
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(`${directory}/${values.id}.json`, JSON.stringify(values));
};

const event = (name: HookEvent["name"], stopHookActive = false): HookEvent => ({
  sessionId: "s",
  name,
  stopHookActive,
});

const respond = (
  home: string,
  name: HookEvent["name"],
  stopHookActive = false,
  warnings: string[] = [],
) => hookResponse(event(name, stopHookActive), home, (line) => warnings.push(line));

const inHome = (
  act: (home: string, workspace: string) => Promise<void>,
): Promise<void> =>
  inWorkspace(async (workspace) => {
    const home = `${workspace}/home`;
    await withEnv({}, () => act(home, workspace));
  });

Deno.test("Codex hook returns {} without receipts and for PostToolUse", () =>
  inHome(async (home, workspace) => {
    equal(await respond(home, "SessionStart"), {});
    await save(home, receipt("s", workspace));
    equal(await respond(home, "PostToolUse"), {});
  }));

Deno.test("Codex hook restores a failure at session start and prompt submission", () =>
  inHome(async (home, workspace) => {
    await save(home, receipt("s", workspace));
    for (const name of ["SessionStart", "UserPromptSubmit"] as const) {
      const output = await respond(home, name);
      const system = output.systemMessage;
      assert(typeof system === "string");
      assert(system.includes("CI failed for job check"));
      assert(system.includes("Request: request-1. Evidence: /tmp/request-1.log."));
      const specific = output.hookSpecificOutput as Record<string, unknown>;
      equal(specific.hookEventName, name);
      assert((specific.additionalContext as string).startsWith(system));
    }
  }));

Deno.test("Codex Stop requests continuation unless the hook is already active", () =>
  inHome(async (home, workspace) => {
    await save(home, receipt("s", workspace));
    const first = await respond(home, "Stop");
    equal(first.decision, "block");
    assert(typeof first.reason === "string");
    const second = await respond(home, "Stop", true);
    equal(second.continue, false);
    assert(!("decision" in second));
    assert(typeof second.stopReason === "string");
    assert(typeof second.systemMessage === "string");
  }));

Deno.test("Codex hook clears a failure only after a later matching success", () =>
  inHome(async (home, workspace) => {
    const failed = receipt("s", workspace);
    await save(home, failed);
    const attempts: readonly [string, Partial<CiReceipt>][] = [
      ["earlier success", { started: "2026-10-04T11:00:00.000Z", outcome: success }],
      ["other job", { job: "lint", outcome: success }],
      ["other workflow", { workflow: `${workspace}/other.yml`, outcome: success }],
      ["other workspace", { workspace: "/elsewhere", outcome: success }],
      ["later failure", { outcome: failure() }],
    ];
    for (const [label, values] of attempts) {
      const other = receipt("s", workspace, {
        started: "2026-10-04T12:05:00.000Z",
        finished: "2026-10-04T12:06:00.000Z",
        ...values,
      });
      await save(home, other);
      const output = await respond(home, "SessionStart");
      assert(
        String(output.systemMessage).includes("check failed"),
        `${label} must not clear the failure`,
      );
    }
    await save(
      home,
      receipt("s", workspace, {
        started: "2026-10-04T12:07:00.000Z",
        finished: "2026-10-04T12:08:00.000Z",
        outcome: success,
      }),
    );
    equal(await respond(home, "SessionStart"), {});
  }));

Deno.test("Codex hook compares start times for a pending failure", () =>
  inHome(async (home, workspace) => {
    const pending: CiReceipt["outcome"] = {
      kind: "pending",
      code: null,
      detail: null,
      requestId: null,
      log: null,
    };
    await save(
      home,
      receipt("s", workspace, { finished: null, outcome: pending }),
    );
    const early = await respond(home, "SessionStart");
    assert(String(early.systemMessage).includes("CI has no final result"));
    assert(String(early.systemMessage).includes(`${home}/sessions/`));
    await save(
      home,
      receipt("s", workspace, {
        started: "2026-10-04T12:00:00.000Z",
        finished: "2026-10-04T12:00:01.000Z",
        outcome: success,
      }),
    );
    equal(await respond(home, "SessionStart"), {});
  }));

Deno.test("Codex hook clears a validation error on any later success in the workspace", () =>
  inHome(async (home, workspace) => {
    const invalid: CiReceipt["outcome"] = {
      kind: "error",
      code: 2,
      detail: "job typo not found",
      requestId: null,
      log: null,
    };
    await save(home, receipt("s", workspace, { job: "typo", outcome: invalid }));
    const infrastructure: CiReceipt["outcome"] = {
      ...invalid,
      code: 1,
      detail: "daemon unavailable",
    };
    await save(
      home,
      receipt("s", workspace, { job: "infra", outcome: infrastructure }),
    );
    await save(
      home,
      receipt("s", workspace, {
        job: "check",
        started: "2026-10-04T12:05:00.000Z",
        finished: "2026-10-04T12:06:00.000Z",
        outcome: success,
      }),
    );
    const output = String((await respond(home, "SessionStart")).systemMessage);
    assert(!output.includes("job typo not found"));
    assert(output.includes("daemon unavailable"), "a code 1 error needs its own success");
  }));

Deno.test("Codex hook uses MCI_SESSION_ID and ignores inherited Codex identifiers", () =>
  inWorkspace(async (workspace) => {
    const home = `${workspace}/home`;
    await save(home, receipt("override", workspace));
    await save(home, receipt("inherited", workspace, { job: "other" }));
    await withEnv(
      { CODEX_SESSION_ID: "inherited", CODEX_THREAD_ID: "inherited" },
      async () => {
        equal(await respond(home, "SessionStart"), {});
      },
    );
    await withEnv({ MCI_SESSION_ID: "override" }, async () => {
      const output = await respond(home, "SessionStart");
      assert(String(output.systemMessage).includes("job check"));
      assert(!String(output.systemMessage).includes("job other"));
    });
  }));

Deno.test("Codex hook warns once for a bad receipt and still reports the rest", () =>
  inHome(async (home, workspace) => {
    await save(home, receipt("s", workspace));
    const directory = unwrap(await sessionReceiptDirectory("s", home));
    await Deno.writeTextFile(`${directory}/bad.json`, "{");
    await Deno.writeTextFile(`${directory}/.codex-notified`, "[]");
    await Deno.writeTextFile(`${directory}/.codex-notified.lock`, "");
    const warnings: string[] = [];
    const output = await respond(home, "SessionStart", false, warnings);
    assert(String(output.systemMessage).includes("CI failed"));
    equal(warnings.length, 1);
    assert(warnings[0]?.includes("bad.json"));
  }));

const cli = (
  workspace: string,
  home: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Deno.Command =>
  new Deno.Command(Deno.execPath(), {
    args: cliSourceArgs(args),
    cwd: workspace,
    env: {
      MCI_HOME: home,
      MCI_SESSION_ID: "",
      CODEX_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      ...env,
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

const runHook = async (workspace: string, home: string, input: string) => {
  const child = cli(workspace, home, ["codex", "hook"]).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const output = await child.output();
  return { code: output.code, stdout: text(output.stdout), stderr: text(output.stderr) };
};

Deno.test("mci codex hook reads stdin and rejects bad or oversized events", () =>
  inWorkspace(async (workspace) => {
    const home = `${workspace}/home`;
    await save(home, receipt("cli", workspace));
    const stop = await runHook(
      workspace,
      home,
      JSON.stringify({
        session_id: "cli",
        cwd: workspace,
        hook_event_name: "Stop",
        stop_hook_active: false,
      }),
    );
    equal(stop.code, 0);
    equal(JSON.parse(stop.stdout).decision, "block");
    const invalid = await runHook(workspace, home, "{}");
    equal(invalid.code, 2);
    assert(invalid.stderr.includes("Invalid Codex hook event"));
    const huge = await runHook(workspace, home, `"${"x".repeat(1024 * 1024 + 1)}"`);
    equal(huge.code, 2);
    assert(huge.stderr.includes("too large"));
  }));

const command = () => Promise.resolve(ok("'/bin/mci' 'codex' 'hook'"));
const marker = "mci: check unresolved CI receipts";
const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await Deno.readTextFile(path));

Deno.test("Codex installer merges handlers, removes the old PostToolUse one, and is idempotent", () =>
  inWorkspace(async (workspace) => {
    const repository = `${workspace}/repository's path`;
    await Deno.mkdir(`${repository}/.codex`, { recursive: true });
    const foreign = {
      type: "command",
      command: "printf foreign",
      statusMessage: "foreign",
    };
    const old = {
      type: "command",
      command: "'/old/deno' 'run' '/old/src/main.ts' 'codex' 'hook'",
      statusMessage: marker,
    };
    const path = `${repository}/.codex/hooks.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        project: "kept",
        hooks: {
          ForeignEvent: [{ hooks: [foreign] }],
          PostToolUse: [{ matcher: "Write", hooks: [foreign] }, { hooks: [old] }],
          Stop: [{ hooks: [foreign, old] }],
        },
      }),
    );
    unwrap(await installCodexHooks(repository, command));
    const installed = await readJson(path);
    equal(installed.project, "kept");
    const hooks = installed.hooks as Record<
      string,
      { hooks: Record<string, unknown>[] }[]
    >;
    equal(hooks.ForeignEvent, [{ hooks: [foreign] }]);
    equal(hooks.PostToolUse, [{ matcher: "Write", hooks: [foreign] }]);
    for (const name of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const handlers = hooks[name]!.flatMap((group) => group.hooks);
      equal(handlers.filter((handler) => handler.statusMessage === marker), [{
        type: "command",
        command: "'/bin/mci' 'codex' 'hook'",
        timeout: 10,
        statusMessage: marker,
      }]);
    }
    assert(hooks.Stop![0]!.hooks.some((handler) => handler.command === "printf foreign"));
    assert(!JSON.stringify(installed).includes("/old/src/main.ts"));

    const first = await Deno.readTextFile(path);
    unwrap(await installCodexHooks(repository, command));
    equal(await Deno.readTextFile(path), first);
  }));

Deno.test("Codex installer keeps permission bits and creates new files as 0644", () =>
  inWorkspace(async (workspace) => {
    for (const mode of [0o600, 0o400, 0o1600]) {
      const repository = `${workspace}/mode-${mode.toString(8)}`;
      const path = `${repository}/.codex/hooks.json`;
      await Deno.mkdir(`${repository}/.codex`, { recursive: true });
      await Deno.writeTextFile(path, '{"project":"kept"}\n');
      await Deno.chmod(path, mode);
      for (let run = 0; run < 2; run += 1) {
        unwrap(await installCodexHooks(repository, command));
        equal((await Deno.stat(path)).mode! & 0o7777, mode);
      }
    }
    const fresh = `${workspace}/fresh`;
    await Deno.mkdir(fresh);
    const path = unwrap(await installCodexHooks(fresh, command));
    equal((await Deno.stat(path)).mode! & 0o777, 0o644);
    equal((await Deno.stat(`${fresh}/.codex`)).mode! & 0o777, 0o755);
  }));

Deno.test("Codex installer refuses malformed or linked configuration and keeps it unchanged", () =>
  inWorkspace(async (workspace) => {
    const malformed = `${workspace}/malformed`;
    await Deno.mkdir(`${malformed}/.codex`, { recursive: true });
    for (const content of ["{", "[]", '{"hooks":[]}', '{"hooks":{"Stop":[{}]}}']) {
      await Deno.writeTextFile(`${malformed}/.codex/hooks.json`, content);
      assert(!(await installCodexHooks(malformed, command)).ok, content);
      equal(await Deno.readTextFile(`${malformed}/.codex/hooks.json`), content);
    }
    const linked = `${workspace}/linked`;
    await Deno.mkdir(`${linked}/.codex`, { recursive: true });
    await Deno.writeTextFile(`${workspace}/outside.json`, "{}\n");
    await Deno.symlink(`${workspace}/outside.json`, `${linked}/.codex/hooks.json`);
    assert(!(await installCodexHooks(linked, command)).ok);
    equal(await Deno.readTextFile(`${workspace}/outside.json`), "{}\n");
    assert(!(await installCodexHooks(`${workspace}/missing`, command)).ok);
    await Deno.writeTextFile(`${workspace}/file`, "");
    assert(!(await installCodexHooks(`${workspace}/file`, command)).ok);
  }));

Deno.test("Codex installer follows a linked repository path", () =>
  inWorkspace(async (workspace) => {
    await Deno.mkdir(`${workspace}/repository`);
    await Deno.symlink(`${workspace}/repository`, `${workspace}/link`);
    unwrap(await installCodexHooks(`${workspace}/link`, command));
    assert((await Deno.lstat(`${workspace}/repository/.codex/hooks.json`)).isFile);
  }));

Deno.test("mci codex install writes a command that the shell can run", () =>
  inWorkspace(async (workspace) => {
    const home = `${workspace}/home`;
    const repository = `${workspace}/repository`;
    await Deno.mkdir(repository);
    const installer = cli(workspace, home, ["codex", "install", repository]).spawn();
    await installer.stdin.close();
    const installed = await installer.output();
    equal(installed.code, 0);
    assert(text(installed.stdout).includes("Review and trust"));
    const expected = unwrap(await nativeHookCommand());
    const hooks = (await readJson(`${repository}/.codex/hooks.json`)).hooks as Record<
      string,
      { hooks: { command: string }[] }[]
    >;
    equal(hooks.Stop![0]!.hooks[0]!.command, expected);
    assert(!("PostToolUse" in hooks));
    const generated = new Deno.Command("/bin/zsh", {
      args: ["-c", expected],
      cwd: repository,
      env: { MCI_HOME: home },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = generated.stdin.getWriter();
    await writer.write(
      new TextEncoder().encode(JSON.stringify({
        session_id: "installed",
        cwd: repository,
        hook_event_name: "SessionStart",
      })),
    );
    await writer.close();
    const output = await generated.output();
    equal(output.code, 0);
    equal(text(output.stdout).trim(), "{}");
  }));
