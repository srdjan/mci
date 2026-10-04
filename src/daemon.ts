import {
  type DaemonStore,
  openDaemonStore,
  type PendingRequest,
} from "./daemon-store.ts";
import { readJson, sendJson } from "./ipc.ts";
import { type ServicePaths, servicePaths } from "./paths.ts";
import {
  type Active,
  decodeRequest,
  finishTime,
  type Repository,
  type RepositoryState,
  type Request,
  type Response,
  type Snapshot,
  type Terminal,
} from "./protocol.ts";
import { attempt, err, message, ok, type Result } from "./result.ts";
import { resolveBash, type RunResult } from "./runner.ts";
import { cliSelfArgs } from "./runtime.ts";
import { type Env, type Plan, planWorkflow } from "./workflow.ts";
import { recoverWorkspace } from "./workspace.ts";
import { decodeWorkerRecord } from "./worker.ts";

type Owner = {
  readonly connection: Deno.UnixConn;
  connected: boolean;
};

type Job = {
  readonly id: string;
  readonly repository: MutableRepository;
  readonly workflow: string;
  readonly plan: Plan;
  readonly inherited: Env;
  readonly shell: string;
  started: string;
  readonly log: string;
  readonly control: string;
  readonly owner: Owner;
  readonly result: Promise<Terminal>;
  readonly resolve: (terminal: Terminal) => void;
  readonly stop: AbortController;
  step: string | null;
  child: Deno.ChildProcess | null;
  cancelReason: "SIGINT" | "SIGTERM" | null;
  storageError: string | null;
};

type MutableRepository = {
  readonly repository: Repository;
  readonly queue: Job[];
  active: Job | null;
  latest: Terminal | null;
  blocked: string | null;
  accepting: number;
  acceptance: Promise<void>;
  removing: boolean;
};

type DaemonRuntime = {
  readonly store: DaemonStore;
  readonly instance: string;
  readonly repositories: Map<string, MutableRepository>;
  readonly holds: Map<string, number>;
  readonly obsolete: Map<string, { readonly path: string; readonly id: string }>;
  management: Promise<void>;
  readonly routing: Map<string, Promise<void>>;
  readonly resolvePath: (path: string) => Promise<Result<string>>;
  readonly shutdown: AbortController;
  readonly requestDeadlineMs: number;
  closed: boolean;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const responseError = (
  tag: Extract<Response, { readonly type: "error" }>["tag"],
  detail: string,
): Response => ({ version: 1, type: "error", tag, detail });

const closeConnection = (connection: Deno.UnixConn): void => {
  try {
    connection.close();
  } catch { /* The connection is already closed. */ }
};

const signalWorker = (
  job: Job,
  signal: "SIGINT" | "SIGTERM",
  cancellation = true,
): void => {
  if (cancellation) job.cancelReason ??= signal;
  job.stop.abort(signal);
  if (job.child === null) return;
  try {
    job.child.kill(signal);
  } catch (error) {
    // For the fixed signal names, Deno throws TypeError only for a terminated child.
    if (!(error instanceof Deno.errors.NotFound || error instanceof TypeError)) {
      job.storageError ??= `worker signal failed: ${message(error)}`;
    }
  }
};

const snapshot = (runtime: DaemonRuntime): Snapshot => ({
  version: 1,
  instance: runtime.instance,
  pid: Deno.pid,
  updated: new Date().toISOString(),
  repositories: Array.from(runtime.repositories.values()).map((
    state,
  ): RepositoryState => ({
    ...state.repository,
    queued: state.queue.length,
    active: state.active === null ? null : {
      id: state.active.id,
      workflow: state.active.workflow,
      job: state.active.plan.job,
      started: state.active.started,
      step: state.active.step,
      log: state.active.log,
    } satisfies Active,
    latest: state.latest,
    blocked: state.blocked,
  })),
});

const publish = async (runtime: DaemonRuntime): Promise<Result<void>> =>
  await runtime.store.writeSnapshot(snapshot(runtime));

const hold = (runtime: DaemonRuntime, id: string): void => {
  runtime.holds.set(id, (runtime.holds.get(id) ?? 0) + 1);
};

const blockRetention = (
  runtime: DaemonRuntime,
  path: string,
  detail: string,
): MutableRepository | undefined => {
  const repository = Array.from(runtime.repositories.values()).find((state) =>
    state.repository.path === path
  );
  if (repository !== undefined) {
    repository.blocked ??= `request retention failed: ${detail}`;
  }
  return repository;
};

const release = async (runtime: DaemonRuntime, id: string): Promise<void> => {
  const count = runtime.holds.get(id) ?? 0;
  if (count > 1) {
    runtime.holds.set(id, count - 1);
    return;
  }
  runtime.holds.delete(id);
  const obsolete = runtime.obsolete.get(id);
  if (obsolete === undefined) return;
  if (runtime.store.pending().some((request) => request.id === id)) return;
  const removed = await runtime.store.removeRun(obsolete.path, obsolete.id);
  if (removed.ok) runtime.obsolete.delete(id);
  else {
    const blocked = blockRetention(runtime, obsolete.path, removed.error);
    await publish(runtime);
    if (blocked !== undefined) pump(runtime, blocked);
  }
};

const retire = async (
  runtime: DaemonRuntime,
  path: string,
  terminal: Terminal | null,
): Promise<void> => {
  if (terminal === null) return;
  if (
    (runtime.holds.get(terminal.id) ?? 0) > 0 ||
    runtime.store.pending().some((request) => request.id === terminal.id)
  ) {
    runtime.obsolete.set(terminal.id, { path, id: terminal.id });
    return;
  }
  const removed = await runtime.store.removeRun(path, terminal.id);
  if (!removed.ok) blockRetention(runtime, path, removed.error);
};

const writeAll = async (file: Deno.FsFile, bytes: Uint8Array): Promise<Result<void>> => {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await attempt(() => file.write(bytes.subarray(offset)));
    if (!written.ok) return written;
    if (written.value === 0) return err("request log write returned zero bytes");
    offset += written.value;
  }
  return ok(undefined);
};

const readControl = async (
  job: Job,
  consumed: number,
): Promise<
  Result<{ readonly consumed: number; readonly result: RunResult | null }>
> => {
  const read = await attempt(() => Deno.readTextFile(job.control));
  if (!read.ok) return read;
  if (new TextEncoder().encode(read.value).length > 1024 * 1024) {
    return err("worker control exceeds 1 MiB");
  }
  const lines = read.value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  else lines.pop();
  if (lines.length > job.plan.steps.length + 1) {
    return err("worker control has too many records");
  }
  let result: RunResult | null = null;
  for (let index = consumed; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || line.length === 0) {
      return err("worker control has an empty record");
    }
    const parsed = await attempt((): unknown => JSON.parse(line));
    if (!parsed.ok) return err(`worker control JSON failed: ${parsed.error}`);
    const decoded = decodeWorkerRecord(parsed.value);
    if (!decoded.ok) return decoded;
    if (decoded.value.type === "step") {
      if (result !== null) return err("worker control has a step after its result");
      if (
        decoded.value.index !== index || decoded.value.total !== job.plan.steps.length ||
        decoded.value.name !== job.plan.steps[index]?.name
      ) return err("worker control step does not match the accepted plan");
      job.step = decoded.value.name;
    } else {
      if (result !== null) return err("worker control has duplicate results");
      if (decoded.value.result.total !== job.plan.steps.length) {
        return err("worker control result does not match the accepted plan");
      }
      result = decoded.value.result;
    }
  }
  return ok({ consumed: lines.length, result });
};

const drainWorkerOutput = async (
  job: Job,
  child: Deno.ChildProcess,
): Promise<Result<() => Promise<Result<void>>>> => {
  const found = await attempt(() => Deno.lstat(job.log));
  if (!found.ok) return found;
  if (!found.value.isFile || found.value.isSymlink) {
    return err("request log is not a real file");
  }
  const opened = await attempt(() => Deno.open(job.log, { write: true, append: true }));
  if (!opened.ok) return opened;
  const file = opened.value;
  let chain = Promise.resolve<Result<void>>(ok(undefined));
  const append = (chunk: Uint8Array): Promise<Result<void>> => {
    const copy = chunk.slice();
    const next = chain.then((prior) => prior.ok ? writeAll(file, copy) : prior);
    chain = next;
    return next;
  };
  const stdout = child.stdout.getReader();
  const stderr = child.stderr.getReader();
  const drain = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<Result<void>> => {
    while (true) {
      const read = await attempt(() => reader.read());
      if (!read.ok) {
        signalWorker(job, "SIGTERM", false);
        return read;
      }
      if (read.value.done) return ok(undefined);
      const written = await append(read.value.value);
      if (!written.ok) {
        signalWorker(job, "SIGTERM", false);
        return written;
      }
    }
  };
  const draining = Promise.all([drain(stdout), drain(stderr)]);
  return ok(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cut = () => {};
    const bounded = new Promise<boolean>((resolve) => {
      cut = () => resolve(false);
      timer = setTimeout(cut, 2000);
      job.stop.signal.addEventListener("abort", cut, { once: true });
      if (job.stop.signal.aborted) cut();
    });
    const completed = await Promise.race([draining.then(() => true), bounded]);
    clearTimeout(timer);
    job.stop.signal.removeEventListener("abort", cut);
    if (!completed) {
      await Promise.allSettled([
        stdout.cancel("output grace expired"),
        stderr.cancel("output grace expired"),
      ]);
    }
    const results = await draining;
    const queued = await chain;
    const synced = await attempt(() => file.syncData());
    const closed = await attempt(() => file.close());
    const failure = results.find((result) => !result.ok);
    if (failure !== undefined && !failure.ok) return failure;
    if (!queued.ok) return queued;
    if (!synced.ok) return synced;
    if (!closed.ok) return closed;
    return completed || job.cancelReason !== null
      ? ok(undefined)
      : err("worker output did not close within 2000 ms");
  });
};

const workerTerminal = (job: Job, outcome: RunResult): Terminal => ({
  id: job.id,
  repositoryId: job.repository.repository.id,
  workflow: job.workflow,
  job: job.plan.job,
  started: job.started,
  finished: finishTime(job.started, new Date().toISOString()),
  kind: outcome.kind,
  code: outcome.code,
  completed: outcome.completed,
  total: outcome.total,
  detail: outcome.detail,
  log: job.log,
});

const failedTerminal = (job: Job, detail: string): Terminal => ({
  id: job.id,
  repositoryId: job.repository.repository.id,
  workflow: job.workflow,
  job: job.plan.job,
  started: job.started,
  finished: finishTime(job.started, new Date().toISOString()),
  kind: job.cancelReason === null ? "failure" : "cancelled",
  code: job.cancelReason === "SIGINT" ? 130 : job.cancelReason === "SIGTERM" ? 143 : 1,
  completed: 0,
  total: job.plan.steps.length,
  detail,
  log: job.log,
});

const runWorkerProcess = async (runtime: DaemonRuntime, job: Job): Promise<Terminal> => {
  const spawned = await attempt(() =>
    new Deno.Command(Deno.execPath(), {
      args: cliSelfArgs(["__worker", job.control]),
      cwd: job.repository.repository.path,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn()
  );
  if (!spawned.ok) return failedTerminal(job, `worker launch failed: ${spawned.error}`);
  const child = spawned.value;
  job.child = child;
  const exited = () => {
    job.child = null;
  };
  child.status.then(exited, exited);
  if (job.cancelReason !== null) signalWorker(job, job.cancelReason);
  const drains = await drainWorkerOutput(job, child);
  if (!drains.ok) {
    signalWorker(job, "SIGTERM", false);
    await child.status;
    return failedTerminal(job, `log open failed: ${drains.error}`);
  }
  const input = {
    version: 1,
    parentPid: Deno.pid,
    workspace: job.repository.repository.path,
    shell: job.shell,
    inherited: job.inherited,
    plan: job.plan,
  } as const;
  const sent = await attempt(async () => {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(input)));
    await writer.close();
  });
  if (!sent.ok) signalWorker(job, "SIGTERM", false);

  let consumed = 0;
  let final: RunResult | null = null;
  let status: Deno.CommandStatus | null = null;
  let exitCode = 1;
  const statusPromise = attempt(() => child.status).then((observed) => {
    if (observed.ok) {
      status = observed.value;
      exitCode = observed.value.code;
    } else job.storageError ??= `worker status failed: ${observed.error}`;
  });
  while (status === null && job.storageError === null) {
    const control = await readControl(job, consumed);
    if (!control.ok) {
      job.storageError = `worker control failed: ${control.error}`;
      signalWorker(job, "SIGTERM", false);
      break;
    }
    const changed = control.value.consumed !== consumed;
    consumed = control.value.consumed;
    final ??= control.value.result;
    if (changed) {
      const published = await publish(runtime);
      if (!published.ok) {
        job.storageError = `snapshot write failed: ${published.error}`;
        signalWorker(job, "SIGTERM", false);
        break;
      }
    }
    await delay(25);
  }
  await statusPromise;
  const drained = await drains.value();
  if (!drained.ok) job.storageError ??= `log drain failed: ${drained.error}`;
  const control = await readControl(job, consumed);
  if (!control.ok) job.storageError ??= `worker control failed: ${control.error}`;
  else final ??= control.value.result;
  if (!sent.ok) job.storageError ??= `worker input failed: ${sent.error}`;
  if (job.storageError !== null) return failedTerminal(job, job.storageError);
  if (final === null) {
    return failedTerminal(job, `worker exited ${exitCode} without a final result`);
  }
  if (exitCode !== final.code) {
    return failedTerminal(job, `worker exited ${exitCode}, but reported ${final.code}`);
  }
  return workerTerminal(job, final);
};

// During shutdown only a cancelled job becomes interrupted. A worker that already
// returned its final result keeps that result.
const shutdownTerminal = (runtime: DaemonRuntime, terminal: Terminal): Terminal =>
  runtime.closed && terminal.kind === "cancelled"
    ? {
      ...terminal,
      kind: "interrupted",
      code: 143,
      detail: "The daemon stopped before completion.",
    }
    : terminal;

const complete = async (
  runtime: DaemonRuntime,
  repository: MutableRepository,
  job: Job,
  terminal: Terminal,
): Promise<void> => {
  let result = shutdownTerminal(runtime, terminal);
  let stored = await runtime.store.writeTerminal(repository.repository.path, result);
  if (!stored.ok) {
    result = {
      ...failedTerminal(job, `terminal storage failed: ${stored.error}`),
      kind: "failure",
      code: 1,
    };
    stored = await runtime.store.writeTerminal(repository.repository.path, result);
  }
  const previous = repository.latest;
  if (stored.ok) {
    repository.latest = result;
    const finished = await runtime.store.finish(job.id);
    if (!finished.ok) {
      repository.blocked = `request journal cleanup failed: ${finished.error}`;
    }
    await attempt(() => Deno.remove(job.control));
    await retire(runtime, repository.repository.path, previous);
  } else {
    repository.blocked = `terminal storage failed: ${stored.error}`;
  }
  if (repository.active === job) repository.active = null;
  job.child = null;
  await publish(runtime);
  job.resolve(result);
  pump(runtime, repository);
};

// A job that left the queue before it started is not a result: it never replaces
// the latest result, and only its own client receives its terminal.
const settleUnstarted = async (
  runtime: DaemonRuntime,
  repository: MutableRepository,
  job: Job,
  terminal: Terminal,
): Promise<void> => {
  const result = shutdownTerminal(runtime, terminal);
  const finished = await runtime.store.finish(job.id);
  if (!finished.ok) {
    repository.blocked ??= `request journal cleanup failed: ${finished.error}`;
  }
  await retire(runtime, repository.repository.path, result);
  job.child = null;
  await publish(runtime);
  job.resolve(result);
};

const settleBlocked = async (
  runtime: DaemonRuntime,
  repository: MutableRepository,
  blocked: string,
): Promise<void> => {
  for (
    let job = repository.queue.shift();
    job !== undefined;
    job = repository.queue.shift()
  ) {
    await settleUnstarted(runtime, repository, job, {
      ...failedTerminal(job, `repository is blocked: ${blocked}`),
      kind: "failure",
      code: 1,
    });
  }
};

const pump = (runtime: DaemonRuntime, repository: MutableRepository): void => {
  if (runtime.closed || repository.active !== null) return;
  if (repository.blocked !== null) {
    void settleBlocked(runtime, repository, repository.blocked);
    return;
  }
  const job = repository.queue.shift();
  if (job === undefined) return;
  job.started = new Date().toISOString();
  repository.active = job;
  void runtime.store.begin(job.id, job.started).then((begun) =>
    begun.ok ? publish(runtime) : begun
  ).then((published) =>
    published.ok
      ? runWorkerProcess(runtime, job)
      : failedTerminal(job, `snapshot write failed: ${published.error}`)
  ).then((terminal) => complete(runtime, repository, job, terminal)).catch(
    async (error) => {
      await complete(runtime, repository, job, failedTerminal(job, message(error)));
    },
  );
};

const cancelQueued = async (
  runtime: DaemonRuntime,
  job: Job,
  reason: "SIGINT" | "SIGTERM",
): Promise<void> => {
  const index = job.repository.queue.indexOf(job);
  if (index < 0) {
    signalWorker(job, reason);
    return;
  }
  job.repository.queue.splice(index, 1);
  job.cancelReason = reason;
  await settleUnstarted(runtime, job.repository, job, failedTerminal(job, reason));
};

const registeredRepository = async (
  runtime: DaemonRuntime,
  path: string,
): Promise<Result<MutableRepository>> => {
  if (runtime.closed) return err("daemon is closed");
  const stopped = Promise.withResolvers<Result<string>>();
  const abort = () => stopped.resolve(err("daemon is closed"));
  runtime.shutdown.signal.addEventListener("abort", abort, { once: true });
  if (runtime.shutdown.signal.aborted) abort();
  let real: Result<string>;
  try {
    real = await Promise.race([runtime.resolvePath(path), stopped.promise]);
  } finally {
    runtime.shutdown.signal.removeEventListener("abort", abort);
  }
  if (runtime.closed) return err("daemon is closed");
  if (!real.ok) return err(`repository is unavailable: ${real.error}`);
  const repository = Array.from(runtime.repositories.values()).find((state) =>
    state.repository.path === real.value.replace(/\/$/, "")
  );
  if (repository?.removing) return err("repository is being unregistered");
  if (repository === undefined) return err("repository is not registered");
  repository.accepting++;
  return ok(repository);
};

const newJob = (
  id: string,
  repository: MutableRepository,
  request: Extract<Request, { readonly op: "submit" }>,
  plan: Plan,
  shell: string,
  log: string,
  control: string,
  owner: Owner,
): Job => {
  let resolve = (_terminal: Terminal): void => {};
  const result = new Promise<Terminal>((done) => resolve = done);
  return {
    id,
    repository,
    workflow: request.workflow,
    plan,
    inherited: { ...request.env },
    shell,
    started: new Date().toISOString(),
    log,
    control,
    owner,
    result,
    resolve,
    stop: new AbortController(),
    step: null,
    child: null,
    cancelReason: null,
    storageError: null,
  };
};

const watchSubmission = async (
  runtime: DaemonRuntime,
  messages: AsyncGenerator<Result<unknown>>,
  job: Job,
): Promise<void> => {
  const inbound = (async () => {
    for await (const received of messages) {
      if (!received.ok) break;
      const decoded = decodeRequest(received.value);
      if (!decoded.ok || decoded.value.op !== "cancel") break;
      await cancelQueued(runtime, job, decoded.value.reason);
    }
    job.owner.connected = false;
    if (job.repository.active === job || job.repository.queue.includes(job)) {
      await cancelQueued(runtime, job, "SIGTERM");
    }
  })();
  const terminal = await job.result;
  if (job.owner.connected) {
    await sendJson(job.owner.connection, {
      version: 1,
      type: "result",
      result: terminal,
    });
  }
  await inbound;
  await release(runtime, job.id);
  closeConnection(job.owner.connection);
};

const prepareSubmission = async (
  runtime: DaemonRuntime,
  connection: Deno.UnixConn,
  request: Extract<Request, { readonly op: "submit" }>,
  repository: MutableRepository,
): Promise<Job | null> => {
  if (repository.blocked !== null) {
    await sendJson(connection, responseError("unavailable", repository.blocked));
    closeConnection(connection);
    return null;
  }
  const planned = planWorkflow(request.source, request.job);
  if (!planned.ok) {
    await sendJson(connection, responseError("invalid", planned.error));
    closeConnection(connection);
    return null;
  }
  const shell = await resolveBash(
    repository.repository.path,
    request.env.PATH ?? "",
  );
  if (!shell.ok) {
    await sendJson(connection, responseError("unavailable", shell.error));
    closeConnection(connection);
    return null;
  }
  const id = crypto.randomUUID();
  const allocated = await runtime.store.allocate(repository.repository.path, id);
  if (!allocated.ok) {
    await sendJson(connection, responseError("storage", allocated.error));
    closeConnection(connection);
    return null;
  }
  const owner: Owner = { connection, connected: true };
  const job = newJob(
    id,
    repository,
    request,
    planned.value,
    shell.value,
    allocated.value.log,
    allocated.value.control,
    owner,
  );
  const pending: PendingRequest = {
    id,
    repositoryId: repository.repository.id,
    workflow: request.workflow,
    job: request.job,
    started: job.started,
    log: job.log,
    total: job.plan.steps.length,
    begun: false,
  };
  const accepted = await runtime.store.accept(pending);
  if (!accepted.ok) {
    await runtime.store.removeRun(repository.repository.path, id);
    await sendJson(connection, responseError("storage", accepted.error));
    closeConnection(connection);
    return null;
  }
  if (runtime.closed) {
    await runtime.store.finish(id);
    await runtime.store.removeRun(repository.repository.path, id);
    closeConnection(connection);
    return null;
  }
  repository.queue.push(job);
  const published = await publish(runtime);
  if (!published.ok) {
    repository.queue.splice(repository.queue.indexOf(job), 1);
    await runtime.store.finish(id);
    await runtime.store.removeRun(repository.repository.path, id);
    await sendJson(connection, responseError("storage", published.error));
    closeConnection(connection);
    return null;
  }
  hold(runtime, id);
  const sent = await sendJson(connection, {
    version: 1,
    type: "accepted",
    id,
    log: job.log,
  });
  if (!sent.ok) {
    owner.connected = false;
    await cancelQueued(runtime, job, "SIGTERM");
    await release(runtime, id);
    closeConnection(connection);
    return null;
  }
  pump(runtime, repository);
  return job;
};

const submitRequest = async (
  runtime: DaemonRuntime,
  connection: Deno.UnixConn,
  messages: AsyncGenerator<Result<unknown>>,
  request: Extract<Request, { readonly op: "submit" }>,
): Promise<void> => {
  // Requests for one path text keep their arrival order. Other paths do not wait.
  const reservation = (runtime.routing.get(request.path) ?? Promise.resolve()).then(() =>
    registeredRepository(runtime, request.path)
  );
  const settled = reservation.then(() => {}, () => {});
  runtime.routing.set(request.path, settled);
  void settled.then(() => {
    if (runtime.routing.get(request.path) === settled) {
      runtime.routing.delete(request.path);
    }
  });
  const reserved = await reservation;
  if (!reserved.ok) {
    await sendJson(connection, responseError("unregistered", reserved.error));
    closeConnection(connection);
    return;
  }
  const repository = reserved.value;
  const prepared = repository.acceptance.then(() =>
    prepareSubmission(runtime, connection, request, repository)
  );
  repository.acceptance = prepared.then(() => {}, () => {});
  // The queue or the active slot blocks unregister until the result. The result frame
  // follows this decrement, so a client that keeps its connection open cannot cause busy.
  void prepared.then((job) => job?.result, () => {}).then(() => {
    repository.accepting--;
  });
  const job = await prepared;
  if (job !== null) await watchSubmission(runtime, messages, job);
};

const okResponse = (runtime: DaemonRuntime): Response => ({
  version: 1,
  type: "ok",
  snapshot: snapshot(runtime),
});

const manageRepositories = async (
  runtime: DaemonRuntime,
  request: Extract<Request, { readonly op: "register" | "unregister" }>,
): Promise<Response> => {
  if (request.op === "register") {
    const registered = await runtime.store.register(request.path);
    if (!registered.ok) return responseError("storage", registered.error);
    if (runtime.repositories.has(registered.value.id)) return okResponse(runtime);
    const state: MutableRepository = {
      repository: registered.value,
      queue: [],
      active: null,
      latest: null,
      blocked: null,
      accepting: 0,
      acceptance: Promise.resolve(),
      removing: false,
    };
    const recovered = await recoverWorkspace(registered.value.path);
    // A busy lock is not a block: the worker recovers the workspace before each job.
    if (!recovered.ok) state.blocked = recovered.error;
    const latest = await runtime.store.readLatest(registered.value);
    if (!latest.ok) state.blocked ??= latest.error;
    else state.latest = latest.value;
    runtime.repositories.set(registered.value.id, state);
    const published = await publish(runtime);
    return published.ok ? okResponse(runtime) : responseError("storage", published.error);
  }
  const state = Array.from(runtime.repositories.values()).find((candidate) =>
    candidate.repository.id === request.repository ||
    candidate.repository.path === request.repository
  );
  if (state === undefined) {
    return responseError("unregistered", "repository is not registered");
  }
  if (state.active !== null || state.queue.length > 0 || state.accepting > 0) {
    return responseError("busy", "repository has accepted requests");
  }
  state.removing = true;
  const removed = await runtime.store.unregister(state.repository.id);
  if (removed.ok) runtime.repositories.delete(state.repository.id);
  else state.removing = false;
  const published = removed.ok ? await publish(runtime) : removed;
  return published.ok ? okResponse(runtime) : responseError("storage", published.error);
};

const handleOperation = async (
  runtime: DaemonRuntime,
  connection: Deno.UnixConn,
  messages: AsyncGenerator<Result<unknown>>,
  request: Request,
): Promise<void> => {
  if (request.op === "submit") {
    await submitRequest(runtime, connection, messages, request);
    return;
  }
  if (request.op === "cancel") {
    await sendJson(
      connection,
      responseError("invalid", "cancel requires a submission connection"),
    );
  } else {
    await sendJson(connection, okResponse(runtime));
  }
  closeConnection(connection);
};

const handleRequest = (
  runtime: DaemonRuntime,
  connection: Deno.UnixConn,
  messages: AsyncGenerator<Result<unknown>>,
  request: Request,
): Promise<void> => {
  if (request.op !== "register" && request.op !== "unregister") {
    return handleOperation(runtime, connection, messages, request);
  }
  const operation = runtime.management.then(() =>
    runtime.closed ? null : manageRepositories(runtime, request)
  );
  runtime.management = operation.then(() => {}, () => {});
  // The chain ends before the send, so a client that does not read cannot stall it.
  return operation.then(async (response) => {
    if (response !== null) await sendJson(connection, response);
    closeConnection(connection);
  });
};

const firstMessage = async (
  runtime: DaemonRuntime,
  messages: AsyncGenerator<Result<unknown>>,
): Promise<IteratorResult<Result<unknown>> | null> => {
  const expired = Promise.withResolvers<null>();
  const timer = setTimeout(() => expired.resolve(null), runtime.requestDeadlineMs);
  try {
    return await Promise.race([messages.next(), expired.promise]);
  } finally {
    clearTimeout(timer);
  }
};

const handleConnection = async (
  runtime: DaemonRuntime,
  connection: Deno.UnixConn,
): Promise<void> => {
  const messages = readJson(connection);
  const first = await firstMessage(runtime, messages);
  if (first === null) {
    closeConnection(connection);
    return;
  }
  if (first.done) {
    closeConnection(connection);
    return;
  }
  if (!first.value.ok) {
    await sendJson(connection, responseError("invalid", first.value.error));
    closeConnection(connection);
    return;
  }
  const request = decodeRequest(first.value.value);
  if (!request.ok) {
    await sendJson(connection, responseError("invalid", request.error));
    closeConnection(connection);
    return;
  }
  await handleRequest(runtime, connection, messages, request.value);
};

const prepareRuntime = async (
  store: DaemonStore,
  resolvePath: (path: string) => Promise<Result<string>>,
  requestDeadlineMs: number,
): Promise<Result<DaemonRuntime>> => {
  const runtime: DaemonRuntime = {
    store,
    instance: crypto.randomUUID(),
    repositories: new Map(),
    holds: new Map(),
    obsolete: new Map(),
    management: Promise.resolve(),
    routing: new Map(),
    resolvePath,
    shutdown: new AbortController(),
    requestDeadlineMs,
    closed: false,
  };
  for (const repository of store.repositories()) {
    const state: MutableRepository = {
      repository,
      queue: [],
      active: null,
      latest: null,
      blocked: null,
      accepting: 0,
      acceptance: Promise.resolve(),
      removing: false,
    };
    const recovered = await recoverWorkspace(repository.path);
    if (!recovered.ok) state.blocked = recovered.error;
    const latest = await store.readLatest(repository);
    if (!latest.ok) state.blocked ??= latest.error;
    else state.latest = latest.value;
    runtime.repositories.set(repository.id, state);
  }
  const durableLatest = new Map(
    Array.from(runtime.repositories.values()).map((state) =>
      [state.repository.id, state.latest] as const
    ),
  );
  for (const pending of [...store.pending()]) {
    const state = runtime.repositories.get(pending.repositoryId);
    if (state === undefined) continue;
    const saved = await store.readTerminal(state.repository, pending.id);
    if (!saved.ok) {
      state.blocked ??= `completed request recovery failed: ${saved.error}`;
      continue;
    }
    const priorLatest = durableLatest.get(state.repository.id);
    const completed = saved.value ??
      (priorLatest?.id === pending.id ? priorLatest : null);
    if (completed !== null) {
      if (state.latest === null || completed.finished >= state.latest.finished) {
        const projected = await store.writeTerminal(state.repository.path, completed);
        if (!projected.ok) {
          state.blocked ??= `completed request projection failed: ${projected.error}`;
          continue;
        }
        state.latest = completed;
      }
      const finished = await store.finish(pending.id);
      if (!finished.ok) {
        state.blocked ??= `request journal cleanup failed: ${finished.error}`;
      }
      continue;
    }
    if (!pending.begun) {
      const finished = await store.finish(pending.id);
      if (!finished.ok) {
        state.blocked ??= `request journal cleanup failed: ${finished.error}`;
      }
      continue;
    }
    const interrupted: Terminal = {
      id: pending.id,
      repositoryId: pending.repositoryId,
      workflow: pending.workflow,
      job: pending.job,
      started: pending.started,
      finished: finishTime(pending.started, new Date().toISOString()),
      kind: "interrupted",
      code: 143,
      completed: 0,
      total: pending.total,
      detail: "The daemon stopped before the worker returned a result.",
      log: pending.log,
    };
    const recorded = await store.writeTerminal(state.repository.path, interrupted);
    if (!recorded.ok) {
      state.blocked = `interrupted request storage failed: ${recorded.error}`;
      continue;
    }
    const previous = state.latest;
    state.latest = interrupted;
    const finished = await store.finish(pending.id);
    if (!finished.ok) state.blocked = `request journal cleanup failed: ${finished.error}`;
    await retire(runtime, state.repository.path, previous);
  }
  for (const state of runtime.repositories.values()) {
    const keep = store.pending().filter((pending) =>
      pending.repositoryId === state.repository.id
    ).map((pending) => pending.id);
    if (state.latest !== null) keep.push(state.latest.id);
    const pruned = await store.pruneRuns(state.repository.path, keep);
    if (!pruned.ok) state.blocked ??= `request retention failed: ${pruned.error}`;
  }
  const published = await publish(runtime);
  return published.ok ? ok(runtime) : published;
};

export type DaemonListener = {
  readonly accept: () => Promise<Deno.UnixConn>;
  readonly close: () => void;
};

// A policy value, not a measured capacity.
const defaultRequestDeadlineMs = 5000;
const firstAcceptBackoffMs = 50;
const maximumAcceptBackoffMs = 1000;
const defaultAcceptFailureLimitMs = 60000;

export const startDaemon = async (options: {
  readonly listen?: (path: string) => DaemonListener;
  readonly requestDeadlineMs?: number;
  readonly acceptFailureLimitMs?: number;
  readonly directory?: string;
  readonly signal?: AbortSignal;
  readonly openStore?: (paths: ServicePaths) => Promise<Result<DaemonStore>>;
  readonly resolvePath?: (path: string) => Promise<Result<string>>;
} = {}): Promise<
  Result<{
    readonly closed: Promise<Result<void>>;
    readonly close: () => Promise<void>;
    readonly snapshot: () => Snapshot;
  }>
> => {
  const resolved = servicePaths(options.directory);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  const made = await attempt(() =>
    Deno.mkdir(paths.directory, { recursive: true, mode: 0o700 })
  );
  if (!made.ok) return made;
  const directory = await attempt(() => Deno.lstat(paths.directory));
  if (!directory.ok) return directory;
  if (!directory.value.isDirectory || directory.value.isSymlink) {
    return err("daemon directory must be a real directory");
  }
  const privateDirectory = await attempt(() => Deno.chmod(paths.directory, 0o700));
  if (!privateDirectory.ok) return privateDirectory;
  const lockPath = `${paths.directory}/daemon.lock`;
  const lockInfo = await attempt(async () => {
    try {
      return await Deno.lstat(lockPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  });
  if (!lockInfo.ok) return lockInfo;
  if (lockInfo.value !== null && (!lockInfo.value.isFile || lockInfo.value.isSymlink)) {
    return err("daemon lock must be a real file");
  }
  const openedLock = await attempt(() =>
    Deno.open(lockPath, { create: true, read: true, write: true, mode: 0o600 })
  );
  if (!openedLock.ok) return openedLock;
  const lock = openedLock.value;
  const locked = await attempt(() => lock.tryLock(true));
  if (!locked.ok || !locked.value) {
    lock.close();
    return err(locked.ok ? "daemon is already running" : locked.error);
  }
  const privateLock = await attempt(() => Deno.chmod(lockPath, 0o600));
  if (!privateLock.ok) {
    lock.close();
    return privateLock;
  }
  const store = await (options.openStore ?? openDaemonStore)(paths);
  if (!store.ok) {
    lock.close();
    return store;
  }
  const runtime = await prepareRuntime(
    store.value,
    options.resolvePath ?? ((path) => attempt(() => Deno.realPath(path))),
    options.requestDeadlineMs ?? defaultRequestDeadlineMs,
  );
  if (!runtime.ok) {
    lock.close();
    return runtime;
  }
  const oldSocket = await attempt(async () => {
    try {
      return await Deno.lstat(paths.socket);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  });
  if (!oldSocket.ok) {
    lock.close();
    return oldSocket;
  }
  if (oldSocket.value !== null) {
    if (!oldSocket.value.isSocket) {
      lock.close();
      return err("daemon socket path is not a socket");
    }
    const removed = await attempt(() => Deno.remove(paths.socket));
    if (!removed.ok) {
      lock.close();
      return removed;
    }
  }
  const listened = await attempt(() =>
    (options.listen ?? ((path) => Deno.listen({ transport: "unix", path })))(paths.socket)
  );
  if (!listened.ok) {
    lock.close();
    return listened;
  }
  const listener = listened.value;
  const connections = new Set<Deno.UnixConn>();
  const handlers = new Set<Promise<void>>();
  const privateSocket = await attempt(() => Deno.chmod(paths.socket, 0o600));
  if (!privateSocket.ok) {
    listener.close();
    await attempt(() => Deno.remove(paths.socket));
    lock.close();
    return privateSocket;
  }
  let cancelBackoff = (): void => {};
  const backoff = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      cancelBackoff = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const acceptFailureLimitMs = options.acceptFailureLimitMs ??
    defaultAcceptFailureLimitMs;
  // The accept loop resolves with a failure only when it stops on its own.
  const accepting = (async (): Promise<string | null> => {
    let wait = 0;
    let failingSince: number | null = null;
    while (!runtime.value.closed) {
      const accepted = await attempt(() => listener.accept());
      if (!accepted.ok) {
        if (runtime.value.closed) break;
        const now = performance.now();
        failingSince ??= now;
        const lasted = Math.round(now - failingSince);
        if (lasted >= acceptFailureLimitMs) {
          console.error(`mci daemon: accept failed for ${lasted} ms; stopping`);
          return `accept failed for ${lasted} ms: ${accepted.error}`;
        }
        console.error(`mci daemon: accept failed: ${accepted.error}`);
        wait = wait === 0
          ? firstAcceptBackoffMs
          : Math.min(wait * 2, maximumAcceptBackoffMs);
        await backoff(wait);
        continue;
      }
      wait = 0;
      failingSince = null;
      if (runtime.value.closed) {
        closeConnection(accepted.value);
        break;
      }
      connections.add(accepted.value);
      const handler = handleConnection(runtime.value, accepted.value).catch(() => {
        closeConnection(accepted.value);
      }).finally(() => {
        connections.delete(accepted.value);
        handlers.delete(handler);
      });
      handlers.add(handler);
    }
    return null;
  })();
  let closeResolve = (_result: Result<void>): void => {};
  const closed = new Promise<Result<void>>((resolve) => closeResolve = resolve);
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    closing = (async () => {
      runtime.value.closed = true;
      runtime.value.shutdown.abort("daemon is closed");
      try {
        listener.close();
      } catch { /* The listener is already closed. */ }
      cancelBackoff();
      for (const connection of connections) closeConnection(connection);
      const jobs = Array.from(runtime.value.repositories.values()).flatMap((state) => [
        ...(state.active === null ? [] : [state.active]),
        ...state.queue,
      ]);
      await Promise.all(jobs.map((job) => cancelQueued(runtime.value, job, "SIGTERM")));
      await Promise.all(jobs.map((job) => job.result));
      const failure = await accepting;
      await Promise.all(handlers);
      await attempt(() => Deno.remove(paths.socket));
      lock.close();
      closeResolve(failure === null ? ok(undefined) : err(failure));
    })();
    return closing;
  };
  // close() awaits the accept loop, so only a callback after the loop may call it.
  void accepting.then((failure) => {
    if (failure !== null) void close();
  });
  const abort = () => void close();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) void close();
  return ok({ closed, close, snapshot: () => snapshot(runtime.value) });
};

export const runDaemon = async (): Promise<number> => {
  const controller = new AbortController();
  const stopInt = () => controller.abort("SIGINT");
  const stopTerm = () => controller.abort("SIGTERM");
  Deno.addSignalListener("SIGINT", stopInt);
  Deno.addSignalListener("SIGTERM", stopTerm);
  const started = await startDaemon({ signal: controller.signal });
  if (!started.ok) {
    console.error(`mci daemon: ${started.error}`);
    Deno.removeSignalListener("SIGINT", stopInt);
    Deno.removeSignalListener("SIGTERM", stopTerm);
    return 1;
  }
  const stopped = await started.value.closed;
  Deno.removeSignalListener("SIGINT", stopInt);
  Deno.removeSignalListener("SIGTERM", stopTerm);
  if (!stopped.ok) {
    console.error(`mci daemon: ${stopped.error}`);
    return 1;
  }
  return 0;
};
