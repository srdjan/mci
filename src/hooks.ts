// @light-fp adapter
import { captureCommand } from "./command.ts";
import { findBrew } from "./homebrew.ts";
import { attempt, err, ok, type Result } from "./result.ts";
import { planWorkflow } from "./workflow.ts";

const hookName = "pre-commit";
const taskName = "mci:ci";

type JsonObject = Readonly<Record<string, unknown>>;

export type HookCapabilities = {
  readonly brewPrefix: () => Promise<Result<string>>;
  readonly git: (args: readonly string[]) => Promise<Result<string>>;
};

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const command = async (
  executable: string,
  args: readonly string[],
): Promise<
  Result<{ readonly code: number; readonly stdout: string; readonly stderr: string }>
> => {
  const output = await captureCommand(executable, { args: [...args] }, {
    timeoutMs: 120000,
    reapMs: 1000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
  });
  if (!output.ok) return output;
  return ok({
    code: output.value.status.code,
    stdout: new TextDecoder().decode(output.value.stdout).trim(),
    stderr: new TextDecoder().decode(output.value.stderr).trim(),
  });
};

const nativeGit = async (args: readonly string[]): Promise<Result<string>> => {
  const result = await command("/usr/bin/git", args);
  if (!result.ok) return result;
  return result.value.code === 0
    ? ok(result.value.stdout)
    : err(result.value.stderr || `/usr/bin/git exited with ${result.value.code}`);
};

const nativeBrewPrefix = async (): Promise<Result<string>> => {
  const brew = await findBrew();
  if (!brew.ok) return brew;
  const result = await command(brew.value, ["--prefix", "--installed", "mci"]);
  if (!result.ok) return result;
  if (result.value.code !== 0 || !result.value.stdout.startsWith("/")) {
    return err(
      result.value.stderr ||
        "Homebrew has no installed mci formula. Run brew install first.",
    );
  }
  return ok(result.value.stdout.replace(/\/+$/, ""));
};

export const nativeHookCapabilities: HookCapabilities = {
  brewPrefix: nativeBrewPrefix,
  git: nativeGit,
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const hookTask = (binary: string, workflow: string, job: string): string =>
  `${shellQuote(binary)} ci ${shellQuote(workflow)} --job ${shellQuote(job)}`;

export const hookScript = `#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
exec deno task ${taskName}
`;

const setupWorkflow = "ci/local-ci.yml";
const setupJob = "check";
const standardTaskNames = ["fmt:check", "lint", "check", "test"] as const;

const setupWorkflowSource = (tasks: readonly string[]): string =>
  `name: Local validation
on: workflow_dispatch
defaults:
  run:
    shell: bash
jobs:
  check:
    runs-on: macos-latest
    steps:
${
    tasks.map((task) => `      - name: Run ${task}\n        run: deno task ${task}`).join(
      "\n",
    )
  }
`;

const gitHookNames = new Set(
  `
applypatch-msg commit-msg fsmonitor-watchman post-applypatch post-checkout
post-commit post-index-change post-merge post-receive post-rewrite post-update
pre-applypatch pre-auto-gc pre-commit pre-merge-commit pre-push pre-rebase
pre-receive prepare-commit-msg proc-receive push-to-checkout
reference-transaction sendemail-validate update
`.trim().split(/\s+/),
);

const missing = (error: string): boolean => error.includes("No such file");
const missingGitValue = (error: string): boolean => error.endsWith("exited with 1");

const fileState = async (path: string): Promise<Result<"absent" | "file">> => {
  const info = await attempt(() => Deno.lstat(path));
  if (!info.ok) return missing(info.error) ? ok("absent") : err(info.error);
  return info.value.isFile && !info.value.isSymlink
    ? ok("file")
    : err(`${path} is not a regular file.`);
};

// Writes a temporary file, then renames it over the target or links it as a new target.
const writeFileAtomic = async (
  path: string,
  content: string,
  mode: number,
  exclusive = false,
): Promise<Result<void>> => {
  const temporary = `${path}.mci-${crypto.randomUUID()}.tmp`;
  const written = await attempt(async () => {
    await Deno.writeTextFile(temporary, content, { createNew: true, mode: 0o600 });
    await Deno.chmod(temporary, mode);
    if (exclusive) await Deno.link(temporary, path);
    else await Deno.rename(temporary, path);
  });
  await attempt(() => Deno.remove(temporary));
  return written.ok ? ok(undefined) : err(`Cannot write ${path}: ${written.error}`);
};

type HookConfig = {
  readonly config: JsonObject;
  readonly tasks: JsonObject;
  readonly mode: number;
};

const readConfig = async (root: string): Promise<Result<HookConfig>> => {
  const path = `${root}/deno.json`;
  const info = await attempt(() => Deno.lstat(path));
  if (!info.ok || !info.value.isFile || info.value.isSymlink) {
    return err("The repository must have a regular deno.json file.");
  }
  const text = await attempt(() => Deno.readTextFile(path));
  if (!text.ok) return err(`Cannot read ${path}: ${text.error}`);
  const parsed = await attempt((): unknown => JSON.parse(text.value));
  if (!parsed.ok) return err(`${path} is not valid JSON: ${parsed.error}`);
  if (!object(parsed.value)) return err(`${path} must contain a JSON object.`);
  const tasks = parsed.value.tasks ?? {};
  if (!object(tasks)) return err("deno.json tasks must be an object.");
  return ok({ config: parsed.value, tasks, mode: (info.value.mode ?? 0o644) & 0o7777 });
};

const resolveRoot = async (
  repository: string,
  git: HookCapabilities["git"],
): Promise<Result<string>> => {
  if (!repository.startsWith("/") || repository.includes("\0")) {
    return err("The repository path must be absolute.");
  }
  const real = await attempt(() => Deno.realPath(repository));
  if (!real.ok) return err(`The repository is not available: ${real.error}`);
  const top = await git(["-C", real.value, "rev-parse", "--show-toplevel"]);
  if (!top.ok) return err(`The path is not a Git repository: ${top.error}`);
  const canonical = await attempt(() => Deno.realPath(top.value));
  return canonical.ok && canonical.value === real.value
    ? ok(real.value)
    : err("The repository path must be the Git worktree root.");
};

const checkWorkflow = async (
  root: string,
  workflow: string,
  job: string,
  generated: string | undefined,
): Promise<Result<void>> => {
  if (
    !workflow || workflow.startsWith("/") || workflow.includes("\0") ||
    workflow.split("/").includes("..")
  ) return err("The workflow path must stay inside the repository.");
  if (!job || job.includes("\0")) return err("The job identifier must be nonempty.");
  let source = generated;
  if (source === undefined) {
    const real = await attempt(() => Deno.realPath(`${root}/${workflow}`));
    if (!real.ok || !real.value.startsWith(`${root}/`)) {
      return err("The workflow path does not identify a file inside the repository.");
    }
    const read = await attempt(() => Deno.readTextFile(real.value));
    if (!read.ok) return err(`Cannot read the workflow: ${read.error}`);
    source = read.value;
  }
  const plan = planWorkflow(source, job);
  return plan.ok
    ? ok(undefined)
    : err(`The workflow cannot run job ${job}: ${plan.error}`);
};

type PackagedHooks = {
  readonly binary: string;
  readonly hooksPath: string;
  readonly canonicalHooksPath: string;
};

const validatePackagedHookInstallation = async (
  capabilities: HookCapabilities,
): Promise<Result<PackagedHooks>> => {
  const prefix = await capabilities.brewPrefix();
  if (!prefix.ok) return prefix;
  const binary = `${prefix.value}/bin/mci`;
  const binaryState = await fileState(binary);
  if (!binaryState.ok || binaryState.value !== "file") {
    return err(`The stable Homebrew binary is not available at ${binary}.`);
  }
  const hooksPath = `${prefix.value}/libexec/hooks`;
  const canonicalHooksPath = await attempt(() => Deno.realPath(hooksPath));
  if (!canonicalHooksPath.ok) {
    return err(
      `Cannot resolve the packaged hooks directory: ${canonicalHooksPath.error}`,
    );
  }
  const hookPath = `${hooksPath}/${hookName}`;
  const hookState = await fileState(hookPath);
  if (!hookState.ok || hookState.value !== "file") {
    return err(
      hookState.ok
        ? `The packaged hook is absent at ${hookPath}.`
        : `The packaged hook is invalid: ${hookState.error}`,
    );
  }
  const [text, info] = await Promise.all([
    attempt(() => Deno.readTextFile(hookPath)),
    attempt(() => Deno.stat(hookPath)),
  ]);
  if (!text.ok) return err(`Cannot read the packaged hook: ${text.error}`);
  if (text.value !== hookScript) {
    return err(`The packaged hook at ${hookPath} is not managed by mci.`);
  }
  if (!info.ok || info.value.mode === null || (info.value.mode & 0o111) === 0) {
    return err(`The packaged hook at ${hookPath} is not executable.`);
  }
  return ok({ binary, hooksPath, canonicalHooksPath: canonicalHooksPath.value });
};

// A name counts as active when Git can run it: a symbolic link or an executable file.
const activeHooks = async (directory: string): Promise<Result<readonly string[]>> => {
  const found = await attempt(async () => {
    const names: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
      if (!gitHookNames.has(entry.name)) continue;
      const info = await Deno.lstat(`${directory}/${entry.name}`);
      if (info.isSymlink || (info.isFile && ((info.mode ?? 0) & 0o111) !== 0)) {
        names.push(entry.name);
      }
    }
    return names.sort();
  });
  if (found.ok) return found;
  return missing(found.error)
    ? ok([])
    : err(`Cannot inspect ${directory}: ${found.error}`);
};

// Returns true when the install must set core.hooksPath.
const planHooksPath = async (
  root: string,
  packaged: PackagedHooks,
  git: HookCapabilities["git"],
): Promise<Result<boolean>> => {
  const configured = await git(["-C", root, "config", "--get", "core.hooksPath"]);
  if (configured.ok) {
    if ([packaged.hooksPath, packaged.canonicalHooksPath].includes(configured.value)) {
      return ok(false);
    }
    return err(
      `core.hooksPath already names ${configured.value}. mci does not replace it.`,
    );
  }
  if (!missingGitValue(configured.error)) {
    return err(`Cannot read core.hooksPath: ${configured.error}`);
  }
  const directory = await git([
    "-C",
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks",
  ]);
  if (!directory.ok) {
    return err(`Cannot resolve the Git hooks directory: ${directory.error}`);
  }
  const active = await activeHooks(directory.value);
  if (!active.ok) return active;
  return active.value.length === 0 ? ok(true) : err(
    `The Git hooks directory ${directory.value} holds active hooks that core.hooksPath ` +
      `would disable: ${active.value.join(", ")}. Move or remove them first.`,
  );
};

type Prepared = {
  readonly root: string;
  readonly config: HookConfig;
  readonly task: string;
  readonly hooksPath: string;
  readonly setHooksPath: boolean;
};

// Install steps 2 to 5 checks. This function writes no file.
const prepare = async (
  root: string,
  workflow: string,
  job: string,
  capabilities: HookCapabilities,
  generated?: string,
): Promise<Result<Prepared>> => {
  const checked = await checkWorkflow(root, workflow, job, generated);
  if (!checked.ok) return checked;
  const packaged = await validatePackagedHookInstallation(capabilities);
  if (!packaged.ok) return packaged;
  const setHooksPath = await planHooksPath(root, packaged.value, capabilities.git);
  if (!setHooksPath.ok) return setHooksPath;
  const config = await readConfig(root);
  if (!config.ok) return config;
  const task = hookTask(packaged.value.binary, workflow, job);
  const existing = config.value.tasks[taskName];
  if (existing !== undefined && existing !== task) {
    return err(`deno.json already defines a different ${taskName} task.`);
  }
  return ok({
    root,
    config: config.value,
    task,
    hooksPath: packaged.value.hooksPath,
    setHooksPath: setHooksPath.value,
  });
};

// Install steps 5 and 6. A rerun after a step 6 failure completes the work.
const commit = async (
  { root, config, task, hooksPath, setHooksPath }: Prepared,
  capabilities: HookCapabilities,
): Promise<Result<void>> => {
  const addTask = config.tasks[taskName] === undefined;
  if (addTask) {
    const next = { ...config.config, tasks: { ...config.tasks, [taskName]: task } };
    const written = await writeFileAtomic(
      `${root}/deno.json`,
      `${JSON.stringify(next, null, 2)}\n`,
      config.mode,
    );
    if (!written.ok) return written;
  }
  if (!setHooksPath) return ok(undefined);
  const set = await capabilities.git([
    "-C",
    root,
    "config",
    "--local",
    "core.hooksPath",
    hooksPath,
  ]);
  return set.ok ? ok(undefined) : err(
    `Install step 6 failed (git config --local core.hooksPath): ${set.error}. ${
      addTask ? `deno.json already has the ${taskName} task. ` : ""
    }Run the same command again to finish.`,
  );
};

const ensureGitIgnore = async (root: string): Promise<Result<void>> => {
  const path = `${root}/.gitignore`;
  const state = await fileState(path);
  if (!state.ok) return state;
  if (state.value === "absent") {
    return await writeFileAtomic(path, ".mci/\n", 0o644, true);
  }
  const [text, info] = await Promise.all([
    attempt(() => Deno.readTextFile(path)),
    attempt(() => Deno.lstat(path)),
  ]);
  if (!text.ok) return err(`Cannot read ${path}: ${text.error}`);
  if (!info.ok) return err(`Cannot inspect ${path}: ${info.error}`);
  if (text.value.split(/\r?\n/).some((line) => line === ".mci/" || line === "/.mci/")) {
    return ok(undefined);
  }
  const separator = text.value === "" || text.value.endsWith("\n") ? "" : "\n";
  return await writeFileAtomic(
    path,
    `${text.value}${separator}.mci/\n`,
    (info.value.mode ?? 0o644) & 0o7777,
  );
};

export const installHookWith = async (
  repository: string,
  workflow: string,
  job: string,
  capabilities: HookCapabilities,
): Promise<Result<void>> => {
  const root = await resolveRoot(repository, capabilities.git);
  if (!root.ok) return root;
  const prepared = await prepare(root.value, workflow, job, capabilities);
  return prepared.ok ? await commit(prepared.value, capabilities) : prepared;
};

export const setupHookWith = async (
  repository: string,
  capabilities: HookCapabilities,
): Promise<Result<void>> => {
  const root = await resolveRoot(repository, capabilities.git);
  if (!root.ok) return root;
  const workflowPath = `${root.value}/${setupWorkflow}`;
  const state = await fileState(workflowPath);
  if (!state.ok) return state;
  let generated: string | undefined;
  if (state.value === "absent") {
    const config = await readConfig(root.value);
    if (!config.ok) return config;
    const tasks = standardTaskNames.filter((name) =>
      Object.hasOwn(config.value.tasks, name)
    );
    if (tasks.length === 0) {
      return err(
        "deno.json must define at least one standard task: fmt:check, lint, check, or test.",
      );
    }
    generated = setupWorkflowSource(tasks);
  }
  const prepared = await prepare(
    root.value,
    setupWorkflow,
    setupJob,
    capabilities,
    generated,
  );
  if (!prepared.ok) return prepared;
  if (generated !== undefined) {
    const directory = await attempt(() =>
      Deno.mkdir(`${root.value}/ci`, { recursive: true })
    );
    if (!directory.ok) return err(`Cannot create ${root.value}/ci: ${directory.error}`);
    const resolved = await attempt(() => Deno.realPath(`${root.value}/ci`));
    if (!resolved.ok || resolved.value !== `${root.value}/ci`) {
      return err(`${root.value}/ci must be a directory inside the repository.`);
    }
    const written = await writeFileAtomic(workflowPath, generated, 0o644, true);
    if (!written.ok) return written;
  }
  const ignored = await ensureGitIgnore(root.value);
  if (!ignored.ok) return ignored;
  return await commit(prepared.value, capabilities);
};

export const setupHook = (repository: string): Promise<Result<void>> =>
  setupHookWith(repository, nativeHookCapabilities);

export const installHook = (
  repository: string,
  workflow: string,
  job: string,
): Promise<Result<void>> =>
  installHookWith(repository, workflow, job, nativeHookCapabilities);
