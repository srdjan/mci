// @light-fp adapter
import {
  type CiReceipt,
  readSessionReceipts,
  sessionReceiptDirectory,
} from "./ci-receipt.ts";
import { nativeHookCapabilities } from "./hooks.ts";
import { attempt, err, ok, type Result } from "./result.ts";
import { cliSelfArgs } from "./runtime.ts";

type Fields = Readonly<Record<string, unknown>>;
type EventName = "PostToolUse" | "SessionStart" | "UserPromptSubmit" | "Stop";

const installedEvents = ["SessionStart", "UserPromptSubmit", "Stop"] as const;
const managedStatus = "mci: check unresolved CI receipts";

export type HookEvent = {
  readonly sessionId: string;
  readonly name: EventName;
  readonly stopHookActive: boolean;
};

// PostToolUse is accepted so that an old handler gets `{}` and no error.
const eventNames: readonly unknown[] = ["PostToolUse", ...installedEvents];

const object = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeEvent = (value: unknown): Result<HookEvent> => {
  if (
    !object(value) || typeof value.session_id !== "string" || value.session_id === "" ||
    !eventNames.includes(value.hook_event_name) ||
    (value.hook_event_name === "Stop" && typeof value.stop_hook_active !== "boolean")
  ) return err("Invalid Codex hook event");
  return ok({
    sessionId: value.session_id,
    name: value.hook_event_name as EventName,
    stopHookActive: value.stop_hook_active === true,
  });
};

const failureKey = (receipt: CiReceipt): string =>
  `${receipt.workspace}\0${receipt.workflow}\0${receipt.job}`;

// A validation error can name a mistyped job or workflow that no later run can repeat.
const clears = (failure: CiReceipt, success: CiReceipt): boolean =>
  success.outcome.kind === "success" &&
  success.started >= (failure.finished ?? failure.started) &&
  (failureKey(success) === failureKey(failure) ||
    (failure.outcome.kind === "error" && failure.outcome.code === 2 &&
      success.workspace === failure.workspace));

const unresolvedReceipts = (receipts: readonly CiReceipt[]): readonly CiReceipt[] =>
  receipts.filter((receipt) =>
    receipt.outcome.kind !== "success" &&
    !receipts.some((candidate) => clears(receipt, candidate))
  );

const describe = (receipt: CiReceipt, directory: string): string => {
  const { kind, detail, requestId, log } = receipt.outcome;
  const lead = kind === "failure"
    ? "CI failed"
    : kind === "pending"
    ? "CI has no final result"
    : "CI did not pass";
  return `${lead} for job ${receipt.job} in ${receipt.workspace}. Workflow: ${receipt.workflow}. Detail: ${
    detail ?? kind
  }. Request: ${requestId ?? "unavailable"}. Evidence: ${
    log ?? `${directory}/${receipt.id}.json`
  }.`;
};

export const hookResponse = async (
  event: HookEvent,
  home?: string,
  warn?: (text: string) => void,
): Promise<Fields> => {
  if (event.name === "PostToolUse") return {};
  const override = Deno.env.get("MCI_SESSION_ID");
  const sessionId = override ? override : event.sessionId;
  const report = warn ?? console.error;
  const directory = await sessionReceiptDirectory(sessionId, home);
  if (!directory.ok) {
    report(directory.error);
    return {};
  }
  const read = await readSessionReceipts(sessionId, home, warn);
  if (!read.ok) {
    report(read.error);
    return {};
  }
  const unresolved = unresolvedReceipts(read.value);
  if (unresolved.length === 0) return {};
  const systemMessage = unresolved.map((receipt) => describe(receipt, directory.value))
    .join("\n");
  if (event.name === "Stop") {
    const reason =
      `${systemMessage}\nReport this CI state to the user. Wait for active invocations to finish. If CI fails, fix the issue. Then rerun matching checks before treating the task as complete. If repair has a genuine blocker, report it.`;
    return event.stopHookActive
      ? { systemMessage, continue: false, stopReason: reason }
      : { systemMessage, decision: "block", reason };
  }
  return {
    systemMessage,
    hookSpecificOutput: {
      hookEventName: event.name,
      additionalContext:
        `${systemMessage}\nUnresolved CI state remains. Report it to the user. Wait for active invocations to finish. If CI fails, fix the issue. Then rerun the matching workflow and job.`,
    },
  };
};

const readEvent = (): Promise<Result<unknown>> =>
  attempt(async (): Promise<unknown> => {
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    for await (const chunk of Deno.stdin.readable) {
      size += chunk.byteLength;
      if (size > 1024 * 1024) throw new Error("Codex hook event is too large");
      text += decoder.decode(chunk, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  });

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

// A source run names the Deno executable. A compiled binary names the Homebrew `mci`.
export const nativeHookCommand = async (): Promise<Result<string>> => {
  if (!Deno.build.standalone) {
    return ok(
      [Deno.execPath(), ...cliSelfArgs(["codex", "hook"])].map(shellQuote).join(" "),
    );
  }
  const prefix = await nativeHookCapabilities.brewPrefix();
  return prefix.ok
    ? ok([`${prefix.value}/bin/mci`, "codex", "hook"].map(shellQuote).join(" "))
    : prefix;
};

const managed = (handler: unknown): boolean =>
  object(handler) && handler.type === "command" &&
  handler.statusMessage === managedStatus;

// Keeps foreign handlers, drops every managed handler, and adds one per installed event.
const mergeHooks = (hooks: Fields, command: string): Result<Fields> => {
  const merged: Record<string, unknown[]> = {};
  for (const [name, groups] of Object.entries(hooks)) {
    if (
      !Array.isArray(groups) ||
      !groups.every((group) => object(group) && Array.isArray(group.hooks))
    ) return err(`Codex hook group ${name} is malformed`);
    const kept = groups
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter((h: unknown) => !managed(h)),
      }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) merged[name] = kept;
  }
  const hook = { type: "command", command, timeout: 10, statusMessage: managedStatus };
  for (const name of installedEvents) {
    merged[name] = [...(merged[name] ?? []), { hooks: [hook] }];
  }
  return ok(merged);
};

export const installCodexHooks = async (
  repository: string,
  hookCommand: () => Promise<Result<string>> = nativeHookCommand,
): Promise<Result<string>> => {
  const root = await attempt(() => Deno.realPath(repository));
  if (!root.ok) return root;
  const command = await hookCommand();
  if (!command.ok) return command;
  const directory = `${root.value}/.codex`;
  const path = `${directory}/hooks.json`;
  return await attempt(async () => {
    if (!(await Deno.stat(root.value)).isDirectory) {
      throw new Error("The repository must be a directory");
    }
    await Deno.mkdir(directory, { recursive: true, mode: 0o755 });
    const info = await Deno.lstat(path).catch(() => null);
    if (info !== null && (!info.isFile || info.isSymlink)) {
      throw new Error(`${path} must be a real file`);
    }
    const config: unknown = info === null
      ? {}
      : JSON.parse(await Deno.readTextFile(path));
    if (!object(config) || (config.hooks !== undefined && !object(config.hooks))) {
      throw new Error(`${path} must contain an object with an object of hooks`);
    }
    const merged = mergeHooks(config.hooks ?? {}, command.value);
    if (!merged.ok) throw new Error(merged.error);
    const temporary = await Deno.makeTempFile({ dir: directory, prefix: ".hooks-" });
    try {
      await Deno.writeTextFile(
        temporary,
        `${JSON.stringify({ ...config, hooks: merged.value }, null, 2)}\n`,
      );
      await Deno.chmod(temporary, info?.mode == null ? 0o644 : info.mode & 0o7777);
      await Deno.rename(temporary, path);
    } catch (error) {
      await Deno.remove(temporary).catch(() => undefined);
      throw error;
    }
    return path;
  });
};

export const codexCommand = async (
  args: readonly string[],
): Promise<number | null> => {
  if (args[0] !== "codex") return null;
  if (args.length === 2 && args[1] === "hook") {
    const input = await readEvent();
    const event = input.ok ? decodeEvent(input.value) : input;
    if (!event.ok) {
      console.error(event.error);
      return 2;
    }
    console.log(
      JSON.stringify(await hookResponse(event.value, Deno.env.get("MCI_HOME"))),
    );
    return 0;
  }
  if (args.length === 3 && args[1] === "install" && args[2]) {
    const installed = await installCodexHooks(args[2]);
    if (!installed.ok) {
      console.error(installed.error);
      return 1;
    }
    console.log(`Installed Codex hooks in ${installed.value}.`);
    console.log("Review and trust the hook definitions in Codex with /hooks.");
    console.log("Reload the Codex session if the hooks do not appear.");
    return 0;
  }
  console.error("Usage: mci codex hook | mci codex install <repository>");
  return 2;
};
