// @light-fp adapter
import { attempt, err, message, ok, type Result } from "../src/result.ts";

/** The registry file that `MonitorCore.Registry` reads, with its lock file beside it. */
export const registryFile = (directory: string): string => `${directory}/monitor.json`;
const lockFile = (directory: string): string => `${directory}/monitor.json.lock`;

const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Same rules as the Swift decoder: exactly two keys, version 1, absolute path strings. */
export const decodeRegistry = (text: string): Result<readonly string[]> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err("The registry is not valid JSON.");
  }
  if (!object(parsed) || Object.keys(parsed).length !== 2) {
    return err("The registry has an unknown format or version.");
  }
  const { version, workspaces } = parsed;
  if (version !== 1 || !Array.isArray(workspaces)) {
    return err("The registry has an unknown format or version.");
  }
  const paths: string[] = [];
  const entries: readonly unknown[] = workspaces;
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.startsWith("/")) {
      return err("The registry holds an entry that is not a path.");
    }
    paths.push(entry);
  }
  return ok(paths);
};

export const encodeRegistry = (workspaces: readonly string[]): string =>
  `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`;

/** The real path of an existing directory. */
export const canonicalDirectory = async (path: string): Promise<Result<string>> => {
  if (!path.startsWith("/")) return err(`The repository path must be absolute: ${path}`);
  const real = await attempt(() => Deno.realPath(path));
  if (!real.ok) return err(`The repository path is not a folder: ${path}`);
  const info = await attempt(() => Deno.stat(real.value));
  if (!info.ok || !info.value.isDirectory) {
    return err(`The repository path is not a folder: ${path}`);
  }
  return ok(real.value);
};

const readRegistry = async (file: string): Promise<Result<readonly string[]>> => {
  try {
    return decodeRegistry(await Deno.readTextFile(file));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return ok([]);
    return err(`Cannot read the registry: ${message(error)}`);
  }
};

const writeRegistry = async (
  directory: string,
  workspaces: readonly string[],
): Promise<Result<void>> => {
  const temporary = `${directory}/monitor.json.${Deno.pid}.${crypto.randomUUID()}.tmp`;
  const written = await attempt(() =>
    Deno.writeTextFile(temporary, encodeRegistry(workspaces), { createNew: true })
  );
  if (!written.ok) return err(`Cannot write the registry: ${written.error}`);
  const renamed = await attempt(() => Deno.rename(temporary, registryFile(directory)));
  if (!renamed.ok) {
    await attempt(() => Deno.remove(temporary));
    return err(`Cannot replace the registry: ${renamed.error}`);
  }
  return ok(undefined);
};

/**
 * Add a canonical workspace to `<directory>/monitor.json`. An exclusive lock on
 * `monitor.json.lock` covers read, validate, write, and rename. Swift takes `flock(2)` on
 * the same file, and the two exclude each other. A malformed registry stays unchanged.
 */
export const addWorkspace = async (
  directory: string,
  path: string,
): Promise<Result<readonly string[]>> => {
  const real = await canonicalDirectory(path);
  if (!real.ok) return real;
  const made = await attempt(() => Deno.mkdir(directory, { recursive: true }));
  if (!made.ok) return err(`Cannot create the registry folder: ${made.error}`);
  const opened = await attempt(() =>
    Deno.open(lockFile(directory), {
      create: true,
      read: true,
      write: true,
      mode: 0o600,
    })
  );
  if (!opened.ok) return err(`Cannot open the registry lock: ${opened.error}`);
  const lock = opened.value;
  try {
    const locked = await attempt(() => lock.lock(true));
    if (!locked.ok) return err(`Cannot lock the registry: ${locked.error}`);
    const current = await readRegistry(registryFile(directory));
    if (!current.ok) return current;
    if (current.value.includes(real.value)) return current;
    const updated = [...current.value, real.value];
    const written = await writeRegistry(directory, updated);
    return written.ok ? ok(updated) : written;
  } finally {
    await attempt(() => lock.unlock());
    lock.close();
  }
};
