// @light-fp adapter
import { captureCommand } from "./command.ts";
import { findBrew } from "./homebrew.ts";
import { attempt, err, ok, type Result } from "./result.ts";
import { type Plan, planWorkflow } from "./workflow.ts";

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

const gitHookNames = new Set([
  "applypatch-msg",
  "commit-msg",
  "fsmonitor-watchman",
  "post-applypatch",
  "post-checkout",
  "post-commit",
  "post-index-change",
  "post-merge",
  "post-receive",
  "post-rewrite",
  "post-update",
  "pre-applypatch",
  "pre-auto-gc",
  "pre-commit",
  "pre-merge-commit",
  "pre-push",
  "pre-rebase",
  "pre-receive",
  "prepare-commit-msg",
  "proc-receive",
  "push-to-checkout",
  "reference-transaction",
  "sendemail-validate",
  "update",
]);

export type HookCancellationReason =
  | { readonly tag: "timeout"; readonly timeoutMs: number }
  | { readonly tag: "SIGINT" }
  | { readonly tag: "SIGTERM" };

export type HookOperationOptions = {
  readonly signal?: AbortSignal;
};

export type HookSetupOptions = HookOperationOptions & {
  readonly replacePrePush?: boolean;
};

const cancellationDetail = (signal: AbortSignal | undefined): string | null => {
  if (signal?.aborted !== true) return null;
  const reason: unknown = signal.reason;
  if (!object(reason) || typeof reason.tag !== "string") {
    return "Hook setup was cancelled for an unknown reason.";
  }
  if (reason.tag === "SIGINT" || reason.tag === "SIGTERM") {
    return `Hook setup was cancelled by ${reason.tag}.`;
  }
  return reason.tag === "timeout" && typeof reason.timeoutMs === "number"
    ? `Hook setup timed out after ${reason.timeoutMs} ms.`
    : "Hook setup was cancelled for an unknown reason.";
};

type HookMigration = {
  readonly configured: string | null;
  readonly activeHooks: string;
};

type ShellWord = { readonly value: string; readonly literal: boolean };
type TaskInvocation =
  | { readonly kind: "root"; readonly name: string }
  | { readonly kind: "opaque"; readonly name: string };

// This scanner covers literal command positions, not the complete shell grammar.
const shellCommands = (script: string): readonly (readonly ShellWord[])[] => {
  const commands: ShellWord[][] = [];
  let words: ShellWord[] = [];
  let value = "";
  let literal = true;
  let started = false;
  let quote = "";
  const finishWord = () => {
    if (started) words.push({ value, literal: literal && quote === "" });
    value = "";
    literal = true;
    started = false;
  };
  const finishCommand = () => {
    finishWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let index = 0; index < script.length; index++) {
    const character = script.charAt(index);
    if (character === "\\" && quote !== "'") {
      started = true;
      const next = script[++index];
      if (next === undefined) literal = false;
      else if (next !== "\n") value += next;
    } else if (quote) {
      if (character === quote) quote = "";
      else {
        value += character;
        if (quote === '"' && (character === "$" || character === "`")) literal = false;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "#" && !started) {
      while (index < script.length && script[index] !== "\n") index++;
      finishCommand();
    } else if ("\n;&|()".includes(character)) {
      finishCommand();
    } else if (/\s/.test(character)) {
      finishWord();
    } else {
      value += character;
      started = true;
      if (character === "$" || character === "`") literal = false;
    }
  }
  finishCommand();
  return commands;
};

const inspectInvocations = (
  script: string,
  repository: string,
): { readonly tasks: readonly TaskInvocation[]; readonly mciCi: boolean } => {
  const tasks: TaskInvocation[] = [];
  let mciCi = false;
  for (const words of shellCommands(script)) {
    const executable = words[0];
    if (!executable?.literal) continue;
    if (
      (executable.value === "mci" || executable.value.endsWith("/mci")) &&
      words[1]?.literal && words[1].value === "ci"
    ) mciCi = true;
    if (executable.value !== "deno" || !words[1]?.literal || words[1].value !== "task") {
      continue;
    }
    let opaque = false;
    for (let index = 2; index < words.length; index++) {
      const word = words[index];
      if (!word?.literal) break;
      if (word.value === "--") {
        const task = words[index + 1];
        if (task?.literal) {
          tasks.push({ kind: opaque ? "opaque" : "root", name: task.value });
        }
        break;
      }
      if (!word.value.startsWith("-")) {
        tasks.push({ kind: opaque ? "opaque" : "root", name: word.value });
        break;
      }
      const equals = word.value.indexOf("=");
      const short = /^-[cfj].+/.test(word.value);
      const option = short
        ? word.value.slice(0, 2)
        : equals >= 0
        ? word.value.slice(0, equals)
        : word.value;
      const attached = short
        ? word.value.slice(2)
        : equals >= 0
        ? word.value.slice(equals + 1)
        : undefined;
      if (
        ["--cwd", "--config", "-c", "--filter", "-f", "--jobs", "-j"].includes(option)
      ) {
        const argument = attached === undefined
          ? words[++index]
          : { value: attached, literal: true };
        if (!argument?.literal) break;
        if (option === "--config" || option === "-c") {
          if (
            !["deno.json", "./deno.json", `${repository}/deno.json`].includes(
              argument.value,
            )
          ) opaque = true;
        } else if (option === "--cwd") {
          if (![".", "./", repository].includes(argument.value)) opaque = true;
        } else if (option === "--filter" || option === "-f") opaque = true;
      } else if (option === "--lock") {
        // Deno 2.9.7 consumes a separate optional lock value, unlike the other optional flags.
        const next = words[index + 1];
        if (attached === undefined && next && !next.value.startsWith("-")) index++;
      } else if (["-r", "--recursive", "--members", "--eval"].includes(option)) {
        opaque = true;
      } else if (
        ![
          "--env-file",
          "--node-modules-dir",
          "--frozen-lockfile",
          "--if-present",
          "--no-prefix",
          "--no-lock",
        ].includes(option)
      ) {
        opaque = true;
      }
    }
  }
  return { tasks, mciCi };
};

const recursiveInvocations = (
  invocations: ReturnType<typeof inspectInvocations>,
): boolean =>
  invocations.mciCi ||
  invocations.tasks.some(({ name }) => name === "ci" || name === "mci:ci");

const regularFile = async (path: string): Promise<Result<"absent" | "file">> => {
  const info = await attempt(() => Deno.lstat(path));
  if (!info.ok) {
    return info.error.includes("No such file") ? ok("absent") : err(info.error);
  }
  return info.value.isFile && !info.value.isSymlink
    ? ok("file")
    : err(`${path} is not a regular file.`);
};

type HookConfiguration = {
  readonly config: JsonObject;
  readonly tasks: JsonObject;
};

const readConfig = async (path: string): Promise<Result<HookConfiguration>> => {
  const read = await attempt(() => Deno.readTextFile(path));
  if (!read.ok) return err(`Cannot read ${path}: ${read.error}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value);
  } catch (error) {
    return err(
      `${path} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!object(parsed)) return err(`${path} must contain a JSON object.`);
  const currentTasks = parsed.tasks;
  if (currentTasks !== undefined && !object(currentTasks)) {
    return err("deno.json tasks must be an object.");
  }
  return ok({
    config: parsed,
    tasks: object(currentTasks) ? currentTasks : {},
  });
};

const missingGitValue = (result: Result<string>): boolean =>
  !result.ok && result.error.endsWith("exited with 1");

type RepositoryRoot = {
  readonly path: string;
  readonly rootFailure: string | undefined;
};

const inspectRepositoryRoot = async (
  repository: string,
  capabilities: HookCapabilities,
): Promise<Result<RepositoryRoot>> => {
  const real = await attempt(() => Deno.realPath(repository));
  if (!real.ok) return err(`The repository is not available: ${real.error}`);
  const root = await capabilities.git(["-C", real.value, "rev-parse", "--show-toplevel"]);
  if (!root.ok) {
    return ok({
      path: real.value,
      rootFailure: `The path is not a Git repository: ${root.error}`,
    });
  }
  const canonicalRoot = await attempt(() => Deno.realPath(root.value));
  return ok({
    path: real.value,
    rootFailure: !canonicalRoot.ok || canonicalRoot.value !== real.value
      ? "The repository path must be the Git worktree root."
      : undefined,
  });
};

const extensionConfigName = "extensions.worktreeConfig";
const extensionConfigPattern = "^extensions\\.worktreeConfig$";

const parseNullGitValues = (
  source: string,
): Result<readonly (string | null)[]> => {
  if (!source.endsWith("\0")) {
    return err("Git returned malformed null-delimited configuration output.");
  }
  const values: (string | null)[] = [];
  for (const record of source.slice(0, -1).split("\0")) {
    const separator = record.indexOf("\n");
    const key = separator === -1 ? record : record.slice(0, separator);
    if (key.toLowerCase() !== extensionConfigName.toLowerCase()) {
      return err("Git returned an unexpected configuration record.");
    }
    values.push(separator === -1 ? null : record.slice(separator + 1));
  }
  return ok(values);
};

const readRawExtensionValues = async (
  repository: string,
  capabilities: HookCapabilities,
): Promise<Result<readonly (string | null)[]>> => {
  const result = await capabilities.git([
    "-C",
    repository,
    "config",
    "--local",
    "--null",
    "--get-regexp",
    extensionConfigPattern,
  ]);
  if (missingGitValue(result)) return ok([]);
  if (!result.ok) return result;
  return parseNullGitValues(result.value);
};

const validateTasks = (
  tasks: JsonObject,
  selected: readonly string[],
  repository: string,
  mode: "strict" | "existing-workflow",
): Result<void> => {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string, selectedTask: string): Result<void> => {
    if (visiting.has(name)) {
      return err(
        `The selected task ${selectedTask} has a recursive Deno task dependency through ${name}.`,
      );
    }
    if (visited.has(name)) return ok(undefined);
    if (!Object.hasOwn(tasks, name)) {
      return mode === "existing-workflow"
        ? ok(undefined)
        : err(`deno.json must define a nonempty string task named ${name}.`);
    }
    const script = tasks[name];
    if (typeof script !== "string" || !script.trim() || script.includes("\0")) {
      return err(`deno.json must define a nonempty string task named ${name}.`);
    }
    const invocations = inspectInvocations(script, repository);
    if (recursiveInvocations(invocations)) {
      return err(
        `The selected task ${selectedTask} reaches ${name}, which would recurse through mci CI.`,
      );
    }
    visiting.add(name);
    for (const dependency of invocations.tasks) {
      if (dependency.kind !== "root") continue;
      const checked = visit(dependency.name, selectedTask);
      if (!checked.ok) return checked;
    }
    visiting.delete(name);
    visited.add(name);
    return ok(undefined);
  };
  for (const name of selected) {
    const checked = visit(name, name);
    if (!checked.ok) return checked;
  }
  return ok(undefined);
};

const rootStepDirectory = (directory: string): boolean =>
  directory.split("/").every((part) => part === "" || part === ".");

const validateSelectedJob = (
  plan: Plan,
  tasks: JsonObject,
  repository: string,
): Result<void> => {
  const selected: string[] = [];
  for (const step of plan.steps) {
    const invocations = inspectInvocations(step.script, repository);
    if (recursiveInvocations(invocations)) {
      return err("The workflow job invokes mci CI and would recurse through the hook.");
    }
    if (!rootStepDirectory(step.directory)) continue;
    for (const invocation of invocations.tasks) {
      if (invocation.kind === "root") selected.push(invocation.name);
    }
  }
  return validateTasks(tasks, selected, repository, "existing-workflow");
};

const readHookWorkflowPlan = async (
  path: string,
  job: string,
): Promise<Result<Plan>> => {
  const source = await attempt(() => Deno.readTextFile(path));
  if (!source.ok) return err(`Cannot read the workflow: ${source.error}`);
  const plan = planWorkflow(source.value, job);
  return plan.ok ? plan : err(`The workflow cannot run job ${job}: ${plan.error}`);
};

type PackagedHookReadDiagnostic = "specific-read-error" | "not-managed";

type PackagedHookInstallation = {
  readonly binary: string;
  readonly hooksPath: string;
  readonly canonicalHooksPath: string;
};

const validatePackagedHookInstallation = async (
  capabilities: HookCapabilities,
  readDiagnostic: PackagedHookReadDiagnostic,
): Promise<Result<PackagedHookInstallation>> => {
  const prefix = await capabilities.brewPrefix();
  if (!prefix.ok) return prefix;
  const binary = `${prefix.value}/bin/mci`;
  const binaryState = await regularFile(binary);
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
  const packagedHookPath = `${hooksPath}/${hookName}`;
  const packagedHookState = await regularFile(packagedHookPath);
  if (!packagedHookState.ok || packagedHookState.value !== "file") {
    return err(
      packagedHookState.ok
        ? `The packaged hook is absent at ${packagedHookPath}.`
        : `The packaged hook is invalid: ${packagedHookState.error}`,
    );
  }
  const packagedHook = await attempt(() => Deno.readTextFile(packagedHookPath));
  if (!packagedHook.ok) {
    return err(
      readDiagnostic === "specific-read-error"
        ? `Cannot read the packaged hook: ${packagedHook.error}`
        : `The packaged hook at ${packagedHookPath} is not managed by mci.`,
    );
  }
  if (packagedHook.value !== hookScript) {
    return err(`The packaged hook at ${packagedHookPath} is not managed by mci.`);
  }
  const packagedHookInfo = await attempt(() => Deno.stat(packagedHookPath));
  if (
    !packagedHookInfo.ok || packagedHookInfo.value.mode === null ||
    (packagedHookInfo.value.mode & 0o111) === 0
  ) return err(`The packaged hook at ${packagedHookPath} is not executable.`);
  return ok({
    binary,
    hooksPath,
    canonicalHooksPath: canonicalHooksPath.value,
  });
};

const requireDirectory = async (
  path: string,
): Promise<Result<"existing" | "created">> => {
  const state = await attempt(() => Deno.lstat(path));
  if (state.ok) {
    if (!state.value.isDirectory || state.value.isSymlink) {
      return err(`${path} must be a regular directory.`);
    }
    const canonical = await attempt(() => Deno.realPath(path));
    return !canonical.ok || canonical.value !== path
      ? err(`${path} must not redirect outside the repository.`)
      : ok("existing");
  }
  if (!state.error.includes("No such file")) {
    return err(`Cannot inspect ${path}: ${state.error}`);
  }
  const created = await attempt(() => Deno.mkdir(path));
  if (created.ok) return ok("created");
  const raced = await attempt(() => Deno.lstat(path));
  if (!raced.ok || !raced.value.isDirectory || raced.value.isSymlink) {
    return err(`Cannot create ${path}: ${created.error}`);
  }
  const canonical = await attempt(() => Deno.realPath(path));
  return !canonical.ok || canonical.value !== path
    ? err(`${path} must not redirect outside the repository.`)
    : ok("existing");
};

type CreatedFile = {
  readonly kind: "created";
  readonly path: string;
  readonly directory: string;
  readonly createdDirectory: boolean;
  readonly device: number | null;
  readonly inode: number | null;
  readonly expectedContent: string;
};

const writeNewAtomic = async (
  path: string,
  content: string,
  createdDirectory: boolean,
): Promise<Result<CreatedFile>> => {
  const temporary = `${path}.mci-${crypto.randomUUID()}.tmp`;
  const created = await attempt(async () => {
    await Deno.writeTextFile(temporary, content, { createNew: true });
    const info = await Deno.lstat(temporary);
    await Deno.link(temporary, path);
    return {
      kind: "created" as const,
      path,
      directory: path.slice(0, path.lastIndexOf("/")),
      createdDirectory,
      device: info.dev,
      inode: info.ino,
      expectedContent: content,
    };
  });
  await attempt(() => Deno.remove(temporary));
  return created.ok
    ? ok(created.value)
    : err(`Cannot create ${path} without overwriting it: ${created.error}`);
};

type GitIgnorePlan =
  | { readonly kind: "none" }
  | { readonly kind: "create"; readonly path: string; readonly content: string }
  | {
    readonly kind: "update";
    readonly path: string;
    readonly before: string;
    readonly after: string;
    readonly mode: number | null;
  };

type UpdatedFile = {
  readonly kind: "updated";
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly mode: number | null;
};

type AppliedGitIgnore = CreatedFile | UpdatedFile;

const planGitIgnore = async (repository: string): Promise<Result<GitIgnorePlan>> => {
  const path = `${repository}/.gitignore`;
  const state = await regularFile(path);
  if (!state.ok) return state;
  if (state.value === "absent") return ok({ kind: "create", path, content: ".mci/\n" });
  const [read, info] = await Promise.all([
    attempt(() => Deno.readTextFile(path)),
    attempt(() => Deno.lstat(path)),
  ]);
  if (!read.ok) return err(`Cannot read ${path}: ${read.error}`);
  if (!info.ok) return err(`Cannot inspect ${path}: ${info.error}`);
  if (read.value.split(/\r?\n/).some((line) => line === ".mci/" || line === "/.mci/")) {
    return ok({ kind: "none" });
  }
  const separator = read.value.length === 0 || read.value.endsWith("\n") ? "" : "\n";
  return ok({
    kind: "update",
    path,
    before: read.value,
    after: `${read.value}${separator}.mci/\n`,
    mode: info.value.mode,
  });
};

const applyGitIgnore = async (
  plan: GitIgnorePlan,
): Promise<Result<AppliedGitIgnore | null>> => {
  if (plan.kind === "none") return ok(null);
  if (plan.kind === "create") return await writeNewAtomic(plan.path, plan.content, false);
  const current = await attempt(() => Deno.readTextFile(plan.path));
  if (!current.ok || current.value !== plan.before) {
    return err(`The repository .gitignore changed during hook setup.`);
  }
  const written = await writeAtomic(plan.path, plan.after, plan.mode ?? undefined);
  return written.ok
    ? ok({
      kind: "updated",
      path: plan.path,
      before: plan.before,
      after: plan.after,
      mode: plan.mode,
    })
    : written;
};

const rollbackGitIgnore = async (change: AppliedGitIgnore): Promise<Result<void>> => {
  if (change.kind === "created") return await rollbackCreatedFile(change);
  const current = await attempt(() => Deno.readTextFile(change.path));
  if (!current.ok || current.value !== change.after) {
    return err(`The repository .gitignore changed before rollback.`);
  }
  return await writeAtomic(change.path, change.before, change.mode ?? undefined);
};

const rollbackCreatedFile = async (created: CreatedFile): Promise<Result<void>> => {
  const [current, content] = await Promise.all([
    attempt(() => Deno.lstat(created.path)),
    attempt(() => Deno.readTextFile(created.path)),
  ]);
  if (
    !current.ok || !content.ok || current.value.isSymlink || !current.value.isFile ||
    current.value.dev !== created.device || current.value.ino !== created.inode ||
    content.value !== created.expectedContent
  ) {
    return err(`The generated file at ${created.path} changed before rollback.`);
  }
  const removed = await attempt(() => Deno.remove(created.path));
  if (!removed.ok) return err(`Cannot remove ${created.path}: ${removed.error}`);
  if (created.createdDirectory) {
    const directoryRemoved = await attempt(() => Deno.remove(created.directory));
    if (!directoryRemoved.ok) {
      return err(`Cannot remove ${created.directory}: ${directoryRemoved.error}`);
    }
  }
  return ok(undefined);
};

const activeExecutableHooks = async (
  directory: string,
): Promise<Result<readonly string[]>> => {
  const state = await attempt(() => Deno.lstat(directory));
  if (!state.ok) {
    return state.error.includes("No such file") ? ok([]) : err(state.error);
  }
  if (!state.value.isDirectory || state.value.isSymlink) {
    return err(`${directory} is not a regular directory.`);
  }
  const found = await attempt(async () => {
    const names: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
      if (!gitHookNames.has(entry.name) || entry.name.endsWith(".sample")) continue;
      const info = await Deno.lstat(`${directory}/${entry.name}`);
      if (info.isSymlink) {
        names.push(entry.name);
        continue;
      }
      if (info.isFile && info.mode !== null && (info.mode & 0o111) !== 0) {
        names.push(entry.name);
      }
    }
    return names.sort();
  });
  return found.ok ? ok(found.value) : err(`Cannot inspect ${directory}: ${found.error}`);
};

const writeAtomic = async (
  path: string,
  content: string,
  mode?: number,
): Promise<Result<void>> => {
  const temporary = `${path}.mci-${crypto.randomUUID()}.tmp`;
  const written = await attempt(async () => {
    await Deno.writeTextFile(temporary, content, {
      createNew: true,
      mode: mode === undefined ? undefined : 0o600,
    });
    if (mode !== undefined) await Deno.chmod(temporary, mode);
    await Deno.rename(temporary, path);
  });
  if (!written.ok) {
    await attempt(() => Deno.remove(temporary));
    return err(`Cannot write ${path}: ${written.error}`);
  }
  return ok(undefined);
};

const rollbackFailure = (
  result: Result<void> | Result<string>,
  target: string,
  recovery: string,
): string =>
  result.ok
    ? ""
    : `\nRollback failed for ${target}: ${result.error}\nRecovery: ${recovery}`;

const installHookWithPolicy = async (
  repository: string,
  workflow: string,
  job: string,
  capabilities: HookCapabilities,
  migration?: HookMigration,
  options: HookOperationOptions = {},
): Promise<Result<void>> => {
  if (!repository.startsWith("/") || repository.includes("\0")) {
    return err("The repository path must be absolute.");
  }
  if (
    !workflow || workflow.startsWith("/") || workflow.includes("\0") ||
    workflow.split("/").includes("..")
  ) {
    return err("The workflow path must stay inside the repository.");
  }
  if (!job || job.includes("\0")) return err("The job identifier must be nonempty.");

  const inspectedRoot = await inspectRepositoryRoot(repository, capabilities);
  if (!inspectedRoot.ok) return inspectedRoot;
  const { path: repositoryPath, rootFailure } = inspectedRoot.value;
  if (rootFailure !== undefined) {
    const marker = await attempt(() => Deno.lstat(`${repositoryPath}/.git`));
    const rootHasGitMarker = marker.ok && !marker.value.isSymlink &&
      (marker.value.isFile || marker.value.isDirectory);
    if (!rootHasGitMarker) return err(rootFailure);
    const gitDirectory = await capabilities.git([
      "-C",
      repositoryPath,
      "rev-parse",
      "--git-dir",
    ]);
    if (!gitDirectory.ok) return err(rootFailure);
  }

  const rawWorktreeExtension = await readRawExtensionValues(
    repositoryPath,
    capabilities,
  );
  if (!rawWorktreeExtension.ok) {
    return err(
      `Cannot read raw extensions.worktreeConfig: ${rawWorktreeExtension.error}`,
    );
  }
  const worktreeExtension = await capabilities.git([
    "-C",
    repositoryPath,
    "config",
    "--local",
    "--type=bool",
    "--get",
    "extensions.worktreeConfig",
  ]);
  if (!worktreeExtension.ok && !worktreeExtension.error.endsWith("exited with 1")) {
    return err(`Cannot read extensions.worktreeConfig: ${worktreeExtension.error}`);
  }
  const worktreeConfigEnabled = worktreeExtension.ok &&
    worktreeExtension.value === "true";
  if (!worktreeConfigEnabled) {
    const sharedWorktree = await capabilities.git([
      "-C",
      repositoryPath,
      "config",
      "--local",
      "--get",
      "core.worktree",
    ]);
    if (!sharedWorktree.ok && !sharedWorktree.error.endsWith("exited with 1")) {
      return err(`Cannot read shared core.worktree: ${sharedWorktree.error}`);
    }
    if (sharedWorktree.ok) {
      return err(
        "Cannot enable worktreeConfig while shared core.worktree is set. " +
          "Move core.worktree to the main config.worktree first.",
      );
    }
    const sharedBare = await capabilities.git([
      "-C",
      repositoryPath,
      "config",
      "--local",
      "--type=bool",
      "--get",
      "core.bare",
    ]);
    if (!sharedBare.ok && !sharedBare.error.endsWith("exited with 1")) {
      return err(`Cannot read shared core.bare: ${sharedBare.error}`);
    }
    if (sharedBare.ok && sharedBare.value === "true") {
      return err(
        "Cannot enable worktreeConfig while shared core.bare is true. " +
          "Move core.bare to the main config.worktree first.",
      );
    }
  }
  if (rootFailure !== undefined) return err(rootFailure);
  const workflowPath = `${repositoryPath}/${workflow}`;
  const canonicalWorkflow = await attempt(() => Deno.realPath(workflowPath));
  if (
    !canonicalWorkflow.ok ||
    !canonicalWorkflow.value.startsWith(`${repositoryPath}/`)
  ) {
    return err("The workflow path does not identify a file inside the repository.");
  }
  const workflowInfo = await regularFile(canonicalWorkflow.value);
  if (!workflowInfo.ok || workflowInfo.value !== "file") {
    return err(workflowInfo.ok ? "The workflow file is absent." : workflowInfo.error);
  }
  const plan = await readHookWorkflowPlan(canonicalWorkflow.value, job);
  if (!plan.ok) return plan;

  const configPath = `${repositoryPath}/deno.json`;
  const configFile = await regularFile(configPath);
  if (!configFile.ok || configFile.value !== "file") {
    return err(`The repository must have a regular deno.json file.`);
  }
  const [oldConfig, configInfo] = await Promise.all([
    attempt(() => Deno.readTextFile(configPath)),
    attempt(() => Deno.lstat(configPath)),
  ]);
  if (!oldConfig.ok) return err(`Cannot read deno.json: ${oldConfig.error}`);
  if (!configInfo.ok) return err(`Cannot inspect deno.json: ${configInfo.error}`);
  const configMode = configInfo.value.mode === null
    ? null
    : configInfo.value.mode & 0o7777;
  const config = await readConfig(configPath);
  if (!config.ok) return config;
  const { config: configuration, tasks } = config.value;
  const verified = validateSelectedJob(plan.value, tasks, repositoryPath);
  if (!verified.ok) return verified;

  const packaged = await validatePackagedHookInstallation(
    capabilities,
    "specific-read-error",
  );
  if (!packaged.ok) return packaged;
  const { binary, hooksPath, canonicalHooksPath } = packaged.value;

  const task = hookTask(binary, workflow, job);
  const existingTask = tasks[taskName];
  if (existingTask !== undefined && existingTask !== task) {
    return err(`deno.json already defines the foreign task ${taskName}.`);
  }

  const commonConfigured = await capabilities.git([
    "-C",
    repositoryPath,
    "config",
    "--local",
    "--get",
    "core.hooksPath",
  ]);
  if (!commonConfigured.ok && !commonConfigured.error.endsWith("exited with 1")) {
    return err(`Cannot read shared core.hooksPath: ${commonConfigured.error}`);
  }
  if (
    commonConfigured.ok &&
    (commonConfigured.value === hooksPath ||
      commonConfigured.value === canonicalHooksPath)
  ) {
    return err(
      `The shared core.hooksPath uses the managed ${commonConfigured.value} path. ` +
        "Remove the shared value before setup so sibling worktrees keep their hooks.",
    );
  }
  const worktreeConfigured = worktreeConfigEnabled
    ? await capabilities.git([
      "-C",
      repositoryPath,
      "config",
      "--worktree",
      "--get",
      "core.hooksPath",
    ])
    : null;
  if (
    worktreeConfigured !== null && !worktreeConfigured.ok &&
    !worktreeConfigured.error.endsWith("exited with 1")
  ) {
    return err(`Cannot read worktree core.hooksPath: ${worktreeConfigured.error}`);
  }
  const configured = await capabilities.git([
    "-C",
    repositoryPath,
    "config",
    "--get",
    "core.hooksPath",
  ]);
  if (!configured.ok && !configured.error.endsWith("exited with 1")) {
    return err(`Cannot read effective core.hooksPath: ${configured.error}`);
  }
  if (
    migration !== undefined &&
    (migration.configured === null
      ? !missingGitValue(configured)
      : !configured.ok || configured.value !== migration.configured)
  ) {
    return err("The effective core.hooksPath changed during hook setup.");
  }

  const activeHooks = await capabilities.git([
    "-C",
    repositoryPath,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks",
  ]);
  if (!activeHooks.ok) {
    return err(`Cannot resolve the active Git hooks directory: ${activeHooks.error}`);
  }
  if (migration !== undefined && activeHooks.value !== migration.activeHooks) {
    return err("The active Git hooks directory changed during hook setup.");
  }
  if (
    configured.ok && activeHooks.value !== canonicalHooksPath &&
    migration === undefined
  ) {
    return err(`core.hooksPath already names ${configured.value}.`);
  }
  const activeHookPath = `${activeHooks.value}/${hookName}`;
  const activeHookState = await regularFile(activeHookPath);
  if (!activeHookState.ok) return activeHookState;
  if (activeHookState.value === "file") {
    const activeHook = await attempt(() => Deno.readTextFile(activeHookPath));
    if (!activeHook.ok) return err(`Cannot read ${activeHookPath}: ${activeHook.error}`);
    const activeHookInfo = await attempt(() => Deno.stat(activeHookPath));
    const inactiveDuringMigration = migration !== undefined && activeHookInfo.ok &&
      activeHookInfo.value.mode !== null && (activeHookInfo.value.mode & 0o111) === 0;
    if (
      activeHook.value !== hookScript &&
      !inactiveDuringMigration
    ) {
      return err(`${activeHookPath} already contains a foreign hook.`);
    }
  }

  const cancelledBeforeMutation = cancellationDetail(options.signal);
  if (cancelledBeforeMutation !== null) return err(cancelledBeforeMutation);

  const configUpdated = existingTask === undefined;
  let configChange: UpdatedFile | undefined;
  if (configUpdated) {
    const nextConfig = {
      ...configuration,
      tasks: { ...tasks, [taskName]: task },
    };
    const currentConfig = await attempt(() => Deno.readTextFile(configPath));
    if (!currentConfig.ok || currentConfig.value !== oldConfig.value) {
      return err("The repository deno.json changed during hook setup.");
    }
    const after = `${JSON.stringify(nextConfig, null, 2)}\n`;
    const wroteConfig = await writeAtomic(configPath, after, configMode ?? undefined);
    if (!wroteConfig.ok) return wroteConfig;
    configChange = {
      kind: "updated",
      path: configPath,
      before: oldConfig.value,
      after,
      mode: configMode,
    };
  }
  const restoreConfig = async (): Promise<Result<void>> => {
    if (configChange === undefined) return ok(undefined);
    const current = await attempt(() => Deno.readTextFile(configPath));
    if (!current.ok || current.value !== configChange.after) {
      return err("The repository deno.json changed before rollback.");
    }
    return await writeAtomic(
      configPath,
      configChange.before,
      configChange.mode ?? undefined,
    );
  };
  const priorExtensionValue: string | null = rawWorktreeExtension.value.length === 1
    ? rawWorktreeExtension.value[0] ?? null
    : null;
  const extensionRecovery = priorExtensionValue !== null
    ? "restore the prior extensions.worktreeConfig value and confirm the setting.\n" +
      `Command:\ngit -C ${shellQuote(repositoryPath)} config --local ` +
      `extensions.worktreeConfig ${shellQuote(priorExtensionValue)}`
    : rawWorktreeExtension.value.length === 0
    ? "remove extensions.worktreeConfig and confirm that it is absent.\n" +
      `Command:\ngit -C ${shellQuote(repositoryPath)} config --local --unset-all ` +
      "extensions.worktreeConfig"
    : "restore every prior extensions.worktreeConfig value in its original order.";
  const restoreExtension = async (): Promise<Result<string>> => {
    const current = await readRawExtensionValues(repositoryPath, capabilities);
    if (!current.ok) {
      return err(
        `Cannot read extensions.worktreeConfig before rollback: ${current.error}`,
      );
    }
    if (current.value.length !== 1 || current.value[0] !== "true") {
      return err("extensions.worktreeConfig changed before rollback.");
    }
    if (priorExtensionValue !== null) {
      return await capabilities.git([
        "-C",
        repositoryPath,
        "config",
        "--local",
        "extensions.worktreeConfig",
        priorExtensionValue,
      ]);
    }
    return rawWorktreeExtension.value.length === 0
      ? await capabilities.git([
        "-C",
        repositoryPath,
        "config",
        "--local",
        "--unset-all",
        "extensions.worktreeConfig",
      ])
      : err("The prior extensions.worktreeConfig values cannot be restored safely.");
  };
  const rollbackInstallation = async (
    detail: string,
    restoreEnabledExtension: boolean,
  ): Promise<Result<void>> => {
    let restoredDetail = detail;
    if (restoreEnabledExtension) {
      const restoredExtension = await restoreExtension();
      restoredDetail += rollbackFailure(
        restoredExtension,
        `extensions.worktreeConfig in ${repositoryPath}`,
        extensionRecovery,
      );
    }
    const restoredConfig = await restoreConfig();
    restoredDetail += rollbackFailure(
      restoredConfig,
      configPath,
      `restore ${shellQuote(configPath)} to its prior contents and confirm the file.`,
    );
    return err(restoredDetail);
  };
  if (configChange !== undefined) {
    const cancelledAfterConfig = cancellationDetail(options.signal);
    if (cancelledAfterConfig !== null) {
      return await rollbackInstallation(cancelledAfterConfig, false);
    }
  }
  let enabledWorktreeConfig = false;
  if (!worktreeConfigEnabled) {
    const enabled = await capabilities.git([
      "-C",
      repositoryPath,
      "config",
      "--local",
      "extensions.worktreeConfig",
      "true",
    ]);
    if (!enabled.ok) {
      const restoredConfig = await restoreConfig();
      return err(
        `Cannot enable worktreeConfig: ${enabled.error}` +
          rollbackFailure(
            restoredConfig,
            configPath,
            `restore ${
              shellQuote(configPath)
            } to its prior contents and confirm the file.`,
          ),
      );
    }
    enabledWorktreeConfig = true;
    const cancelledAfterExtension = cancellationDetail(options.signal);
    if (cancelledAfterExtension !== null) {
      return await rollbackInstallation(cancelledAfterExtension, true);
    }
  }
  const cancelledBeforeCommit = cancellationDetail(options.signal);
  if (cancelledBeforeCommit !== null) {
    return await rollbackInstallation(cancelledBeforeCommit, enabledWorktreeConfig);
  }
  if (
    migration !== undefined || !worktreeConfigEnabled || worktreeConfigured?.ok === false
  ) {
    const set = await capabilities.git([
      "-C",
      repositoryPath,
      "config",
      "--worktree",
      "core.hooksPath",
      hooksPath,
    ]);
    if (!set.ok) {
      return await rollbackInstallation(
        `Cannot set worktree core.hooksPath: ${set.error}`,
        enabledWorktreeConfig,
      );
    }
  }
  return ok(undefined);
};

export const installHookWith = (
  repository: string,
  workflow: string,
  job: string,
  capabilities: HookCapabilities,
  options: HookOperationOptions = {},
): Promise<Result<void>> =>
  installHookWithPolicy(repository, workflow, job, capabilities, undefined, options);

export const setupHookWith = async (
  repository: string,
  capabilities: HookCapabilities,
  options: HookSetupOptions = {},
): Promise<Result<void>> => {
  if (!repository.startsWith("/") || repository.includes("\0")) {
    return err("The repository path must be absolute.");
  }
  const inspectedRoot = await inspectRepositoryRoot(repository, capabilities);
  if (!inspectedRoot.ok) return inspectedRoot;
  const { path: repositoryPath, rootFailure } = inspectedRoot.value;
  if (rootFailure !== undefined) return err(rootFailure);

  const configPath = `${repositoryPath}/deno.json`;
  const configFile = await regularFile(configPath);
  if (!configFile.ok || configFile.value !== "file") {
    return err("The repository must have a regular deno.json file.");
  }
  const config = await readConfig(configPath);
  if (!config.ok) return config;
  const tasks = config.value.tasks;

  const configured = await capabilities.git([
    "-C",
    repositoryPath,
    "config",
    "--get",
    "core.hooksPath",
  ]);
  if (!configured.ok && !missingGitValue(configured)) {
    return err(`Cannot read effective core.hooksPath: ${configured.error}`);
  }
  const activeHooks = await capabilities.git([
    "-C",
    repositoryPath,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "hooks",
  ]);
  if (!activeHooks.ok) {
    return err(`Cannot resolve the active Git hooks directory: ${activeHooks.error}`);
  }

  const selectedStandardTasks = standardTaskNames.filter((name) =>
    Object.hasOwn(tasks, name)
  );

  const repositoryHooks = `${repositoryPath}/.githooks`;
  const repositoryHooksConfigured = configured.ok &&
    activeHooks.value === repositoryHooks;

  const ciPath = `${repositoryPath}/ci`;
  const ciState = await attempt(() => Deno.lstat(ciPath));
  if (ciState.ok) {
    if (!ciState.value.isDirectory || ciState.value.isSymlink) {
      return err(`${ciPath} must be a regular directory.`);
    }
    const canonicalCi = await attempt(() => Deno.realPath(ciPath));
    if (!canonicalCi.ok || canonicalCi.value !== ciPath) {
      return err(`${ciPath} must not redirect outside the repository.`);
    }
  } else if (!ciState.error.includes("No such file")) {
    return err(`Cannot inspect ${ciPath}: ${ciState.error}`);
  }
  const workflowPath = `${repositoryPath}/${setupWorkflow}`;
  const workflowState = await regularFile(workflowPath);
  if (!workflowState.ok) return workflowState;
  const generateWorkflow = workflowState.value === "absent";
  if (generateWorkflow) {
    if (selectedStandardTasks.length === 0) {
      return err(
        "deno.json must define at least one standard task: fmt:check, lint, check, or test.",
      );
    }
    const verified = validateTasks(
      tasks,
      selectedStandardTasks,
      repositoryPath,
      "strict",
    );
    if (!verified.ok) return verified;
  } else {
    const plan = await readHookWorkflowPlan(workflowPath, setupJob);
    if (!plan.ok) return plan;
    const verified = validateSelectedJob(plan.value, tasks, repositoryPath);
    if (!verified.ok) return verified;
  }

  const packaged = await validatePackagedHookInstallation(
    capabilities,
    "not-managed",
  );
  if (!packaged.ok) return packaged;
  const { canonicalHooksPath } = packaged.value;

  let migration: HookMigration | undefined;
  if (activeHooks.value !== canonicalHooksPath) {
    if (configured.ok && !repositoryHooksConfigured) {
      return err(`core.hooksPath already names ${configured.value}.`);
    }
    const active = await activeExecutableHooks(activeHooks.value);
    if (!active.ok) return active;
    for (const name of active.value) {
      if (name === "pre-push") {
        if (options.replacePrePush !== true) {
          return err(
            "The effective pre-push hook is active. Pass --replace-pre-push to replace it for this worktree.",
          );
        }
        continue;
      }
      if (name !== hookName) {
        return err(`The effective ${name} hook would be disabled by mci setup.`);
      }
      const preCommitPath = `${activeHooks.value}/${hookName}`;
      const source = await attempt(() => Deno.readTextFile(preCommitPath));
      if (!source.ok) return err(`Cannot read ${preCommitPath}: ${source.error}`);
      if (source.value !== hookScript) {
        return err(`${preCommitPath} already contains an unsupported pre-commit hook.`);
      }
    }
    migration = {
      configured: configured.ok ? configured.value : null,
      activeHooks: activeHooks.value,
    };
  }
  const ignorePlan = await planGitIgnore(repositoryPath);
  if (!ignorePlan.ok) return ignorePlan;

  const cancelledBeforeMutation = cancellationDetail(options.signal);
  if (cancelledBeforeMutation !== null) return err(cancelledBeforeMutation);

  let generated: CreatedFile | undefined;
  if (generateWorkflow) {
    const directory = await requireDirectory(ciPath);
    if (!directory.ok) return directory;
    const cancelledAfterDirectory = cancellationDetail(options.signal);
    if (cancelledAfterDirectory !== null) {
      if (directory.value === "existing") return err(cancelledAfterDirectory);
      const directoryRollback = await attempt(() => Deno.remove(ciPath));
      return err(
        cancelledAfterDirectory + rollbackFailure(
          directoryRollback,
          ciPath,
          `remove ${
            shellQuote(ciPath)
          } after confirming that the directory is empty and was created by mci.`,
        ),
      );
    }
    const written = await writeNewAtomic(
      workflowPath,
      setupWorkflowSource(selectedStandardTasks),
      directory.value === "created",
    );
    if (!written.ok) {
      if (directory.value === "created") await attempt(() => Deno.remove(ciPath));
      return written;
    }
    generated = written.value;
    const cancelledAfterWorkflow = cancellationDetail(options.signal);
    if (cancelledAfterWorkflow !== null) {
      const workflowRollback = await rollbackCreatedFile(generated);
      return err(
        cancelledAfterWorkflow + rollbackFailure(
          workflowRollback,
          generated.path,
          `remove ${
            shellQuote(generated.path)
          } after confirming that it is still generated by mci.`,
        ),
      );
    }
  }

  const ignored = await applyGitIgnore(ignorePlan.value);
  if (!ignored.ok) {
    if (generated === undefined) return ignored;
    const rolledBack = await rollbackCreatedFile(generated);
    return err(
      ignored.error + rollbackFailure(
        rolledBack,
        generated.path,
        `remove ${
          shellQuote(generated.path)
        } after confirming that it is still generated by mci.`,
      ),
    );
  }

  const rollbackSetup = async (detail: string): Promise<Result<void>> => {
    let restoredDetail = detail;
    if (ignored.value !== null) {
      const ignoredRollback = await rollbackGitIgnore(ignored.value);
      restoredDetail += rollbackFailure(
        ignoredRollback,
        ignored.value.path,
        `restore ${shellQuote(ignored.value.path)} to its prior contents and confirm it.`,
      );
    }
    if (generated !== undefined) {
      const workflowRollback = await rollbackCreatedFile(generated);
      restoredDetail += rollbackFailure(
        workflowRollback,
        generated.path,
        `remove ${
          shellQuote(generated.path)
        } after confirming that it is still generated by mci.`,
      );
    }
    return err(restoredDetail);
  };
  if (ignored.value !== null) {
    const cancelledAfterIgnore = cancellationDetail(options.signal);
    if (cancelledAfterIgnore !== null) {
      return await rollbackSetup(cancelledAfterIgnore);
    }
  }

  const installed = await installHookWithPolicy(
    repositoryPath,
    setupWorkflow,
    setupJob,
    capabilities,
    migration,
    options,
  );
  if (installed.ok) return installed;
  return await rollbackSetup(installed.error);
};

export const setupHook = (
  repository: string,
  options: HookSetupOptions = {},
): Promise<Result<void>> => setupHookWith(repository, nativeHookCapabilities, options);

export const installHook = (
  repository: string,
  workflow: string,
  job: string,
  options: HookOperationOptions = {},
): Promise<Result<void>> =>
  installHookWith(repository, workflow, job, nativeHookCapabilities, options);
