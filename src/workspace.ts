import { type ProcessRecord, recoverProcess } from "./process.ts";
import { attempt, err, ok, type Result } from "./result.ts";
import type { Step } from "./workflow.ts";

type Journal = {
  readonly version: 1;
  readonly runDir: string;
  readonly process: ProcessRecord | null;
};

export type RunLease = {
  readonly directory: string;
  readonly prepare: (
    step: Step,
    index: number,
  ) => Promise<Result<{ readonly cwd: string; readonly script: string }>>;
  readonly record: (process: ProcessRecord | null) => Promise<Result<void>>;
  readonly close: () => Promise<Result<void>>;
};

const metadata = async (path: string): Promise<Result<Deno.FileInfo | null>> => {
  try {
    return ok(await Deno.lstat(path));
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? ok(null) : err(String(error));
  }
};

const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const privateDirectory = (state: string, path: string): boolean =>
  path.startsWith(`${state}/`) &&
  /^run-[A-Za-z0-9._-]+$/.test(path.slice(state.length + 1));

const decodeJournal = (state: string, value: unknown): Result<Journal> => {
  if (
    !object(value) || Object.keys(value).length !== 3 || value.version !== 1 ||
    typeof value.runDir !== "string" || !privateDirectory(state, value.runDir)
  ) return err("invalid recovery journal directory or version");
  const process = value.process;
  if (process === null) return ok({ version: 1, runDir: value.runDir, process: null });
  if (
    !object(process) || Object.keys(process).length !== 3 ||
    typeof process.pid !== "number" || !Number.isSafeInteger(process.pid) ||
    process.pid < 1 || process.pid > 2_147_483_647 ||
    typeof process.started !== "string" || !process.started.trim() ||
    typeof process.script !== "string" ||
    !process.script.startsWith(`${value.runDir}/`) ||
    !/^step-[1-9][0-9]*\.sh$/.test(process.script.slice(value.runDir.length + 1))
  ) return err("invalid recovery journal process");
  return ok({
    version: 1,
    runDir: value.runDir,
    process: { pid: process.pid, started: process.started, script: process.script },
  });
};

const writeJournal = async (state: string, journal: Journal): Promise<Result<void>> => {
  const temporary = await attempt(() =>
    Deno.makeTempFile({ dir: state, prefix: ".journal-" })
  );
  if (!temporary.ok) return temporary;
  const written = await attempt(async () => {
    await Deno.writeTextFile(temporary.value, JSON.stringify(journal));
    await Deno.rename(temporary.value, `${state}/run.json`);
  });
  if (written.ok) return written;
  const removed = await attempt(() => Deno.remove(temporary.value));
  return err(
    `${written.error}${
      removed.ok ? "" : `; journal temporary cleanup failed: ${removed.error}`
    }`,
  );
};

const removePrivateDirectory = async (
  state: string,
  path: string,
): Promise<Result<void>> => {
  if (!privateDirectory(state, path)) return err(`invalid private directory: ${path}`);
  const found = await metadata(path);
  if (!found.ok) return found;
  if (found.value === null) return ok(undefined);
  if (!found.value.isDirectory || found.value.isSymlink) {
    return err(`private directory is not a real directory: ${path}`);
  }
  return await attempt(() => Deno.remove(path, { recursive: true }));
};

const removeRun = async (state: string, runDir: string): Promise<Result<void>> => {
  const removed = await removePrivateDirectory(state, runDir);
  if (!removed.ok) return err(`private script cleanup failed: ${removed.error}`);
  const cleared = await attempt(() => Deno.remove(`${state}/run.json`));
  return cleared.ok ? cleared : err(`journal cleanup failed: ${cleared.error}`);
};

const recoverState = async (state: string): Promise<Result<void>> => {
  const journalPath = `${state}/run.json`;
  const found = await metadata(journalPath);
  if (!found.ok) return found;
  if (found.value !== null) {
    if (!found.value.isFile || found.value.isSymlink) {
      return err("invalid recovery journal file");
    }
    const read = await attempt(async (): Promise<unknown> =>
      JSON.parse(await Deno.readTextFile(journalPath))
    );
    if (!read.ok) return err(`invalid recovery journal: ${read.error}`);
    const decoded = decodeJournal(state, read.value);
    if (!decoded.ok) return decoded;
    const journal = decoded.value;
    if (journal.process !== null) {
      const recovered = await recoverProcess(journal.process);
      if (!recovered.ok) {
        return err(
          `recovery failed: ${recovered.error}; retained journal: ${journalPath}`,
        );
      }
      const cleared = await writeJournal(state, { ...journal, process: null });
      if (!cleared.ok) return err(`journal cleanup failed: ${cleared.error}`);
    }
    const removed = await removeRun(state, journal.runDir);
    if (!removed.ok) return removed;
  }
  const entries = await attempt(() => Array.fromAsync(Deno.readDir(state)));
  if (!entries.ok) return entries;
  for (const entry of entries.value) {
    if (entry.name.startsWith("run-")) {
      const path = `${state}/${entry.name}`;
      if (!entry.isDirectory || entry.isSymlink || !privateDirectory(state, path)) {
        continue;
      }
      const removed = await removePrivateDirectory(state, path);
      if (!removed.ok) return err(`orphan script cleanup failed: ${removed.error}`);
    } else if (entry.name.startsWith(".journal-") && entry.isFile && !entry.isSymlink) {
      const removed = await attempt(() => Deno.remove(`${state}/${entry.name}`));
      if (!removed.ok) return err(`orphan journal cleanup failed: ${removed.error}`);
    }
  }
  return ok(undefined);
};

const openWorkspace = async (workspace: string): Promise<Result<RunLease | "busy">> => {
  const resolved = await attempt(async () => {
    const root = await Deno.realPath(workspace);
    if (!(await Deno.stat(root)).isDirectory) return err("workspace is not a directory");
    const state = `${root.replace(/\/$/, "")}/.mci`;
    await Deno.mkdir(state, { recursive: true, mode: 0o700 });
    const directory = await Deno.lstat(state);
    if (!directory.isDirectory || directory.isSymlink) {
      return err(".mci must be a real directory");
    }
    return ok({ root, state });
  });
  if (!resolved.ok) return resolved;
  if (!resolved.value.ok) return resolved.value;
  const { root, state } = resolved.value.value;
  const existing = await metadata(`${state}/lock`);
  if (!existing.ok) return existing;
  if (existing.value !== null && (!existing.value.isFile || existing.value.isSymlink)) {
    return err("workspace lock must be a real file");
  }
  const opened = await attempt(() =>
    Deno.open(`${state}/lock`, { create: true, read: true, write: true, mode: 0o600 })
  );
  if (!opened.ok) return opened;
  const lock = opened.value;
  const fail = async (detail: string): Promise<Result<RunLease | "busy">> => {
    const closed = await attempt(() => lock.close());
    return err(`${detail}${closed.ok ? "" : `; lock cleanup failed: ${closed.error}`}`);
  };
  const locked = await attempt(() => lock.tryLock(true));
  if (!locked.ok) return await fail(locked.error);
  if (!locked.value) {
    const released = await attempt(() => lock.close());
    return released.ok ? ok("busy") : err(`lock cleanup failed: ${released.error}`);
  }
  const recovered = await recoverState(state);
  if (!recovered.ok) return await fail(recovered.error);
  const created = await attempt(() => Deno.makeTempDir({ dir: state, prefix: "run-" }));
  if (!created.ok) return await fail(created.error);
  let journal: Journal = { version: 1, runDir: created.value, process: null };
  const persisted = await writeJournal(state, journal);
  if (!persisted.ok) {
    const removed = await removePrivateDirectory(state, journal.runDir);
    return await fail(
      `${persisted.error}${
        removed.ok ? "" : `; private script cleanup failed: ${removed.error}`
      }`,
    );
  }
  let closed = false;
  const record = async (process: ProcessRecord | null): Promise<Result<void>> => {
    if (closed) return err("workspace lease is closed");
    const next: Journal = { ...journal, process };
    const validated = decodeJournal(state, next);
    if (!validated.ok) return validated;
    if (process !== null) journal = next;
    const written = await writeJournal(state, next);
    if (written.ok) journal = next;
    return written;
  };
  const prepare: RunLease["prepare"] = async (step, index) => {
    if (closed) return err("workspace lease is closed");
    const cwd = await attempt(() => Deno.realPath(`${root}/${step.directory}`));
    if (!cwd.ok) return cwd;
    if (cwd.value !== root && !cwd.value.startsWith(`${root.replace(/\/$/, "")}/`)) {
      return err("working-directory resolves outside the workspace");
    }
    const found = await attempt(() => Deno.stat(cwd.value));
    if (!found.ok) return found;
    if (!found.value.isDirectory) return err("working-directory is not a directory");
    const script = `${journal.runDir}/step-${index + 1}.sh`;
    const written = await attempt(() =>
      Deno.writeTextFile(script, step.script, { mode: 0o600 })
    );
    return written.ok ? ok({ cwd: cwd.value, script }) : written;
  };
  const close = async (): Promise<Result<void>> => {
    if (closed) return err("workspace lease is closed");
    closed = true;
    const diagnostics: string[] = [];
    if (journal.process !== null) {
      const retained = await writeJournal(state, journal);
      if (!retained.ok) diagnostics.push(`journal retention failed: ${retained.error}`);
      diagnostics.push(
        `process cleanup remains uncertain; retained journal: ${state}/run.json`,
      );
    } else {
      const removed = await removeRun(state, journal.runDir);
      if (!removed.ok) diagnostics.push(removed.error);
    }
    const released = await attempt(() => lock.close());
    if (!released.ok) diagnostics.push(`lock cleanup failed: ${released.error}`);
    return diagnostics.length ? err(diagnostics.join("\n")) : ok(undefined);
  };
  return ok({ directory: journal.runDir, prepare, record, close });
};

export const acquireWorkspace = async (workspace: string): Promise<Result<RunLease>> => {
  const opened = await openWorkspace(workspace);
  if (!opened.ok) return opened;
  return opened.value === "busy"
    ? err("another job is already running in this workspace")
    : ok(opened.value);
};

export const recoverWorkspace = async (
  workspace: string,
): Promise<Result<"recovered" | "busy">> => {
  const opened = await openWorkspace(workspace);
  if (!opened.ok) return opened;
  if (opened.value === "busy") return ok("busy");
  const closed = await opened.value.close();
  return closed.ok ? ok("recovered") : closed;
};
