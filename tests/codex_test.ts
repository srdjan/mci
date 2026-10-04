import { assert, equal, inWorkspace } from "./helpers.ts";
import { cliSourceArgs } from "../src/runtime.ts";
import {
  type CiReceipt,
  decodeCiReceipt,
  sessionReceiptDirectory,
} from "../src/ci-receipt.ts";
import { unwrap } from "./helpers.ts";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const cli = (
  workspace: string,
  home: string,
  args: readonly string[],
  stdin: "null" | "piped" = "null",
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
    stdin,
    stdout: "piped",
    stderr: "piped",
  });

type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runHook = async (
  workspace: string,
  home: string,
  event: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string>> = {},
): Promise<CommandResult> => {
  const child = cli(workspace, home, ["codex", "hook"], "piped", env).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(event)));
  await writer.close();
  const output = await child.output();
  return {
    code: output.code,
    stdout: text(output.stdout),
    stderr: text(output.stderr),
  };
};

const event = (
  sessionId: string,
  workspace: string,
  hookEventName: string,
  stopHookActive?: boolean,
): Readonly<Record<string, unknown>> => ({
  session_id: sessionId,
  cwd: workspace,
  hook_event_name: hookEventName,
  ...(stopHookActive === undefined ? {} : { stop_hook_active: stopHookActive }),
});

const receipt = (
  sessionId: string,
  workspace: string,
  values: Readonly<Partial<CiReceipt>> = {},
): CiReceipt => {
  const candidate: CiReceipt = {
    version: 1,
    id: crypto.randomUUID(),
    sessionId,
    workspace,
    workflow: `${workspace}/ci.yml`,
    job: "check",
    command: "ci",
    started: "2026-10-04T12:00:00.000Z",
    finished: "2026-10-04T12:01:00.000Z",
    outcome: {
      kind: "failure",
      code: 1,
      detail: "tests failed",
      requestId: "request-1",
      log: `${workspace}/failure.log`,
    },
    ...values,
  };
  assert(decodeCiReceipt(candidate).ok);
  return candidate;
};

const saveReceipt = async (home: string, value: CiReceipt): Promise<string> => {
  const directory = unwrap(await sessionReceiptDirectory(value.sessionId, home));
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const path = `${directory}/${value.id}.json`;
  await Deno.writeTextFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return path;
};

const json = (result: CommandResult): Record<string, unknown> => {
  assert(result.code === 0, result.stderr);
  const value: unknown = JSON.parse(result.stdout);
  assert(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
};

const message = (value: Record<string, unknown>): string => {
  assert(typeof value.systemMessage === "string");
  return value.systemMessage;
};

Deno.test("Codex hook rejects oversized event input", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-codex-" });
    try {
      const response = await runHook(workspace, home, {
        ...event("large-event", workspace, "PostToolUse"),
        tool_response: "x".repeat(1024 * 1024),
      });
      equal(response.code, 2);
      assert(response.stderr.includes("Codex hook event is too large"));
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("Codex hook returns an empty JSON object for a session without receipts", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-codex-" });
    try {
      const output = await runHook(
        workspace,
        home,
        event("empty-session", workspace, "PostToolUse"),
      );
      equal(output.code, 0);
      equal(output.stdout.trim(), "{}");
      equal(output.stderr, "");
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("Codex hook honors an explicit session override and ignores inherited Codex identifiers", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-codex-" });
    const inherited = {
      CODEX_SESSION_ID: "stale-parent-session",
      CODEX_THREAD_ID: "stale-parent-thread",
    };
    const override = { ...inherited, MCI_SESSION_ID: "explicit-session" };
    try {
      const failed = await cli(
        workspace,
        home,
        ["run", "missing.yml", "--job", "check"],
        "null",
        override,
      ).output();
      equal(failed.code, 2);
      const warning = json(
        await runHook(
          workspace,
          home,
          event("native-session", workspace, "PostToolUse"),
          override,
        ),
      );
      assert(message(warning).includes("CI did not pass"));
      assert(message(warning).includes("missing.yml"));
      equal(
        json(
          await runHook(
            workspace,
            home,
            event("native-session", workspace, "Stop", false),
            override,
          ),
        ).decision,
        "block",
      );
      equal(
        json(
          await runHook(
            workspace,
            home,
            event("native-session", workspace, "Stop", false),
            inherited,
          ),
        ),
        {},
      );
      await saveReceipt(home, receipt("native-session", workspace));
      equal(
        json(
          await runHook(
            workspace,
            home,
            event("native-session", workspace, "Stop", false),
            inherited,
          ),
        ).decision,
        "block",
      );
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("Codex PostToolUse reports failures once and reports a final transition", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-codex-" });
    const sessionId = "warning-session";
    try {
      const pending = receipt(sessionId, workspace, {
        finished: null,
        outcome: {
          kind: "pending",
          code: null,
          detail: null,
          requestId: null,
          log: null,
        },
      });
      const path = await saveReceipt(home, pending);
      const first = json(
        await runHook(workspace, home, event(sessionId, workspace, "PostToolUse")),
      );
      assert(message(first).includes("CI has no final result"));
      assert(message(first).includes(path));
      const specific = first.hookSpecificOutput;
      assert(typeof specific === "object" && specific !== null);
      const context = JSON.stringify(specific);
      assert(context.includes("Report this CI state to the user immediately"));
      assert(context.includes("wait for its final result"));
      assert(context.includes(workspace));
      assert(context.includes("ci.yml"));
      assert(context.includes(path));

      equal(
        (await runHook(workspace, home, event(sessionId, workspace, "PostToolUse")))
          .stdout.trim(),
        "{}",
      );
      const failed = receipt(sessionId, workspace, {
        id: pending.id,
        finished: "2026-10-04T12:01:00.000Z",
      });
      await Deno.writeTextFile(path, `${JSON.stringify(failed)}\n`);
      const transitioned = json(
        await runHook(workspace, home, event(sessionId, workspace, "PostToolUse")),
      );
      assert(message(transitioned).includes("CI failed"));
      assert(message(transitioned).includes("request-1"));
      assert(message(transitioned).includes(`${workspace}/failure.log`));

      const directory = unwrap(await sessionReceiptDirectory(sessionId, home));
      const state = `${directory}/.codex-notified`;
      equal((await Deno.stat(state)).mode! & 0o777, 0o600);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("Concurrent Codex hook commands emit one warning for the same receipt", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-concurrent-" });
    try {
      await saveReceipt(home, receipt("concurrent-session", workspace));
      const input = event("concurrent-session", workspace, "PostToolUse");
      const responses = (await Promise.all([
        runHook(workspace, home, input),
        runHook(workspace, home, input),
      ])).map(json);
      equal(
        responses.filter((response) => typeof response.systemMessage === "string").length,
        1,
      );
      equal(responses.filter((response) => Object.keys(response).length === 0).length, 1);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("Codex receipt resolution uses the matching job and causal start time", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-codex-" });
    try {
      const failure = receipt("resolution", workspace);
      await saveReceipt(home, failure);
      await saveReceipt(
        home,
        receipt("resolution", workspace, {
          job: "other",
          started: "2026-10-04T12:02:00.000Z",
          finished: "2026-10-04T12:03:00.000Z",
          outcome: {
            kind: "success",
            code: 0,
            detail: "passed",
            requestId: "unrelated",
            log: null,
          },
        }),
      );
      await saveReceipt(
        home,
        receipt("resolution", workspace, {
          command: "run",
          started: "2026-10-04T11:59:00.000Z",
          finished: "2026-10-04T12:02:00.000Z",
          outcome: {
            kind: "success",
            code: 0,
            detail: "overlapped",
            requestId: "earlier",
            log: null,
          },
        }),
      );
      const unresolved = json(
        await runHook(workspace, home, event("resolution", workspace, "SessionStart")),
      );
      assert(message(unresolved).includes("tests failed"));

      await saveReceipt(
        home,
        receipt("resolution", workspace, {
          command: "run",
          started: "2026-10-04T12:01:00.000Z",
          finished: "2026-10-04T12:02:00.000Z",
          outcome: {
            kind: "success",
            code: 0,
            detail: "passed",
            requestId: "matching",
            log: null,
          },
        }),
      );
      equal(
        (await runHook(workspace, home, event("resolution", workspace, "SessionStart")))
          .stdout.trim(),
        "{}",
      );

      await saveReceipt(home, receipt("another-session", workspace));
      equal(
        (await runHook(workspace, home, event("isolated", workspace, "SessionStart")))
          .stdout.trim(),
        "{}",
      );
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("Codex turn hooks retain unresolved failures and bound Stop continuation", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-codex-" });
    const sessionId = "stop-session";
    try {
      await saveReceipt(home, receipt(sessionId, workspace));
      const prompt = json(
        await runHook(
          workspace,
          home,
          event(sessionId, workspace, "UserPromptSubmit"),
        ),
      );
      assert(message(prompt).includes("CI failed"));

      const stop = json(
        await runHook(workspace, home, event(sessionId, workspace, "Stop", false)),
      );
      equal(stop.decision, "block");
      assert(
        typeof stop.reason === "string" &&
          stop.reason.includes("Then rerun matching checks"),
      );
      assert(typeof stop.reason === "string" && stop.reason.includes("failure.log"));

      const active = json(
        await runHook(workspace, home, event(sessionId, workspace, "Stop", true)),
      );
      equal(active.continue, false);
      assert(
        typeof active.stopReason === "string" &&
          active.stopReason.includes("Then rerun matching checks"),
      );
      const resumed = json(
        await runHook(workspace, home, event(sessionId, workspace, "SessionStart")),
      );
      assert(message(resumed).includes("tests failed"));
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("Codex hook fails closed when receipt storage is corrupt", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-codex-" });
    const sessionId = "corrupt-session";
    try {
      const directory = unwrap(await sessionReceiptDirectory(sessionId, home));
      await Deno.mkdir(directory, { recursive: true });
      await Deno.writeTextFile(`${directory}/${crypto.randomUUID()}.json`, "{");
      const response = json(
        await runHook(workspace, home, event(sessionId, workspace, "SessionStart")),
      );
      assert(message(response).includes("CI state is unresolved"));
      assert(message(response).includes("Receipt storage error"));
      assert(message(response).includes("Repair receipt storage"));
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("Codex hook rejects a linked notification lock", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-codex-" });
    const sessionId = "linked-lock-session";
    try {
      await saveReceipt(home, receipt(sessionId, workspace));
      const directory = unwrap(await sessionReceiptDirectory(sessionId, home));
      const target = `${workspace}/outside-lock`;
      await Deno.writeTextFile(target, "unchanged\n");
      await Deno.symlink(target, `${directory}/.codex-notified.lock`);
      const response = json(
        await runHook(workspace, home, event(sessionId, workspace, "PostToolUse")),
      );
      assert(message(response).includes("must be a real file"));
      equal(await Deno.readTextFile(target), "unchanged\n");
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

Deno.test("Codex installer merges hooks, migrates the legacy hook, and is idempotent", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-codex-" });
    const repository = `${workspace}/repository's path`;
    try {
      await Deno.mkdir(`${repository}/.codex/hooks`, { recursive: true });
      const legacy = `${
        shellQuote(`${repository}/.codex/hooks/ci-summary.sh`)
      } 2>/dev/null || true`;
      const foreign = {
        type: "command",
        command: "printf foreign",
        statusMessage: "foreign",
      };
      const initial = {
        project: "kept",
        hooks: {
          ForeignEvent: [{ hooks: [foreign] }],
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: legacy, timeout: 10 }],
            },
            { matcher: "Write", hooks: [foreign] },
            {
              hooks: [{
                type: "command",
                command:
                  "'/old/deno' 'run' '--quiet' '--config' '/old/deno.json' '/old/src/main.ts' 'codex' 'hook'",
                statusMessage: "mci: check unresolved CI receipts",
              }],
            },
          ],
        },
      };
      await Deno.writeTextFile(
        `${repository}/.codex/hooks.json`,
        `${JSON.stringify(initial, null, 2)}\n`,
      );
      const first = await cli(workspace, home, ["codex", "install", repository]).output();
      equal(first.code, 0);
      assert(text(first.stdout).includes("Review and trust"));
      assert(text(first.stdout).includes("/hooks"));
      const installedText = await Deno.readTextFile(`${repository}/.codex/hooks.json`);
      const installed: unknown = JSON.parse(installedText);
      assert(typeof installed === "object" && installed !== null);
      assert(JSON.stringify(installed).includes("ForeignEvent"));
      assert(JSON.stringify(installed).includes("printf foreign"));
      assert(!JSON.stringify(installed).includes("ci-summary.sh"));
      assert(!JSON.stringify(installed).includes("/old/src/main.ts"));
      const expectedCommand = [
        Deno.execPath(),
        ...cliSourceArgs(["codex", "hook"]),
      ].map(shellQuote).join(" ");
      assert(JSON.stringify(installed).includes(expectedCommand));
      equal(
        JSON.stringify(installed).match(/mci: check unresolved CI receipts/g)?.length,
        4,
      );

      const generated = new Deno.Command("/bin/zsh", {
        args: ["-c", expectedCommand],
        cwd: repository,
        env: { MCI_HOME: home },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const input = generated.stdin.getWriter();
      await input.write(new TextEncoder().encode(JSON.stringify(
        event("installed-command", repository, "PostToolUse"),
      )));
      await input.close();
      const generatedOutput = await generated.output();
      equal(generatedOutput.code, 0);
      equal(text(generatedOutput.stdout).trim(), "{}");
      equal(text(generatedOutput.stderr), "");

      const second = await cli(workspace, home, ["codex", "install", repository])
        .output();
      equal(second.code, 0);
      equal(await Deno.readTextFile(`${repository}/.codex/hooks.json`), installedText);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));

Deno.test("Codex installer rejects malformed and linked hook configuration", () =>
  inWorkspace(async (workspace) => {
    const home = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-codex-" });
    const malformed = `${workspace}/malformed`;
    const linked = `${workspace}/linked`;
    try {
      await Deno.mkdir(`${malformed}/.codex`, { recursive: true });
      await Deno.writeTextFile(`${malformed}/.codex/hooks.json`, "{");
      const invalid = await cli(workspace, home, ["codex", "install", malformed])
        .output();
      equal(invalid.code, 1);
      equal(await Deno.readTextFile(`${malformed}/.codex/hooks.json`), "{");

      await Deno.mkdir(`${linked}/.codex`, { recursive: true });
      const target = `${workspace}/outside.json`;
      await Deno.writeTextFile(target, "{}\n");
      await Deno.symlink(target, `${linked}/.codex/hooks.json`);
      const rejected = await cli(workspace, home, ["codex", "install", linked]).output();
      equal(rejected.code, 1);
      equal(await Deno.readTextFile(target), "{}\n");
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  }));
