import {
  decodeTerminal,
  finishTime,
  type Repository,
  type Snapshot,
  type Terminal,
} from "./protocol.ts";
import type { ServicePaths } from "./paths.ts";
import { attempt, err, message, ok, type Result } from "./result.ts";

export type PendingRequest = {
  readonly id: string;
  readonly repositoryId: string;
  readonly workflow: string;
  readonly job: string;
  readonly started: string;
  readonly log: string;
  readonly total: number;
  readonly begun: boolean;
};

export type RunFiles = {
  readonly log: string;
  readonly control: string;
};

export type DaemonStore = {
  readonly repositories: () => readonly Repository[];
  readonly register: (path: string) => Promise<Result<Repository>>;
  readonly unregister: (id: string) => Promise<Result<void>>;
  readonly allocate: (path: string, id: string) => Promise<Result<RunFiles>>;
  readonly accept: (request: PendingRequest) => Promise<Result<void>>;
  readonly begin: (id: string, started: string) => Promise<Result<void>>;
  readonly finish: (id: string) => Promise<Result<void>>;
  readonly pending: () => readonly PendingRequest[];
  readonly readLatest: (repository: Repository) => Promise<Result<Terminal | null>>;
  readonly readTerminal: (
    repository: Repository,
    id: string,
  ) => Promise<Result<Terminal | null>>;
  readonly writeTerminal: (path: string, terminal: Terminal) => Promise<Result<void>>;
  readonly writeSnapshot: (snapshot: Snapshot) => Promise<Result<void>>;
  readonly removeRun: (path: string, id: string) => Promise<Result<void>>;
  readonly pruneRuns: (path: string, keep: readonly string[]) => Promise<Result<void>>;
};

const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exact = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const absolute = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && !value.includes("\0");

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");

const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const metadata = async (path: string): Promise<Result<Deno.FileInfo | null>> => {
  try {
    return ok(await Deno.lstat(path));
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? ok(null) : err(message(error));
  }
};

const realDirectory = async (path: string): Promise<Result<void>> => {
  const made = await attempt(() => Deno.mkdir(path, { recursive: true, mode: 0o700 }));
  if (!made.ok) return made;
  const found = await metadata(path);
  if (!found.ok) return found;
  if (found.value === null || !found.value.isDirectory || found.value.isSymlink) {
    return err(`${path} must be a real directory`);
  }
  return await attempt(() => Deno.chmod(path, 0o700));
};

const regularTarget = async (path: string): Promise<Result<void>> => {
  const found = await metadata(path);
  if (!found.ok) return found;
  if (found.value !== null && (!found.value.isFile || found.value.isSymlink)) {
    return err(`${path} must be a real file`);
  }
  return ok(undefined);
};

const parent = (path: string): string => path.slice(0, path.lastIndexOf("/"));

const syncPath = async (path: string, kind: "file" | "directory"): Promise<void> => {
  const handle = await Deno.open(
    path,
    kind === "file" ? { write: true } : { read: true },
  );
  try {
    if (kind === "file") await handle.syncData();
    else await handle.sync();
  } finally {
    handle.close();
  }
};

// A durable commit syncs the file before the rename and the directory after it.
const commitTemporary = async (
  temporary: string,
  target: string,
  durable: boolean,
): Promise<void> => {
  await Deno.chmod(temporary, 0o600);
  if (durable) await syncPath(temporary, "file");
  await Deno.rename(temporary, target);
  if (durable) await syncPath(parent(target), "directory");
};

const atomicBytes = async (
  path: string,
  bytes: Uint8Array,
  durable: boolean,
): Promise<Result<void>> => {
  const safe = await regularTarget(path);
  if (!safe.ok) return safe;
  const temporary = await attempt(() =>
    Deno.makeTempFile({ dir: parent(path), prefix: ".write-" })
  );
  if (!temporary.ok) return temporary;
  const written = await attempt(async () => {
    await Deno.writeFile(temporary.value, bytes);
    await commitTemporary(temporary.value, path, durable);
  });
  if (written.ok) return written;
  await attempt(() => Deno.remove(temporary.value));
  return written;
};

const atomicJson = (
  path: string,
  value: unknown,
  durable = true,
): Promise<Result<void>> =>
  atomicBytes(
    path,
    new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
    durable,
  );

const atomicCopy = async (source: string, target: string): Promise<Result<void>> => {
  const safe = await regularTarget(target);
  if (!safe.ok) return safe;
  const temporary = await attempt(() =>
    Deno.makeTempFile({ dir: parent(target), prefix: ".copy-" })
  );
  if (!temporary.ok) return temporary;
  const copied = await attempt(async () => {
    await Deno.copyFile(source, temporary.value);
    await commitTemporary(temporary.value, target, true);
  });
  if (copied.ok) return copied;
  await attempt(() => Deno.remove(temporary.value));
  return copied;
};

const parseFile = async (path: string): Promise<Result<unknown | null>> => {
  const found = await metadata(path);
  if (!found.ok) return found;
  if (found.value === null) return ok(null);
  if (!found.value.isFile || found.value.isSymlink) {
    return err(`${path} must be a real file`);
  }
  const parsed = await attempt((): unknown => JSON.parse(Deno.readTextFileSync(path)));
  return parsed.ok ? parsed : err(`${path} is not valid JSON: ${parsed.error}`);
};

const repositoryId = async (path: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  return `repo-${
    Array.from(new Uint8Array(digest)).slice(0, 12).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
};

const canonicalDirectory = async (path: string): Promise<Result<string>> => {
  if (!absolute(path)) return err("repository path must be absolute");
  const real = await attempt(() => Deno.realPath(path));
  if (!real.ok) return err(`repository is unavailable: ${real.error}`);
  const found = await attempt(() => Deno.stat(real.value));
  if (!found.ok || !found.value.isDirectory) return err("repository must be a directory");
  return ok(real.value.replace(/\/$/, ""));
};

const decodeRegistry = (value: unknown): Result<readonly Repository[]> => {
  if (
    !object(value) || !exact(value, ["version", "repositories"]) || value.version !== 1 ||
    !Array.isArray(value.repositories)
  ) return err("invalid daemon registry");
  const repositories: Repository[] = [];
  for (const entry of value.repositories) {
    if (
      !object(entry) || !exact(entry, ["id", "path"]) || !nonempty(entry.id) ||
      !absolute(entry.path) || repositories.some((prior) =>
        prior.id === entry.id || prior.path === entry.path
      )
    ) return err("invalid daemon repository");
    repositories.push({ id: entry.id, path: entry.path });
  }
  return ok(repositories);
};

const decodeLegacyRegistry = (value: unknown): Result<readonly string[]> => {
  if (
    !object(value) || !exact(value, ["version", "workspaces"]) || value.version !== 1 ||
    !Array.isArray(value.workspaces) || !value.workspaces.every(absolute)
  ) {
    return err("invalid legacy monitor registry");
  }
  return ok(value.workspaces);
};

const pendingKeys = ["id", "repositoryId", "workflow", "job", "started", "log", "total"];

// A journal from an older daemon has no begun key. It decodes as begun.
const decodePending = (value: unknown): Result<PendingRequest> => {
  if (
    !object(value) ||
    !(exact(value, pendingKeys) ||
      (exact(value, [...pendingKeys, "begun"]) && typeof value.begun === "boolean")) ||
    !nonempty(value.id) || !nonempty(value.repositoryId) || !nonempty(value.workflow) ||
    !nonempty(value.job) || !timestamp(value.started) || !absolute(value.log) ||
    typeof value.total !== "number" || !Number.isSafeInteger(value.total) ||
    value.total < 0
  ) return err("invalid accepted request journal entry");
  return ok({
    id: value.id,
    repositoryId: value.repositoryId,
    workflow: value.workflow,
    job: value.job,
    started: value.started,
    log: value.log,
    total: value.total,
    begun: value.begun !== false,
  });
};

const decodeJournal = (value: unknown): Result<readonly PendingRequest[]> => {
  if (
    !object(value) || !exact(value, ["version", "requests"]) || value.version !== 1 ||
    !Array.isArray(value.requests)
  ) return err("invalid request journal");
  const requests: PendingRequest[] = [];
  for (const item of value.requests) {
    const decoded = decodePending(item);
    if (!decoded.ok) return decoded;
    if (requests.some((prior) => prior.id === decoded.value.id)) {
      return err("duplicate accepted request journal entry");
    }
    requests.push(decoded.value);
  }
  return ok(requests);
};

const decodeLegacyTerminal = (
  value: unknown,
  repository: Repository,
  log: string,
): Result<Terminal | null> => {
  if (!object(value) || value.version !== 1) return ok(null);
  const expected = Object.hasOwn(value, "logger") ? 7 : 6;
  if (
    Object.keys(value).length !== expected || !nonempty(value.state) ||
    typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
    !timestamp(value.started)
  ) return err("invalid legacy CI status");
  if (
    Object.hasOwn(value, "logger") && value.logger !== null && (
      !object(value.logger) || !exact(value.logger, ["started", "command"]) ||
      !nonempty(value.logger.started) || !nonempty(value.logger.command)
    )
  ) return err("invalid legacy CI logger");
  if (value.state === "running") {
    if (value.finished !== null || value.code !== null) {
      return err("invalid legacy running status");
    }
    return ok({
      id: `legacy-${value.pid}-${value.started.replaceAll(/[^0-9]/g, "")}`,
      repositoryId: repository.id,
      workflow: "legacy",
      job: "legacy",
      started: value.started,
      finished: finishTime(value.started, new Date().toISOString()),
      kind: "interrupted",
      code: 143,
      completed: 0,
      total: 0,
      detail: "The daemon found an unfinished legacy run.",
      log,
    });
  }
  if (
    (value.state !== "pass" && value.state !== "fail" && value.state !== "cancelled") ||
    !timestamp(value.finished) ||
    Date.parse(value.finished) < Date.parse(value.started) ||
    typeof value.code !== "number" ||
    !Number.isSafeInteger(value.code) || value.code < 0 ||
    (value.state === "pass" ? value.code !== 0 : value.code === 0)
  ) return err("invalid legacy terminal status");
  return ok({
    id: `legacy-${value.pid}-${value.started.replaceAll(/[^0-9]/g, "")}`,
    repositoryId: repository.id,
    workflow: "legacy",
    job: "legacy",
    started: value.started,
    finished: value.finished,
    kind: value.state === "pass"
      ? "success"
      : value.state === "cancelled"
      ? "cancelled"
      : "failure",
    code: value.code,
    completed: 0,
    total: 0,
    detail: "Imported from the legacy CI status.",
    log,
  });
};

const requestDirectory = (path: string): string => `${path}/.mci/ci/requests`;

const presentDirectory = async (path: string): Promise<Result<boolean>> => {
  const found = await metadata(path);
  if (!found.ok) return found;
  if (found.value === null) return ok(false);
  if (!found.value.isDirectory || found.value.isSymlink) {
    return err(`${path} must be a real directory`);
  }
  return ok(true);
};

// An interrupted atomic write leaves its temporary file. Older daemons used .latest- for
// the latest.log copy. Only the daemon that holds the service lock writes these prefixes,
// and the sweep runs before the listener opens.
const temporary = (name: string): boolean =>
  [".write-", ".copy-", ".latest-"].some((prefix) => name.startsWith(prefix));

const removeTemporaries = async (directory: string): Promise<Result<void>> => {
  const present = await presentDirectory(directory);
  if (!present.ok) return present;
  if (!present.value) return ok(undefined);
  return await attempt(async () => {
    for await (const entry of Deno.readDir(directory)) {
      if (!entry.isFile || entry.isSymlink || !temporary(entry.name)) continue;
      await Deno.remove(`${directory}/${entry.name}`);
    }
  });
};

const prepareRequestDirectory = async (path: string): Promise<Result<string>> => {
  for (const directory of [`${path}/.mci`, `${path}/.mci/ci`, requestDirectory(path)]) {
    const ready = await realDirectory(directory);
    if (!ready.ok) return ready;
  }
  return ok(requestDirectory(path));
};

const createPrivateFile = async (path: string): Promise<Result<void>> => {
  const opened = await attempt(() =>
    Deno.open(path, { createNew: true, write: true, mode: 0o600 })
  );
  if (!opened.ok) return opened;
  const closed = await attempt(() => opened.value.close());
  return closed.ok ? ok(undefined) : closed;
};

export const openDaemonStore = async (
  paths: ServicePaths,
): Promise<Result<DaemonStore>> => {
  const ready = await realDirectory(paths.directory);
  if (!ready.ok) return ready;
  const swept = await removeTemporaries(paths.directory);
  if (!swept.ok) return swept;
  let repositories: readonly Repository[];
  const storedRegistry = await parseFile(paths.registry);
  if (!storedRegistry.ok) return storedRegistry;
  if (storedRegistry.value !== null) {
    const decoded = decodeRegistry(storedRegistry.value);
    if (!decoded.ok) return decoded;
    repositories = decoded.value;
  } else {
    const legacyPath = `${paths.directory}/monitor.json`;
    const legacy = await parseFile(legacyPath);
    if (!legacy.ok) return legacy;
    const imported: Repository[] = [];
    if (legacy.value !== null) {
      const decoded = decodeLegacyRegistry(legacy.value);
      if (!decoded.ok) return decoded;
      for (const path of decoded.value) {
        const saved = path.replace(/\/$/, "");
        if (!imported.some((entry) => entry.path === saved)) {
          imported.push({ id: await repositoryId(saved), path: saved });
        }
      }
    }
    repositories = imported;
    const recorded = await atomicJson(paths.registry, { version: 1, repositories });
    if (!recorded.ok) return recorded;
  }

  const storedJournal = await parseFile(paths.journal);
  if (!storedJournal.ok) return storedJournal;
  let journal: readonly PendingRequest[] = [];
  if (storedJournal.value !== null) {
    const decoded = decodeJournal(storedJournal.value);
    if (!decoded.ok) return decoded;
    journal = decoded.value;
  }
  let journalChain = Promise.resolve<Result<void>>(ok(undefined));
  const mutateJournal = (
    change: (current: readonly PendingRequest[]) => readonly PendingRequest[],
  ): Promise<Result<void>> => {
    const update = journalChain.then(async () => {
      const next = change(journal);
      const written = await atomicJson(paths.journal, { version: 1, requests: next });
      if (written.ok) journal = [...next];
      return written;
    });
    journalChain = update;
    return update;
  };
  let registryChain = Promise.resolve<Result<void>>(ok(undefined));
  const mutateRegistry = (
    change: (current: readonly Repository[]) => Result<readonly Repository[]>,
  ): Promise<Result<readonly Repository[]>> => {
    const updated = registryChain.then(
      async (): Promise<Result<readonly Repository[]>> => {
        const next = change(repositories);
        if (!next.ok) return next;
        const written = await atomicJson(paths.registry, {
          version: 1,
          repositories: next.value,
        });
        if (!written.ok) return written;
        repositories = [...next.value];
        return ok(repositories);
      },
    );
    registryChain = updated.then((result) => result.ok ? ok(undefined) : result);
    return updated;
  };
  let snapshotChain = Promise.resolve<Result<void>>(ok(undefined));
  const terminalChains = new Map<string, Promise<Result<void>>>();

  return ok({
    repositories: () => repositories,
    register: async (path) => {
      const canonical = await canonicalDirectory(path);
      if (!canonical.ok) return canonical;
      const repository = {
        id: await repositoryId(canonical.value),
        path: canonical.value,
      };
      const written = await mutateRegistry((current) => {
        const prior = current.find((entry) => entry.path === canonical.value);
        if (prior !== undefined) return ok(current);
        if (current.some((entry) => entry.id === repository.id)) {
          return err("repository identifier collision");
        }
        return ok([...current, repository]);
      });
      if (!written.ok) return written;
      return ok(
        written.value.find((entry) => entry.path === canonical.value) ?? repository,
      );
    },
    unregister: async (id) => {
      const updated = await mutateRegistry((current) => {
        const next = current.filter((entry) => entry.id !== id);
        return next.length === current.length
          ? err("repository is not registered")
          : ok(next);
      });
      return updated.ok ? ok(undefined) : updated;
    },
    allocate: async (path, id) => {
      if (!/^[A-Za-z0-9._-]+$/.test(id)) return err("invalid request identifier");
      const directory = await prepareRequestDirectory(path);
      if (!directory.ok) return directory;
      const files = {
        log: `${directory.value}/${id}.log`,
        control: `${directory.value}/${id}.jsonl`,
      };
      const log = await createPrivateFile(files.log);
      if (!log.ok) return log;
      const control = await createPrivateFile(files.control);
      if (control.ok) return ok(files);
      await attempt(() => Deno.remove(files.log));
      return control;
    },
    accept: (request) => mutateJournal((current) => [...current, request]),
    begin: (id, started) =>
      mutateJournal((current) =>
        current.map((request) =>
          request.id === id ? { ...request, started, begun: true } : request
        )
      ),
    finish: (id) =>
      mutateJournal((current) => current.filter((request) => request.id !== id)),
    pending: () => journal,
    readTerminal: async (repository, id) => {
      if (!/^[A-Za-z0-9._-]+$/.test(id)) return err("invalid request identifier");
      const saved = await parseFile(`${requestDirectory(repository.path)}/${id}.json`);
      if (!saved.ok) return saved;
      if (saved.value === null) return ok(null);
      const terminal = decodeTerminal(saved.value);
      if (!terminal.ok) return terminal;
      return terminal.value.id === id && terminal.value.repositoryId === repository.id
        ? terminal
        : err("terminal belongs to another request or repository");
    },
    readLatest: async (repository) => {
      const reference = await parseFile(`${repository.path}/.mci/ci/latest.json`);
      if (!reference.ok) return reference;
      if (reference.value !== null) {
        const terminal = decodeTerminal(reference.value);
        if (!terminal.ok) return terminal;
        return terminal.value.repositoryId === repository.id
          ? terminal
          : err("terminal belongs to another repository");
      }
      const legacy = await parseFile(`${repository.path}/.mci/ci/status.json`);
      if (!legacy.ok) return legacy;
      if (legacy.value === null) return ok(null);
      const decoded = decodeLegacyTerminal(
        legacy.value,
        repository,
        `${repository.path}/.mci/ci/latest.log`,
      );
      if (!decoded.ok || decoded.value === null) return decoded;
      const foundLog = await metadata(decoded.value.log);
      if (!foundLog.ok) return foundLog;
      if (foundLog.value === null || !foundLog.value.isFile || foundLog.value.isSymlink) {
        return err("legacy CI log must be a real file");
      }
      const allocated = await prepareRequestDirectory(repository.path);
      if (!allocated.ok) return allocated;
      const immutableLog = `${allocated.value}/${decoded.value.id}.log`;
      const copied = await atomicCopy(decoded.value.log, immutableLog);
      if (!copied.ok) return copied;
      const terminal = { ...decoded.value, log: immutableLog };
      const recorded = await atomicJson(
        `${repository.path}/.mci/ci/latest.json`,
        terminal,
      );
      return recorded.ok ? ok(terminal) : recorded;
    },
    writeTerminal: (path, terminal) => {
      const prior = terminalChains.get(path) ?? Promise.resolve(ok(undefined));
      const update = prior.then(async () => {
        const directory = await prepareRequestDirectory(path);
        if (!directory.ok) return directory;
        // A missing spool log counts as an empty log, so recovery can finish the entry.
        const logFound = await metadata(terminal.log);
        if (!logFound.ok) return logFound;
        if (
          logFound.value === null &&
          terminal.log === `${directory.value}/${terminal.id}.log`
        ) {
          const created = await createPrivateFile(terminal.log);
          if (!created.ok) return created;
        }
        const durable = await atomicJson(
          `${directory.value}/${terminal.id}.json`,
          terminal,
        );
        if (!durable.ok) return durable;
        const reference = await atomicJson(`${path}/.mci/ci/latest.json`, terminal);
        if (!reference.ok) return reference;
        const projected = await atomicCopy(terminal.log, `${path}/.mci/ci/latest.log`);
        if (!projected.ok) return projected;
        return await atomicJson(`${path}/.mci/ci/status.json`, {
          version: 2,
          ...terminal,
        });
      });
      terminalChains.set(path, update);
      void update.finally(() => {
        if (terminalChains.get(path) === update) terminalChains.delete(path);
      });
      return update;
    },
    writeSnapshot: (snapshot) => {
      const update = snapshotChain.then(() =>
        atomicJson(paths.snapshot, snapshot, false)
      );
      snapshotChain = update;
      return update;
    },
    pruneRuns: async (path, keep) => {
      const mci = await presentDirectory(`${path}/.mci`);
      if (!mci.ok) return mci;
      if (mci.value) {
        const swept = await removeTemporaries(`${path}/.mci/ci`);
        if (!swept.ok) return swept;
      }
      const directory = requestDirectory(path);
      const found = await presentDirectory(directory);
      if (!found.ok) return found;
      if (!found.value) return ok(undefined);
      const safe = await prepareRequestDirectory(path);
      if (!safe.ok) return safe;
      return await attempt(async () => {
        for await (const entry of Deno.readDir(directory)) {
          if (!entry.isFile || entry.isSymlink) continue;
          const match = /^(.*)\.(log|jsonl|json)$/.exec(entry.name);
          const stale = match !== null && !keep.includes(match[1]!);
          if (!stale && !temporary(entry.name)) continue;
          await Deno.remove(`${directory}/${entry.name}`);
        }
      });
    },
    removeRun: async (path, id) => {
      const directory = requestDirectory(path);
      const entries = await attempt(() => Array.fromAsync(Deno.readDir(directory)));
      if (!entries.ok) {
        return entries.error.includes("NotFound") ? ok(undefined) : entries;
      }
      const failures: string[] = [];
      for (const entry of entries.value) {
        if (!entry.name.startsWith(`${id}.`) && !entry.name.startsWith(`${id}-`)) {
          continue;
        }
        if (!entry.isFile || entry.isSymlink) {
          failures.push(`unsafe request artifact: ${entry.name}`);
          continue;
        }
        const removed = await attempt(() => Deno.remove(`${directory}/${entry.name}`));
        if (!removed.ok) failures.push(removed.error);
      }
      return failures.length === 0 ? ok(undefined) : err(failures.join("; "));
    },
  });
};
