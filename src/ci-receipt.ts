// @light-fp adapter
import { serviceDirectory } from "./paths.ts";
import type { TerminalKind } from "./protocol.ts";
import { attempt, err, message, ok, type Result } from "./result.ts";

export type CiCommand = "ci" | "run";

export type CiReceiptOutcome = {
  readonly kind: "pending" | "error" | "unknown" | TerminalKind;
  readonly code: number | null;
  readonly detail: string | null;
  readonly requestId: string | null;
  readonly log: string | null;
};

export type CiReceipt = {
  readonly version: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly workflow: string;
  readonly job: string;
  readonly command: CiCommand;
  readonly started: string;
  readonly finished: string | null;
  readonly outcome: CiReceiptOutcome;
};

type Fields = Readonly<Record<string, unknown>>;

const object = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const time = (value: unknown): value is string =>
  text(value) && Number.isFinite(Date.parse(value));
const kinds: readonly unknown[] = [
  "pending",
  "error",
  "unknown",
  "success",
  "failure",
  "timeout",
  "cancelled",
  "interrupted",
];

// Checks the version 1 shape. Receipt files stay readable across releases.
export const decodeCiReceipt = (value: unknown): Result<CiReceipt> => {
  if (!object(value) || !object(value.outcome)) return err("Invalid CI receipt");
  const { kind, code, detail, requestId, log } = value.outcome;
  const valid = value.version === 1 && text(value.id) && text(value.sessionId) &&
    text(value.workspace) && text(value.workflow) && text(value.job) &&
    (value.command === "ci" || value.command === "run") && time(value.started) &&
    (value.finished === null) === (kind === "pending") &&
    (value.finished === null || time(value.finished)) &&
    kinds.includes(kind) &&
    (kind === "pending" ? code === null : Number.isSafeInteger(code)) &&
    [detail, requestId, log].every((field) => field === null || text(field));
  return valid ? ok(value as CiReceipt) : err("Invalid CI receipt");
};

export const sessionReceiptId = (): string | null => {
  for (const name of ["MCI_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID"]) {
    const value = Deno.env.get(name);
    if (value !== undefined && value.length > 0) return value;
  }
  return null;
};

export const sessionReceiptDirectory = async (
  sessionId: string,
  home?: string,
): Promise<Result<string>> => {
  const service = serviceDirectory(home);
  if (!service.ok) return service;
  const digest = await attempt(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId))
  );
  if (!digest.ok) return digest;
  const hash = Array.from(new Uint8Array(digest.value))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return ok(`${service.value}/sessions/${hash}`);
};

const writeReceipt = async (receipt: CiReceipt, home?: string): Promise<Result<void>> => {
  const directory = await sessionReceiptDirectory(receipt.sessionId, home);
  if (!directory.ok) return directory;
  return await attempt(async () => {
    await Deno.mkdir(directory.value, { recursive: true, mode: 0o700 });
    const temporary = await Deno.makeTempFile({
      dir: directory.value,
      prefix: ".receipt-",
    });
    try {
      await Deno.writeTextFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
      await Deno.rename(temporary, `${directory.value}/${receipt.id}.json`);
    } catch (error) {
      await Deno.remove(temporary).catch(() => undefined);
      throw error;
    }
  });
};

// A path that cannot resolve (missing file, loop) keeps its raw spelling.
const realOrRaw = (path: string): Promise<string> =>
  Deno.realPath(path).catch(() => path);

export const beginReceipt = async (
  input: Pick<CiReceipt, "workspace" | "workflow" | "job" | "command"> & {
    readonly home?: string;
  },
): Promise<Result<CiReceipt | null>> => {
  const sessionId = sessionReceiptId();
  if (sessionId === null) return ok(null);
  const workspace = await realOrRaw(input.workspace);
  const workflow = input.workflow.startsWith("/")
    ? input.workflow
    : `${workspace}/${input.workflow}`;
  const receipt: CiReceipt = {
    version: 1,
    id: crypto.randomUUID(),
    sessionId,
    workspace,
    workflow: await realOrRaw(workflow),
    job: input.job,
    command: input.command,
    started: new Date().toISOString(),
    finished: null,
    outcome: { kind: "pending", code: null, detail: null, requestId: null, log: null },
  };
  const written = await writeReceipt(receipt, input.home);
  return written.ok ? ok(receipt) : written;
};

export const finishReceipt = async (
  receipt: CiReceipt | null,
  outcome: CiReceiptOutcome,
  home?: string,
): Promise<Result<void>> => {
  if (receipt === null) return ok(undefined);
  const now = new Date().toISOString();
  const finished = now < receipt.started ? receipt.started : now;
  return await writeReceipt({ ...receipt, finished, outcome }, home);
};

// Entries that do not end in `.json` are ignored. A bad receipt gives one warning.
export const readSessionReceipts = async (
  sessionId: string,
  home?: string,
  warn: (text: string) => void = console.error,
): Promise<Result<readonly CiReceipt[]>> => {
  const directory = await sessionReceiptDirectory(sessionId, home);
  if (!directory.ok) return directory;
  const receipts: CiReceipt[] = [];
  try {
    for await (const entry of Deno.readDir(directory.value)) {
      if (!entry.name.endsWith(".json")) continue;
      const path = `${directory.value}/${entry.name}`;
      const read = await attempt(async (): Promise<unknown> =>
        JSON.parse(await Deno.readTextFile(path))
      );
      const receipt = read.ok ? decodeCiReceipt(read.value) : read;
      if (receipt.ok) receipts.push(receipt.value);
      else warn(`Skipped unreadable CI receipt ${path}: ${receipt.error}`);
    }
  } catch (error) {
    return error instanceof Deno.errors.NotFound
      ? ok([])
      : err(`Receipt read failed: ${message(error)}`);
  }
  return ok(
    receipts.sort((a, b) =>
      a.started.localeCompare(b.started) || a.id.localeCompare(b.id)
    ),
  );
};
