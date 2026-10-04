// @light-fp adapter
import { attempt, err, ok, type Result } from "./result.ts";

export type LoggerIdentity = {
  readonly started: string;
  readonly command: string;
};

export type CiStatus = {
  readonly version: 1;
  readonly logger: LoggerIdentity | null;
  readonly state: "running" | "pass" | "fail" | "cancelled";
  readonly pid: number;
  readonly started: string;
  readonly finished: string | null;
  readonly code: number | null;
};

const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ciState = (value: unknown): value is CiStatus["state"] =>
  value === "running" || value === "pass" || value === "fail" ||
  value === "cancelled";

const timestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const decodeLogger = (value: unknown): Result<LoggerIdentity | null> => {
  if (value === undefined || value === null) return ok(null);
  if (
    !object(value) || Object.keys(value).length !== 2 ||
    typeof value.started !== "string" || value.started.length !== 24 ||
    typeof value.command !== "string" || value.command.length === 0
  ) return err("invalid CI logger identity");
  return ok({ started: value.started, command: value.command });
};

const decodeStatus = (value: unknown): Result<CiStatus> => {
  if (
    !object(value) ||
    (Object.keys(value).length !== 6 &&
      (Object.keys(value).length !== 7 || !Object.hasOwn(value, "logger"))) ||
    value.version !== 1 ||
    !ciState(value.state) || typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 || !timestamp(value.started)
  ) return err("invalid CI status shape");

  const logger = decodeLogger(value.logger);
  if (!logger.ok) return logger;

  if (value.state === "running") {
    if (value.finished !== null || value.code !== null) {
      return err("invalid CI status state");
    }
    return ok({
      version: 1,
      logger: logger.value,
      state: value.state,
      pid: value.pid,
      started: value.started,
      finished: null,
      code: null,
    });
  }
  if (
    !timestamp(value.finished) || typeof value.code !== "number" ||
    !Number.isSafeInteger(value.code) || value.code < 0
  ) return err("invalid CI status state");
  const finished = value.finished;
  const code = value.code;
  if (
    value.state === "pass" && code !== 0 ||
    (value.state === "fail" || value.state === "cancelled") && code === 0
  ) return err("invalid CI status exit code");

  return ok({
    version: 1,
    logger: logger.value,
    state: value.state,
    pid: value.pid,
    started: value.started,
    finished,
    code,
  });
};

export const readCiStatus = async (
  workspace: string,
): Promise<Result<CiStatus | null>> => {
  const path = `${workspace.replace(/\/$/, "")}/.mci/ci/status.json`;
  const found = await metadata(path);
  if (!found.ok) return found;
  if (found.value === null) return ok(null);
  if (!found.value.isFile || found.value.isSymlink) {
    return err("CI status must be a real file");
  }
  const parsed = await attempt(async (): Promise<unknown> =>
    JSON.parse(await Deno.readTextFile(path))
  );
  if (!parsed.ok) return err(`invalid CI status JSON: ${parsed.error}`);
  return decodeStatus(parsed.value);
};

const metadata = async (path: string): Promise<Result<Deno.FileInfo | null>> => {
  try {
    return ok(await Deno.lstat(path));
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? ok(null) : err(String(error));
  }
};
