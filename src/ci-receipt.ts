// @light-fp adapter
import { servicePaths } from "./paths.ts";
import type { TerminalKind } from "./protocol.ts";
import { attempt, err, message, ok, type Result } from "./result.ts";

export type CiCommand = "ci" | "run";

type OutcomeFields = {
  readonly detail: string | null;
  readonly requestId: string | null;
  readonly log: string | null;
};

export type CiReceiptOutcome =
  | ({ readonly kind: "pending"; readonly code: null } & OutcomeFields)
  | ({ readonly kind: "error"; readonly code: 1 | 2 } & OutcomeFields)
  | ({ readonly kind: "unknown"; readonly code: 1 } & OutcomeFields)
  | ({ readonly kind: TerminalKind; readonly code: number } & OutcomeFields);

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

export type BeginReceiptInput = {
  readonly workspace: string;
  readonly workflow: string;
  readonly job: string;
  readonly command: CiCommand;
  readonly home?: string;
};

const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exact = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");

const text = (value: unknown): value is string =>
  typeof value === "string" && !value.includes("\0");

const absolute = (value: unknown): value is string =>
  nonempty(value) && value.startsWith("/");

const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);

const safeCode = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const nullableNonempty = (value: unknown): value is string | null =>
  value === null || nonempty(value);

const nullableAbsolute = (value: unknown): value is string | null =>
  value === null || absolute(value);

const outcomeKeys = ["kind", "code", "detail", "requestId", "log"] as const;

const decodeOutcome = (value: unknown): Result<CiReceiptOutcome> => {
  if (
    !object(value) || !exact(value, outcomeKeys) ||
    !nullableNonempty(value.requestId) || !nullableAbsolute(value.log)
  ) return err("Invalid CI receipt outcome");

  if (
    value.kind === "pending" && value.code === null && value.detail === null &&
    value.requestId === null && value.log === null
  ) {
    return ok({
      kind: "pending",
      code: null,
      detail: null,
      requestId: null,
      log: null,
    });
  }
  if (
    value.kind === "error" && (value.code === 1 || value.code === 2) &&
    nonempty(value.detail) && value.requestId === null && value.log === null
  ) {
    return ok({
      kind: "error",
      code: value.code,
      detail: value.detail,
      requestId: null,
      log: null,
    });
  }
  if (
    value.kind === "unknown" && value.code === 1 && nonempty(value.detail)
  ) {
    return ok({
      kind: "unknown",
      code: 1,
      detail: value.detail,
      requestId: value.requestId,
      log: value.log,
    });
  }
  const kind = value.kind;
  if (
    (kind === "success" || kind === "failure" || kind === "timeout" ||
      kind === "cancelled" || kind === "interrupted") &&
    safeCode(value.code) && (value.detail === null || text(value.detail)) &&
    (kind === "success" ? value.code === 0 : value.code !== 0)
  ) {
    return ok({
      kind,
      code: value.code,
      detail: value.detail,
      requestId: value.requestId,
      log: value.log,
    });
  }
  return err("Invalid CI receipt outcome");
};

const receiptKeys = [
  "version",
  "id",
  "sessionId",
  "workspace",
  "workflow",
  "job",
  "command",
  "started",
  "finished",
  "outcome",
] as const;

export const decodeCiReceipt = (value: unknown): Result<CiReceipt> => {
  if (
    !object(value) || !exact(value, receiptKeys) || value.version !== 1 ||
    !uuid(value.id) || !nonempty(value.sessionId) || !absolute(value.workspace) ||
    !absolute(value.workflow) || !nonempty(value.job) ||
    (value.command !== "ci" && value.command !== "run") ||
    !timestamp(value.started) ||
    !(value.finished === null || timestamp(value.finished))
  ) return err("Invalid CI receipt");
  const outcome = decodeOutcome(value.outcome);
  if (!outcome.ok) return outcome;
  if (
    (value.finished === null) !== (outcome.value.kind === "pending") ||
    (value.finished !== null && value.finished < value.started)
  ) return err("Invalid CI receipt completion");
  return ok({
    version: 1,
    id: value.id,
    sessionId: value.sessionId,
    workspace: value.workspace,
    workflow: value.workflow,
    job: value.job,
    command: value.command,
    started: value.started,
    finished: value.finished,
    outcome: outcome.value,
  });
};

export const sessionReceiptId = (): string | null => {
  for (const name of ["MCI_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID"]) {
    const value = Deno.env.get(name);
    if (value !== undefined && value.length > 0) return value;
  }
  return null;
};

const sessionHash = async (sessionId: string): Promise<Result<string>> => {
  if (!nonempty(sessionId)) return err("Session identifier must not be empty");
  const hashed = await attempt(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId))
  );
  if (!hashed.ok) return hashed;
  return ok(
    Array.from(new Uint8Array(hashed.value)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join(""),
  );
};

export const sessionReceiptDirectory = async (
  sessionId: string,
  home?: string,
): Promise<Result<string>> => {
  const paths = servicePaths(home);
  if (!paths.ok) return paths;
  const hash = await sessionHash(sessionId);
  return hash.ok ? ok(`${paths.value.directory}/sessions/${hash.value}`) : hash;
};

export const receiptPath = async (
  sessionId: string,
  receiptId: string,
  home?: string,
): Promise<Result<string>> => {
  if (!uuid(receiptId)) return err("Receipt identifier must be a UUID");
  const directory = await sessionReceiptDirectory(sessionId, home);
  return directory.ok ? ok(`${directory.value}/${receiptId}.json`) : directory;
};

const metadata = async (path: string): Promise<Result<Deno.FileInfo | null>> => {
  try {
    return ok(await Deno.lstat(path));
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? ok(null) : err(message(error));
  }
};

const privateDirectory = async (
  path: string,
  recursive: boolean,
): Promise<Result<void>> => {
  try {
    await Deno.mkdir(path, { recursive, mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) return err(message(error));
  }
  const found = await metadata(path);
  if (
    !found.ok || found.value === null || !found.value.isDirectory ||
    found.value.isSymlink
  ) return found.ok ? err(`${path} must be a real directory`) : found;
  return await attempt(() => Deno.chmod(path, 0o700));
};

const prepareReceiptDirectory = async (
  sessionId: string,
  home?: string,
): Promise<Result<string>> => {
  const paths = servicePaths(home);
  if (!paths.ok) return paths;
  const root = await privateDirectory(paths.value.directory, true);
  if (!root.ok) return root;
  const sessions = `${paths.value.directory}/sessions`;
  const madeSessions = await privateDirectory(sessions, false);
  if (!madeSessions.ok) return madeSessions;
  const directory = await sessionReceiptDirectory(sessionId, home);
  if (!directory.ok) return directory;
  const madeSession = await privateDirectory(directory.value, false);
  return madeSession.ok ? directory : madeSession;
};

const writeReceipt = async (
  receipt: CiReceipt,
  home?: string,
): Promise<Result<void>> => {
  const directory = await prepareReceiptDirectory(receipt.sessionId, home);
  if (!directory.ok) return directory;
  const path = `${directory.value}/${receipt.id}.json`;
  const found = await metadata(path);
  if (!found.ok) return found;
  if (found.value !== null && (!found.value.isFile || found.value.isSymlink)) {
    return err(`${path} must be a real file`);
  }
  const temporary = await attempt(() =>
    Deno.makeTempFile({ dir: directory.value, prefix: ".receipt-" })
  );
  if (!temporary.ok) return temporary;
  const written = await attempt(async () => {
    await Deno.chmod(temporary.value, 0o600);
    await Deno.writeTextFile(
      temporary.value,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    const file = await Deno.open(temporary.value, { write: true });
    try {
      await file.syncData();
    } finally {
      file.close();
    }
    await Deno.rename(temporary.value, path);
  });
  if (written.ok) return written;
  await attempt(() => Deno.remove(temporary.value));
  return written;
};

const normalizedAbsolute = (workspace: string, workflow: string): string => {
  const source = workflow.startsWith("/") ? workflow : `${workspace}/${workflow}`;
  const parts: string[] = [];
  for (const part of source.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
};

const canonicalIdentity = async (
  workspace: string,
  workflow: string,
): Promise<Result<{ readonly workspace: string; readonly workflow: string }>> => {
  const realWorkspace = await attempt(() => Deno.realPath(workspace));
  if (!realWorkspace.ok) return err(`Workspace identity failed: ${realWorkspace.error}`);
  const candidate = normalizedAbsolute(realWorkspace.value, workflow);
  const realWorkflow = await attempt(() => Deno.realPath(candidate));
  return ok({
    workspace: realWorkspace.value,
    workflow: realWorkflow.ok ? realWorkflow.value : candidate,
  });
};

const pendingOutcome = (): CiReceiptOutcome => ({
  kind: "pending",
  code: null,
  detail: null,
  requestId: null,
  log: null,
});

export const beginReceipt = async (
  input: BeginReceiptInput,
): Promise<Result<CiReceipt | null>> => {
  const sessionId = sessionReceiptId();
  if (sessionId === null) return ok(null);
  if (!nonempty(input.job)) return err("Receipt job must not be empty");
  const identity = await canonicalIdentity(input.workspace, input.workflow);
  if (!identity.ok) return identity;
  const receipt: CiReceipt = {
    version: 1,
    id: crypto.randomUUID(),
    sessionId,
    workspace: identity.value.workspace,
    workflow: identity.value.workflow,
    job: input.job,
    command: input.command,
    started: new Date().toISOString(),
    finished: null,
    outcome: pendingOutcome(),
  };
  const written = await writeReceipt(receipt, input.home);
  return written.ok ? ok(receipt) : written;
};

export const finishReceipt = async (
  receipt: CiReceipt | null,
  outcome: CiReceiptOutcome,
  home?: string,
): Promise<Result<CiReceipt | null>> => {
  if (receipt === null) return ok(null);
  const checked = decodeOutcome(outcome);
  if (!checked.ok || checked.value.kind === "pending") {
    return err(checked.ok ? "A final receipt cannot remain pending" : checked.error);
  }
  const finished: CiReceipt = {
    ...receipt,
    finished: new Date().toISOString(),
    outcome: checked.value,
  };
  const written = await writeReceipt(finished, home);
  return written.ok ? ok(finished) : written;
};

export const readSessionReceipts = async (
  sessionId: string,
  home?: string,
): Promise<Result<readonly CiReceipt[]>> => {
  const paths = servicePaths(home);
  if (!paths.ok) return paths;
  const directory = await sessionReceiptDirectory(sessionId, home);
  if (!directory.ok) return directory;
  for (
    const path of [
      paths.value.directory,
      `${paths.value.directory}/sessions`,
      directory.value,
    ]
  ) {
    const found = await metadata(path);
    if (!found.ok) return found;
    if (found.value === null) return ok([]);
    if (!found.value.isDirectory || found.value.isSymlink) {
      return err(`${path} must be a real directory`);
    }
  }
  const listed = await attempt(async () => {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(directory.value)) entries.push(entry);
    return entries;
  });
  if (!listed.ok) return err(`Receipt read failed: ${listed.error}`);
  const receipts: CiReceipt[] = [];
  for (const entry of listed.value) {
    if (!entry.name.endsWith(".json")) continue;
    const path = `${directory.value}/${entry.name}`;
    if (!entry.isFile || entry.isSymlink) return err(`${path} must be a real file`);
    const parsed = await attempt(async (): Promise<unknown> =>
      JSON.parse(await Deno.readTextFile(path))
    );
    if (!parsed.ok) return err(`${path}: ${parsed.error}`);
    const decoded = decodeCiReceipt(parsed.value);
    if (!decoded.ok) return err(`${path}: ${decoded.error}`);
    if (decoded.value.sessionId !== sessionId) {
      return err(`${path}: receipt belongs to another session`);
    }
    receipts.push(decoded.value);
  }
  receipts.sort((left, right) =>
    left.started.localeCompare(right.started) || left.id.localeCompare(right.id)
  );
  return ok(receipts);
};
