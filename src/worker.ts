import { writeAll } from "./ipc.ts";
import { attempt, err, ok, type Result } from "./result.ts";
import { type RunEvent, runPlan, type RunResult } from "./runner.ts";
import { type Env, type Plan, type Step, validDirectory } from "./workflow.ts";

type WorkerInput = {
  readonly version: 1;
  readonly parentPid: number;
  readonly workspace: string;
  readonly shell: string;
  readonly inherited: Env;
  readonly plan: Plan;
};

export type WorkerRecord = RunEvent | {
  readonly type: "result";
  readonly result: RunResult;
};

const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exact = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const text = (value: unknown): value is string =>
  typeof value === "string" && !value.includes("\0");

const natural = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const positive = (value: unknown): value is number => natural(value) && value > 0;

const environment = (value: unknown): value is Env =>
  object(value) &&
  Object.entries(value).every(([key, item]) =>
    key.length > 0 && !key.includes("=") && text(item)
  );

const step = (value: unknown): value is Step =>
  object(value) && exact(value, ["name", "script", "directory", "env"]) &&
  text(value.name) && value.name.length > 0 && text(value.script) &&
  text(value.directory) && validDirectory(value.directory) && environment(value.env);

const plan = (value: unknown): value is Plan =>
  object(value) &&
  exact(value, ["job", "name", "timeoutMs", "steps", "otherJobs"]) &&
  text(value.job) && value.job.length > 0 && text(value.name) && value.name.length > 0 &&
  positive(value.timeoutMs) && Array.isArray(value.steps) && value.steps.length > 0 &&
  value.steps.every(step) && Array.isArray(value.otherJobs) &&
  value.otherJobs.every((job) => typeof job === "string");

const decodeInput = (value: unknown): Result<WorkerInput> => {
  if (
    !object(value) ||
    !exact(value, ["version", "parentPid", "workspace", "shell", "inherited", "plan"]) ||
    value.version !== 1 || !positive(value.parentPid) ||
    !text(value.workspace) || !value.workspace.startsWith("/") ||
    !text(value.shell) || !value.shell.startsWith("/") ||
    !environment(value.inherited) || !plan(value.plan)
  ) return err("invalid worker input");
  return ok({
    version: 1,
    parentPid: value.parentPid,
    workspace: value.workspace,
    shell: value.shell,
    inherited: value.inherited,
    plan: value.plan,
  });
};

const runResult = (value: unknown): value is RunResult =>
  object(value) && exact(value, ["kind", "code", "completed", "total", "detail"]) &&
  (value.kind === "success" || value.kind === "failure" || value.kind === "timeout" ||
    value.kind === "cancelled") &&
  natural(value.code) && natural(value.completed) &&
  natural(value.total) && value.completed <= value.total && text(value.detail) &&
  (value.kind === "success" ? value.code === 0 : value.code !== 0);

export const decodeWorkerRecord = (value: unknown): Result<WorkerRecord> => {
  if (!object(value)) return err("invalid worker record");
  if (
    exact(value, ["type", "index", "total", "name"]) && value.type === "step" &&
    natural(value.index) && positive(value.total) && value.index < value.total &&
    text(value.name) && value.name.length > 0
  ) {
    return ok({
      type: "step",
      index: value.index,
      total: value.total,
      name: value.name,
    });
  }
  if (
    exact(value, ["type", "result"]) && value.type === "result" &&
    runResult(value.result)
  ) return ok({ type: "result", result: value.result });
  return err("invalid worker record");
};

const openControl = async (path: string): Promise<Result<Deno.FsFile>> => {
  const found = await attempt(() => Deno.lstat(path));
  if (!found.ok) return found;
  if (!found.value.isFile || found.value.isSymlink) {
    return err("worker control path must be a real file");
  }
  return await attempt(() => Deno.open(path, { write: true, append: true }));
};

const readInput = async (): Promise<Result<WorkerInput>> => {
  const bytes = await attempt(() => new Response(Deno.stdin.readable).arrayBuffer());
  if (!bytes.ok) return bytes;
  if (bytes.value.byteLength > 8 * 1024 * 1024) return err("worker input is too large");
  const parsed = await attempt((): unknown =>
    JSON.parse(new TextDecoder().decode(bytes.value))
  );
  return parsed.ok ? decodeInput(parsed.value) : parsed;
};

const parentWatcher = (
  parentPid: number,
  controller: AbortController,
): ReturnType<typeof setInterval> =>
  setInterval(() => {
    if (Deno.ppid !== parentPid) controller.abort("SIGTERM");
  }, 100);

export const runWorker = async (controlPath: string): Promise<number> => {
  const input = await readInput();
  if (!input.ok) {
    console.error(`worker input failed: ${input.error}`);
    return 1;
  }
  const opened = await openControl(controlPath);
  if (!opened.ok) {
    console.error(`worker control failed: ${opened.error}`);
    return 1;
  }
  const control = opened.value;
  const encoder = new TextEncoder();
  const append = async (record: WorkerRecord): Promise<Result<void>> => {
    const written = await writeAll(
      control,
      encoder.encode(`${JSON.stringify(record)}\n`),
      "control write returned zero bytes",
    );
    if (!written.ok) return written;
    return await attempt(() => control.syncData());
  };
  const controller = new AbortController();
  const stopInt = () => controller.abort("SIGINT");
  const stopTerm = () => controller.abort("SIGTERM");
  Deno.addSignalListener("SIGINT", stopInt);
  Deno.addSignalListener("SIGTERM", stopTerm);
  const watcher = parentWatcher(input.value.parentPid, controller);
  const executed = await attempt(() =>
    runPlan(input.value.plan, {
      workspace: input.value.workspace,
      shell: input.value.shell,
      inherited: input.value.inherited,
      signal: controller.signal,
      event: append,
    })
  );
  clearInterval(watcher);
  Deno.removeSignalListener("SIGINT", stopInt);
  Deno.removeSignalListener("SIGTERM", stopTerm);
  const result: RunResult = executed.ok ? executed.value : {
    kind: "failure",
    code: 1,
    completed: 0,
    total: input.value.plan.steps.length,
    detail: executed.error,
  };
  const recorded = await append({ type: "result", result });
  const closed = await attempt(() => control.close());
  if (!recorded.ok) console.error(`worker result failed: ${recorded.error}`);
  if (!closed.ok) console.error(`worker control close failed: ${closed.error}`);
  return recorded.ok && closed.ok ? result.code : 1;
};
