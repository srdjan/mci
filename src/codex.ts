// @light-fp adapter
import {
  type CiReceipt,
  readSessionReceipts,
  sessionReceiptDirectory,
} from "./ci-receipt.ts";
import { nativeHookCapabilities } from "./hooks.ts";
import { attempt, err, message, ok, type Result } from "./result.ts";
import { cliSelfArgs } from "./runtime.ts";

type JsonObject = Readonly<Record<string, unknown>>;
type HookEventName = "PostToolUse" | "SessionStart" | "UserPromptSubmit" | "Stop";

type HookEvent = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly name: HookEventName;
  readonly stopHookActive: boolean;
};

type Unresolved =
  | { readonly kind: "receipt"; readonly receipt: CiReceipt; readonly path: string }
  | { readonly kind: "storage"; readonly detail: string };

const hookEvents: readonly HookEventName[] = [
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
];
const notificationFile = ".codex-notified";
const notificationLock = ".codex-notified.lock";
const managedStatus = "mci: check unresolved CI receipts";

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");

const stateEntry = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const decodeEvent = (value: unknown): Result<HookEvent> => {
  if (
    !object(value) || !nonempty(value.session_id) || !nonempty(value.cwd) ||
    typeof value.hook_event_name !== "string" ||
    !hookEvents.includes(value.hook_event_name as HookEventName)
  ) return err("Invalid Codex hook event");
  if (
    value.hook_event_name === "Stop" &&
    typeof value.stop_hook_active !== "boolean"
  ) return err("Invalid Codex Stop hook event");
  return ok({
    sessionId: value.session_id,
    cwd: value.cwd,
    name: value.hook_event_name as HookEventName,
    stopHookActive: value.hook_event_name === "Stop" && value.stop_hook_active === true,
  });
};

const receiptKey = (receipt: CiReceipt): string =>
  `${receipt.workspace}\0${receipt.workflow}\0${receipt.job}`;

// A validation error can name a mistyped job or workflow that no later run can repeat.
const validationError = (receipt: CiReceipt): boolean =>
  receipt.outcome.kind === "error" && receipt.outcome.code === 2;

const clears = (failure: CiReceipt, success: CiReceipt): boolean => {
  if (success.outcome.kind !== "success" || success.id === failure.id) return false;
  if (success.started < (failure.finished ?? failure.started)) return false;
  return receiptKey(success) === receiptKey(failure) ||
    (validationError(failure) && success.workspace === failure.workspace);
};

const unresolvedReceipts = (receipts: readonly CiReceipt[]): readonly CiReceipt[] =>
  receipts.filter((receipt) =>
    receipt.outcome.kind !== "success" &&
    !receipts.some((candidate) => clears(receipt, candidate))
  );

const readUnresolved = async (
  sessionId: string,
  home?: string,
): Promise<readonly Unresolved[]> => {
  const read = await readSessionReceipts(sessionId, home);
  if (!read.ok) return [{ kind: "storage", detail: read.error }];
  const directory = await sessionReceiptDirectory(sessionId, home);
  if (!directory.ok) return [{ kind: "storage", detail: directory.error }];
  return unresolvedReceipts(read.value).map((receipt) => ({
    kind: "receipt",
    receipt,
    path: `${directory.value}/${receipt.id}.json`,
  }));
};

const notificationKey = (receipt: CiReceipt): string =>
  `${receipt.id}\0${receipt.outcome.kind}\0${receipt.finished ?? "pending"}`;

const readNotificationState = async (path: string): Promise<Result<Set<string>>> => {
  const found = await metadata(path);
  if (!found.ok) return found;
  if (found.value === null) return ok(new Set());
  if (!found.value.isFile || found.value.isSymlink) {
    return err(`${path} must be a real file`);
  }
  const read = await attempt(async (): Promise<unknown> =>
    JSON.parse(await Deno.readTextFile(path))
  );
  if (!read.ok || !Array.isArray(read.value) || !read.value.every(stateEntry)) {
    return err(`${path} contains invalid notification state`);
  }
  return ok(new Set(read.value));
};

const writeAtomic = async (
  path: string,
  content: string,
  mode: number,
  beforeRename?: () => Promise<Result<void>>,
): Promise<Result<void>> => {
  const directory = path.slice(0, path.lastIndexOf("/"));
  const temporary = await attempt(() =>
    Deno.makeTempFile({ dir: directory, prefix: ".codex-state-" })
  );
  if (!temporary.ok) return temporary;
  const written = await attempt(async (): Promise<void> => {
    await Deno.writeTextFile(temporary.value, content);
    await Deno.chmod(temporary.value, mode);
  });
  if (!written.ok) {
    await attempt(() => Deno.remove(temporary.value));
    return written;
  }
  if (beforeRename !== undefined) {
    const checked = await beforeRename();
    if (!checked.ok) {
      await attempt(() => Deno.remove(temporary.value));
      return checked;
    }
  }
  const renamed = await attempt(() => Deno.rename(temporary.value, path));
  if (!renamed.ok) await attempt(() => Deno.remove(temporary.value));
  return renamed;
};

const openNotificationLock = async (path: string): Promise<Result<Deno.FsFile>> => {
  const before = await metadata(path);
  if (!before.ok) return before;
  if (before.value !== null && (!before.value.isFile || before.value.isSymlink)) {
    return err(`${path} must be a real file`);
  }
  const opened = await attempt(() =>
    Deno.open(path, { create: true, read: true, write: true, mode: 0o600 })
  );
  if (!opened.ok) return opened;
  const checked = await attempt(() =>
    Promise.all([
      opened.value.stat(),
      Deno.lstat(path),
    ])
  );
  if (!checked.ok) {
    opened.value.close();
    return checked;
  }
  const [handle, target] = checked.value;
  if (
    !target.isFile || target.isSymlink || handle.dev !== target.dev ||
    handle.ino !== target.ino
  ) {
    opened.value.close();
    return err(`${path} changed while opening the notification lock`);
  }
  if (handle.mode === null || (handle.mode & 0o777) !== 0o600) {
    opened.value.close();
    return err(`${path} must have mode 0600`);
  }
  return opened;
};

const selectNewNotifications = async (
  sessionId: string,
  unresolved: readonly Unresolved[],
  home?: string,
): Promise<Result<readonly Unresolved[]>> => {
  const receipts = unresolved.filter(
    (entry): entry is Extract<Unresolved, { readonly kind: "receipt" }> =>
      entry.kind === "receipt",
  );
  if (receipts.length === 0) return ok(unresolved);
  const directory = await sessionReceiptDirectory(sessionId, home);
  if (!directory.ok) return directory;
  const lockPath = `${directory.value}/${notificationLock}`;
  const opened = await openNotificationLock(lockPath);
  if (!opened.ok) return err(`Notification lock failed: ${opened.error}`);
  try {
    const locked = await attempt(() => opened.value.lock(true));
    if (!locked.ok) return err(`Notification lock failed: ${locked.error}`);
    const path = `${directory.value}/${notificationFile}`;
    const prior = await readNotificationState(path);
    if (!prior.ok) return prior;
    const selected = receipts.filter(
      (entry) => !prior.value.has(notificationKey(entry.receipt)),
    );
    if (selected.length === 0) return ok([]);
    const next = new Set(prior.value);
    for (const entry of selected) next.add(notificationKey(entry.receipt));
    const written = await writeAtomic(
      path,
      `${JSON.stringify([...next].sort())}\n`,
      0o600,
    );
    return written.ok ? ok(selected) : written;
  } finally {
    await attempt(() => opened.value.unlock());
    opened.value.close();
  }
};

const describe = (entry: Unresolved, sessionId: string): string => {
  if (entry.kind === "storage") {
    return `CI state is unresolved for session ${sessionId}. Receipt storage error: ${entry.detail}. Repair receipt storage before treating CI as passed.`;
  }
  const receipt = entry.receipt;
  const lead = receipt.outcome.kind === "failure"
    ? "CI failed"
    : receipt.outcome.kind === "pending"
    ? "CI has no final result"
    : "CI did not pass";
  const detail = receipt.outcome.detail ?? receipt.outcome.kind;
  const request = receipt.outcome.requestId ?? "unavailable";
  const evidence = receipt.outcome.log ?? entry.path;
  return `${lead} for job ${receipt.job} in ${receipt.workspace}. Workflow: ${receipt.workflow}. Detail: ${detail}. Request: ${request}. Evidence: ${evidence}.`;
};

const hookResponse = async (
  event: HookEvent,
  home?: string,
): Promise<JsonObject> => {
  const override = Deno.env.get("MCI_SESSION_ID");
  const sessionId = override !== undefined && override.length > 0
    ? override
    : event.sessionId;
  let unresolved = await readUnresolved(sessionId, home);
  if (unresolved.length === 0) return {};
  if (event.name === "PostToolUse") {
    const selected = await selectNewNotifications(sessionId, unresolved, home);
    if (!selected.ok) {
      unresolved = [
        ...unresolved,
        { kind: "storage", detail: selected.error },
      ];
    } else {
      unresolved = selected.value;
    }
    if (unresolved.length === 0) return {};
  }
  const systemMessage = unresolved.map((entry) => describe(entry, sessionId)).join(
    "\n",
  );
  if (event.name === "PostToolUse") {
    return {
      systemMessage,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `${systemMessage}\nReport this CI state to the user immediately. If an invocation is still running, wait for its final result. If CI fails, fix the issue. Then rerun the same workflow and job before continuing other work. If completion is unknown, diagnose it before rerunning.`,
      },
    };
  }
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

const readStdin = async (): Promise<Result<unknown>> => {
  const reader = Deno.stdin.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await attempt(() => reader.read());
      if (!chunk.ok) return chunk;
      if (chunk.value.done) break;
      size += chunk.value.value.byteLength;
      if (size > 1024 * 1024) return err("Codex hook event is too large");
      chunks.push(chunk.value.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = await attempt(() => JSON.parse(new TextDecoder().decode(bytes)));
  return parsed.ok ? ok(parsed.value) : err(`Invalid Codex hook JSON: ${parsed.error}`);
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const hookCommand = async (): Promise<Result<string>> => {
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

const metadata = async (path: string): Promise<Result<Deno.FileInfo | null>> => {
  try {
    return ok(await Deno.lstat(path));
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? ok(null) : err(message(error));
  }
};

export type CodexConfigFileIdentity = {
  readonly device: number | null;
  readonly inode: number | null;
  readonly size: number;
  readonly modified: number | null;
  readonly mode: number | null;
};

export type CodexConfigSnapshot =
  | { readonly kind: "absent" }
  | {
    readonly kind: "file";
    readonly bytes: Uint8Array;
    readonly identity: CodexConfigFileIdentity;
  };

export type CodexConfigRead = {
  readonly config: JsonObject;
  readonly mode: number | null;
  readonly snapshot: CodexConfigSnapshot;
};

export type CodexConfigReplacement = {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
  readonly snapshot: CodexConfigSnapshot;
};

export type CodexConfigOperations = {
  readonly read: (path: string) => Promise<Result<CodexConfigRead>>;
  readonly replace: (replacement: CodexConfigReplacement) => Promise<Result<void>>;
};

const fileIdentity = (info: Deno.FileInfo): CodexConfigFileIdentity => ({
  device: info.dev,
  inode: info.ino,
  size: info.size,
  modified: info.mtime?.getTime() ?? null,
  mode: info.mode === null ? null : info.mode & 0o7777,
});

const sameFileIdentity = (
  left: CodexConfigFileIdentity,
  right: CodexConfigFileIdentity,
): boolean =>
  left.device === right.device && left.inode === right.inode &&
  left.size === right.size && left.modified === right.modified &&
  left.mode === right.mode;

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((value, index) => value === right[index]);

const changedConfig = (path: string): Result<void> =>
  err(`${path} changed before Codex hook installation could replace it`);

const inspectionFailed = (path: string, detail: string): Result<void> =>
  err(`Could not inspect ${path} before replacement: ${detail}`);

const configUnchanged = async (
  path: string,
  expected: CodexConfigSnapshot,
): Promise<Result<void>> => {
  const found = await metadata(path);
  if (!found.ok) return inspectionFailed(path, found.error);
  if (expected.kind === "absent") {
    return found.value === null ? ok(undefined) : changedConfig(path);
  }
  if (
    found.value === null || !found.value.isFile || found.value.isSymlink
  ) return changedConfig(path);
  const before = fileIdentity(found.value);
  const bytes = await attempt(() => Deno.readFile(path));
  if (!bytes.ok) return inspectionFailed(path, bytes.error);
  const after = await metadata(path);
  if (!after.ok) return inspectionFailed(path, after.error);
  if (after.value === null || !after.value.isFile || after.value.isSymlink) {
    return changedConfig(path);
  }
  const current = fileIdentity(after.value);
  if (
    !sameFileIdentity(before, current) ||
    !sameFileIdentity(expected.identity, current) ||
    !sameBytes(expected.bytes, bytes.value)
  ) return changedConfig(path);
  return ok(undefined);
};

const readConfig = async (path: string): Promise<Result<CodexConfigRead>> => {
  const found = await metadata(path);
  if (!found.ok) return found;
  if (found.value === null) {
    return ok({ config: {}, mode: null, snapshot: { kind: "absent" } });
  }
  if (!found.value.isFile || found.value.isSymlink) {
    return err(`${path} must be a real file`);
  }
  const bytes = await attempt(() => Deno.readFile(path));
  if (!bytes.ok) return bytes;
  const after = await metadata(path);
  if (!after.ok) return after;
  if (after.value === null || !after.value.isFile || after.value.isSymlink) {
    return err(`${path} changed while its configuration was read`);
  }
  const identity = fileIdentity(found.value);
  if (!sameFileIdentity(identity, fileIdentity(after.value))) {
    return err(`${path} changed while its configuration was read`);
  }
  const parsed = await attempt((): unknown =>
    JSON.parse(new TextDecoder().decode(bytes.value))
  );
  if (!parsed.ok) return err(`${path} is not valid JSON: ${parsed.error}`);
  return object(parsed.value)
    ? ok({
      config: parsed.value,
      mode: identity.mode,
      snapshot: {
        kind: "file",
        bytes: bytes.value,
        identity,
      },
    })
    : err(`${path} must contain an object`);
};

const replaceConfig = (
  replacement: CodexConfigReplacement,
): Promise<Result<void>> =>
  writeAtomic(
    replacement.path,
    replacement.content,
    replacement.mode,
    () => configUnchanged(replacement.path, replacement.snapshot),
  );

export const nativeCodexConfigOperations: CodexConfigOperations = {
  read: readConfig,
  replace: replaceConfig,
};

const decodeShellWords = (command: string): readonly string[] | null => {
  const words: string[] = [];
  let offset = 0;
  while (offset < command.length) {
    if (command[offset] !== "'") return null;
    offset += 1;
    let word = "";
    while (true) {
      const close = command.indexOf("'", offset);
      if (close < 0) return null;
      word += command.slice(offset, close);
      offset = close + 1;
      if (command.slice(offset, offset + 4) === `"'"'`) {
        word += "'";
        offset += 4;
        continue;
      }
      break;
    }
    words.push(word);
    if (offset === command.length) return words;
    if (command[offset] !== " ") return null;
    offset += 1;
  }
  return words;
};

const ownedHookCommand = (command: unknown): boolean => {
  if (typeof command !== "string") return false;
  const words = decodeShellWords(command);
  if (words === null || words.at(-2) !== "codex" || words.at(-1) !== "hook") {
    return false;
  }
  if (words.length === 3) return words[0]?.endsWith("/bin/mci") === true;
  return words.includes("run") && words.at(-3)?.endsWith("/src/main.ts") === true;
};

const managedHandler = (value: unknown): boolean =>
  object(value) && value.type === "command" && value.statusMessage === managedStatus &&
  ownedHookCommand(value.command);

const mergeEvent = (
  value: unknown,
  name: HookEventName,
  command: string,
): Result<readonly unknown[]> => {
  if (value !== undefined && !Array.isArray(value)) {
    return err(`Codex hook group ${name} must be an array`);
  }
  const groups: unknown[] = [];
  for (const group of value ?? []) {
    if (!object(group) || !Array.isArray(group.hooks)) {
      return err(`Codex hook group ${name} is malformed`);
    }
    const hooks = group.hooks.filter((handler) => !managedHandler(handler));
    if (hooks.length > 0) groups.push({ ...group, hooks });
  }
  const handler = {
    type: "command",
    command,
    timeout: 10,
    statusMessage: managedStatus,
  };
  groups.push(
    name === "PostToolUse" ? { matcher: "*", hooks: [handler] } : { hooks: [handler] },
  );
  return ok(groups);
};

export const installCodexHooksWith = async (
  repository: string,
  configuration: CodexConfigOperations,
): Promise<Result<string>> => {
  const supplied = await metadata(repository);
  if (!supplied.ok) return supplied;
  if (supplied.value === null) return err("The repository must be a directory");
  const root = await attempt(() => Deno.realPath(repository));
  if (!root.ok) return root;
  const resolved = await metadata(root.value);
  if (!resolved.ok) return resolved;
  if (resolved.value === null || !resolved.value.isDirectory) {
    return err("The repository must be a directory");
  }
  const command = await hookCommand();
  if (!command.ok) return command;
  const directory = `${root.value}/.codex`;
  const directoryState = await metadata(directory);
  if (!directoryState.ok) return directoryState;
  if (directoryState.value === null) {
    const made = await attempt(() => Deno.mkdir(directory, { mode: 0o755 }));
    if (!made.ok) return made;
  } else if (!directoryState.value.isDirectory || directoryState.value.isSymlink) {
    return err(`${directory} must be a real directory`);
  }
  const path = `${directory}/hooks.json`;
  const read = await configuration.read(path);
  if (!read.ok) return read;
  const config = read.value.config;
  if (config.hooks !== undefined && !object(config.hooks)) {
    return err(`${path} has a malformed hooks object`);
  }
  const hooks = object(config.hooks) ? config.hooks : {};
  for (const [name, groups] of Object.entries(hooks)) {
    if (
      !Array.isArray(groups) ||
      !groups.every((group) =>
        object(group) && Array.isArray(group.hooks) && group.hooks.every(object)
      )
    ) return err(`Codex hook group ${name} is malformed`);
  }
  const merged: Record<string, unknown> = { ...hooks };
  for (const name of hookEvents) {
    const event = mergeEvent(hooks[name], name, command.value);
    if (!event.ok) return event;
    merged[name] = event.value;
  }
  const written = await configuration.replace({
    path,
    content: `${JSON.stringify({ ...config, hooks: merged }, null, 2)}\n`,
    mode: read.value.mode ?? 0o644,
    snapshot: read.value.snapshot,
  });
  return written.ok ? ok(path) : written;
};

export const codexCommand = async (
  args: readonly string[],
): Promise<number | null> => {
  if (args[0] !== "codex") return null;
  if (args.length === 2 && args[1] === "hook") {
    const input = await readStdin();
    if (!input.ok) {
      console.error(input.error);
      return 2;
    }
    const event = decodeEvent(input.value);
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
    const installed = await installCodexHooksWith(
      args[2],
      nativeCodexConfigOperations,
    );
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
