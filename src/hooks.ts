// @light-fp adapter
import { rpc } from "./client.ts";
import { captureCommand } from "./command.ts";
import { servicePaths } from "./paths.ts";
import { attempt, err, ok, type Result } from "./result.ts";
import { planWorkflow } from "./workflow.ts";

const legacyHookDirectory = ".mci-hooks";
const hookName = "pre-commit";
const taskName = "mci:ci";
const knownBrews = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] as const;

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

const findBrew = async (): Promise<Result<string>> => {
  for (const path of knownBrews) {
    const info = await attempt(() => Deno.stat(path));
    if (info.ok && info.value.isFile) return ok(path);
  }
  return err("Homebrew was not found at /opt/homebrew or /usr/local.");
};

const nativeBrewPrefix = async (): Promise<Result<string>> => {
  const brew = await findBrew();
  if (!brew.ok) return brew;
  const result = await command(brew.value, ["--prefix", "mci"]);
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

export type HookSetupOptions = {
  readonly replacePrePush?: boolean;
};

type HookMigration = {
  readonly configured: string | null;
  readonly activeHooks: string;
};

const recursiveStep = (script: string): boolean =>
  /(?:^|[\n;&|()])\s*deno\s+task(?:\s+--[^\s]+)*\s+(?:ci|mci:ci)(?:\s|$)/m.test(
    script,
  ) ||
  /(?:^|[\n;&|()])\s*(?:(?:[^\s;&|()]+\/)?mci|'(?:[^']*\/)?mci'|"(?:[^"]*\/)?mci")\s+ci(?:\s|$)/m
    .test(script);

const regularFile = async (path: string): Promise<Result<"absent" | "file">> => {
  const info = await attempt(() => Deno.lstat(path));
  if (!info.ok) {
    return info.error.includes("No such file") ? ok("absent") : err(info.error);
  }
  return info.value.isFile && !info.value.isSymlink
    ? ok("file")
    : err(`${path} is not a regular file.`);
};

const readConfig = async (path: string): Promise<Result<JsonObject>> => {
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
  return object(parsed) ? ok(parsed) : err(`${path} must contain a JSON object.`);
};

const missingGitValue = (result: Result<string>): boolean =>
  !result.ok && result.error.endsWith("exited with 1");

const taskReferences = (script: string): readonly string[] => {
  const references: string[] = [];
  const pattern = /(?:^|[\n;&|()])\s*deno\s+task(?:\s+--[^\s]+)*\s+([^\s;&|()]+)/gm;
  for (const match of script.matchAll(pattern)) {
    const name = match[1]?.replace(/^['"]|['"]$/g, "");
    if (name) references.push(name);
  }
  return references;
};

const validateTasks = (
  tasks: JsonObject,
  selected: readonly string[],
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
    const script = tasks[name];
    if (typeof script !== "string" || !script.trim() || script.includes("\0")) {
      return err(`deno.json must define a nonempty string task named ${name}.`);
    }
    if (recursiveStep(script)) {
      return err(
        `The selected task ${selectedTask} reaches ${name}, which would recurse through mci CI.`,
      );
    }
    visiting.add(name);
    for (const dependency of taskReferences(script)) {
      const checked = visit(dependency, selectedTask);
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
    await Deno.writeTextFile(temporary, content, { createNew: true, mode });
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

  const real = await attempt(() => Deno.realPath(repository));
  if (!real.ok) return err(`The repository is not available: ${real.error}`);
  const root = await capabilities.git(["-C", real.value, "rev-parse", "--show-toplevel"]);
  let rootFailure: string | undefined;
  if (root.ok) {
    const canonicalRoot = await attempt(() => Deno.realPath(root.value));
    if (!canonicalRoot.ok || canonicalRoot.value !== real.value) {
      rootFailure = "The repository path must be the Git worktree root.";
    }
  } else {
    rootFailure = `The path is not a Git repository: ${root.error}`;
  }
  if (rootFailure !== undefined) {
    const marker = await attempt(() => Deno.lstat(`${real.value}/.git`));
    const rootHasGitMarker = marker.ok && !marker.value.isSymlink &&
      (marker.value.isFile || marker.value.isDirectory);
    const gitDirectory = rootHasGitMarker
      ? await capabilities.git(["-C", real.value, "rev-parse", "--git-dir"])
      : root;
    if (!rootHasGitMarker || !gitDirectory.ok) return err(rootFailure);
  }

  const worktreeExtension = await capabilities.git([
    "-C",
    real.value,
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
      real.value,
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
      real.value,
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
  const workflowPath = `${real.value}/${workflow}`;
  const canonicalWorkflow = await attempt(() => Deno.realPath(workflowPath));
  if (
    !canonicalWorkflow.ok ||
    !canonicalWorkflow.value.startsWith(`${real.value}/`)
  ) {
    return err("The workflow path does not identify a file inside the repository.");
  }
  const workflowInfo = await regularFile(canonicalWorkflow.value);
  if (!workflowInfo.ok || workflowInfo.value !== "file") {
    return err(workflowInfo.ok ? "The workflow file is absent." : workflowInfo.error);
  }
  const source = await attempt(() => Deno.readTextFile(canonicalWorkflow.value));
  if (!source.ok) return err(`Cannot read the workflow: ${source.error}`);
  const plan = planWorkflow(source.value, job);
  if (!plan.ok) return err(`The workflow cannot run job ${job}: ${plan.error}`);
  if (plan.value.steps.some((step) => recursiveStep(step.script))) {
    return err("The workflow job invokes mci CI and would recurse through the hook.");
  }

  const prefix = await capabilities.brewPrefix();
  if (!prefix.ok) return prefix;
  const binary = `${prefix.value}/bin/mci`;
  const binaryInfo = await regularFile(binary);
  if (!binaryInfo.ok || binaryInfo.value !== "file") {
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
    return err(`Cannot read the packaged hook: ${packagedHook.error}`);
  }
  if (packagedHook.value !== hookScript) {
    return err(`The packaged hook at ${packagedHookPath} is not managed by mci.`);
  }
  const packagedHookInfo = await attempt(() => Deno.stat(packagedHookPath));
  if (
    !packagedHookInfo.ok || packagedHookInfo.value.mode === null ||
    (packagedHookInfo.value.mode & 0o111) === 0
  ) {
    return err(`The packaged hook at ${packagedHookPath} is not executable.`);
  }

  const configPath = `${real.value}/deno.json`;
  const configFile = await regularFile(configPath);
  if (!configFile.ok || configFile.value !== "file") {
    return err(`The repository must have a regular deno.json file.`);
  }
  const oldConfig = await attempt(() => Deno.readTextFile(configPath));
  if (!oldConfig.ok) return err(`Cannot read deno.json: ${oldConfig.error}`);
  const config = await readConfig(configPath);
  if (!config.ok) return config;
  const currentTasks = config.value.tasks;
  if (currentTasks !== undefined && !object(currentTasks)) {
    return err("deno.json tasks must be an object.");
  }
  const task = hookTask(binary, workflow, job);
  const existingTask = object(currentTasks) ? currentTasks[taskName] : undefined;
  if (existingTask !== undefined && existingTask !== task) {
    return err(`deno.json already defines the foreign task ${taskName}.`);
  }

  const commonConfigured = await capabilities.git([
    "-C",
    real.value,
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
    (commonConfigured.value === legacyHookDirectory ||
      commonConfigured.value === hooksPath ||
      commonConfigured.value === canonicalHooksPath.value)
  ) {
    return err(
      `The shared core.hooksPath uses the managed ${commonConfigured.value} path. ` +
        "Remove the shared value before setup so sibling worktrees keep their hooks.",
    );
  }
  const worktreeConfigured = worktreeConfigEnabled
    ? await capabilities.git([
      "-C",
      real.value,
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
    real.value,
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
    real.value,
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
    configured.ok && activeHooks.value !== canonicalHooksPath.value &&
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

  const configUpdated = existingTask === undefined;
  let configChange: UpdatedFile | undefined;
  if (configUpdated) {
    const nextConfig = {
      ...config.value,
      tasks: { ...(object(currentTasks) ? currentTasks : {}), [taskName]: task },
    };
    const currentConfig = await attempt(() => Deno.readTextFile(configPath));
    if (!currentConfig.ok || currentConfig.value !== oldConfig.value) {
      return err("The repository deno.json changed during hook setup.");
    }
    const after = `${JSON.stringify(nextConfig, null, 2)}\n`;
    const wroteConfig = await writeAtomic(configPath, after);
    if (!wroteConfig.ok) return wroteConfig;
    configChange = {
      kind: "updated",
      path: configPath,
      before: oldConfig.value,
      after,
      mode: null,
    };
  }
  const restoreConfig = async (): Promise<Result<void>> => {
    if (configChange === undefined) return ok(undefined);
    const current = await attempt(() => Deno.readTextFile(configPath));
    if (!current.ok || current.value !== configChange.after) {
      return err("The repository deno.json changed before rollback.");
    }
    return await writeAtomic(configPath, configChange.before);
  };
  let enabledWorktreeConfig = false;
  if (!worktreeConfigEnabled) {
    const enabled = await capabilities.git([
      "-C",
      real.value,
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
  }
  if (
    migration !== undefined || !worktreeConfigEnabled || worktreeConfigured?.ok === false
  ) {
    const set = await capabilities.git([
      "-C",
      real.value,
      "config",
      "--worktree",
      "core.hooksPath",
      hooksPath,
    ]);
    if (!set.ok) {
      const restoredExtension = !enabledWorktreeConfig
        ? ok(undefined)
        : worktreeExtension.ok
        ? await capabilities.git([
          "-C",
          real.value,
          "config",
          "--local",
          "extensions.worktreeConfig",
          worktreeExtension.value,
        ])
        : await capabilities.git([
          "-C",
          real.value,
          "config",
          "--local",
          "--unset-all",
          "extensions.worktreeConfig",
        ]);
      const restoredConfig = await restoreConfig();
      const extensionRecovery = worktreeExtension.ok
        ? "restore the prior extensions.worktreeConfig value and confirm the setting.\n" +
          `Command:\ngit -C ${shellQuote(real.value)} config --local ` +
          `extensions.worktreeConfig ${worktreeExtension.value}`
        : "remove extensions.worktreeConfig and confirm that it is absent.\n" +
          `Command:\ngit -C ${shellQuote(real.value)} config --local --unset-all ` +
          "extensions.worktreeConfig";
      return err(
        `Cannot set worktree core.hooksPath: ${set.error}` +
          rollbackFailure(
            restoredExtension,
            `extensions.worktreeConfig in ${real.value}`,
            extensionRecovery,
          ) +
          rollbackFailure(
            restoredConfig,
            configPath,
            `restore ${
              shellQuote(configPath)
            } to its prior contents and confirm the file.`,
          ),
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
): Promise<Result<void>> =>
  installHookWithPolicy(repository, workflow, job, capabilities);

export const setupHookWith = async (
  repository: string,
  capabilities: HookCapabilities,
  options: HookSetupOptions = {},
): Promise<Result<void>> => {
  if (!repository.startsWith("/") || repository.includes("\0")) {
    return err("The repository path must be absolute.");
  }
  const real = await attempt(() => Deno.realPath(repository));
  if (!real.ok) return err(`The repository is not available: ${real.error}`);
  const root = await capabilities.git(["-C", real.value, "rev-parse", "--show-toplevel"]);
  if (!root.ok) return err(`The path is not a Git repository: ${root.error}`);
  const canonicalRoot = await attempt(() => Deno.realPath(root.value));
  if (!canonicalRoot.ok || canonicalRoot.value !== real.value) {
    return err("The repository path must be the Git worktree root.");
  }

  const configPath = `${real.value}/deno.json`;
  const configFile = await regularFile(configPath);
  if (!configFile.ok || configFile.value !== "file") {
    return err("The repository must have a regular deno.json file.");
  }
  const config = await readConfig(configPath);
  if (!config.ok) return config;
  const currentTasks = config.value.tasks;
  if (currentTasks !== undefined && !object(currentTasks)) {
    return err("deno.json tasks must be an object.");
  }
  const tasks: JsonObject = object(currentTasks) ? currentTasks : {};

  const configured = await capabilities.git([
    "-C",
    real.value,
    "config",
    "--get",
    "core.hooksPath",
  ]);
  if (!configured.ok && !missingGitValue(configured)) {
    return err(`Cannot read effective core.hooksPath: ${configured.error}`);
  }
  const activeHooks = await capabilities.git([
    "-C",
    real.value,
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

  const repositoryHooks = `${real.value}/.githooks`;
  const repositoryHooksConfigured = configured.ok &&
    activeHooks.value === repositoryHooks;

  const ciPath = `${real.value}/ci`;
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
  const workflowPath = `${real.value}/${setupWorkflow}`;
  const workflowState = await regularFile(workflowPath);
  if (!workflowState.ok) return workflowState;
  const generateWorkflow = workflowState.value === "absent";
  if (generateWorkflow) {
    if (selectedStandardTasks.length === 0) {
      return err(
        "deno.json must define at least one standard task: fmt:check, lint, check, or test.",
      );
    }
    const verified = validateTasks(tasks, selectedStandardTasks);
    if (!verified.ok) return verified;
  } else {
    const workflow = await attempt(() => Deno.readTextFile(workflowPath));
    if (!workflow.ok) return err(`Cannot read the workflow: ${workflow.error}`);
    const plan = planWorkflow(workflow.value, setupJob);
    if (!plan.ok) return err(`The workflow cannot run job ${setupJob}: ${plan.error}`);
    if (plan.value.steps.some((step) => recursiveStep(step.script))) {
      return err("The workflow job invokes mci CI and would recurse through the hook.");
    }
  }

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
  if (!packagedHook.ok || packagedHook.value !== hookScript) {
    return err(`The packaged hook at ${packagedHookPath} is not managed by mci.`);
  }
  const packagedInfo = await attempt(() => Deno.stat(packagedHookPath));
  if (
    !packagedInfo.ok || packagedInfo.value.mode === null ||
    (packagedInfo.value.mode & 0o111) === 0
  ) return err(`The packaged hook at ${packagedHookPath} is not executable.`);

  let migration: HookMigration | undefined;
  if (activeHooks.value !== canonicalHooksPath.value) {
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
  const ignorePlan = await planGitIgnore(real.value);
  if (!ignorePlan.ok) return ignorePlan;

  let generated: CreatedFile | undefined;
  if (generateWorkflow) {
    const directory = await requireDirectory(ciPath);
    if (!directory.ok) return directory;
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

  const installed = await installHookWithPolicy(
    real.value,
    setupWorkflow,
    setupJob,
    capabilities,
    migration,
  );
  if (installed.ok) return installed;
  let detail = installed.error;
  if (ignored.value !== null) {
    const ignoredRollback = await rollbackGitIgnore(ignored.value);
    detail += rollbackFailure(
      ignoredRollback,
      ignored.value.path,
      `restore ${shellQuote(ignored.value.path)} to its prior contents and confirm it.`,
    );
  }
  if (generated !== undefined) {
    const workflowRollback = await rollbackCreatedFile(generated);
    detail += rollbackFailure(
      workflowRollback,
      generated.path,
      `remove ${
        shellQuote(generated.path)
      } after confirming that it is still generated by mci.`,
    );
  }
  return err(detail);
};

export const setupHook = (
  repository: string,
  options: HookSetupOptions = {},
): Promise<Result<void>> => setupHookWith(repository, nativeHookCapabilities, options);

export const installHook = (
  repository: string,
  workflow: string,
  job: string,
): Promise<Result<void>> =>
  installHookWith(repository, workflow, job, nativeHookCapabilities);

const status = (name: string, passed: boolean, detail: string): string =>
  `${passed ? "PASS" : "FAIL"} ${name}: ${detail}`;

/** Report installation, daemon, registry, hook, and recovery state. */
export const doctor = async (repository?: string): Promise<Result<readonly string[]>> => {
  const reports: string[] = [];
  reports.push(status("platform", Deno.build.os === "darwin", Deno.build.os));
  const deno = await command("/usr/bin/env", ["deno", "--version"]);
  reports.push(
    status(
      "Deno",
      deno.ok && deno.value.code === 0,
      deno.ok
        ? deno.value.code === 0
          ? deno.value.stdout.split("\n")[0] ?? "available"
          : deno.value.stderr
        : deno.error,
    ),
  );
  const bash = await command("/bin/bash", ["--version"]);
  reports.push(
    status(
      "Bash",
      bash.ok && bash.value.code === 0,
      bash.ok
        ? bash.value.code === 0
          ? bash.value.stdout.split("\n")[0] ?? "available"
          : bash.value.stderr
        : bash.error,
    ),
  );
  const brew = await findBrew();
  reports.push(status("Homebrew", brew.ok, brew.ok ? brew.value : brew.error));
  const prefix = await nativeBrewPrefix();
  reports.push(status("formula", prefix.ok, prefix.ok ? prefix.value : prefix.error));
  const daemon = await rpc({ version: 1, op: "ping" });
  reports.push(
    status(
      "daemon",
      daemon.ok,
      daemon.ok ? `pid ${daemon.value.pid}` : daemon.error,
    ),
  );
  const paths = servicePaths();
  if (!paths.ok) reports.push(status("service paths", false, paths.error));
  else {
    const legacy = await regularFile(`${paths.value.directory}/monitor.json`);
    reports.push(
      status(
        "legacy registry",
        legacy.ok,
        !legacy.ok ? legacy.error : legacy.value === "file" ? "present" : "absent",
      ),
    );
    const registry = await regularFile(paths.value.registry);
    reports.push(
      status(
        "daemon registry",
        registry.ok && registry.value === "file",
        registry.ok ? registry.value : registry.error,
      ),
    );
    const entries = await attempt(async () => {
      const names: string[] = [];
      for await (
        const entry of Deno.readDir(`${Deno.env.get("HOME") ?? ""}/Applications`)
      ) {
        if (entry.name.startsWith(".mci-monitor-") && entry.isDirectory) {
          names.push(entry.name);
        }
      }
      return names;
    });
    reports.push(
      status(
        "recovery",
        entries.ok && entries.value.length === 0,
        entries.ok
          ? entries.value.length === 0
            ? "no staging or backup apps"
            : entries.value.join(", ")
          : entries.error,
      ),
    );
  }
  if (repository !== undefined) {
    const byId = daemon.ok
      ? daemon.value.repositories.find((entry) => entry.id === repository)
      : undefined;
    const root = byId === undefined
      ? await attempt(() => Deno.realPath(repository))
      : ok(byId.path);
    const state = byId ??
      (daemon.ok && root.ok
        ? daemon.value.repositories.find((entry) => entry.path === root.value)
        : undefined);
    reports.push(
      status(
        "repository registration",
        state !== undefined,
        state === undefined ? "not registered" : state.id,
      ),
    );
    if (state !== undefined) {
      reports.push(
        status(
          "repository recovery",
          state.blocked === null,
          state.blocked ??
            (state.latest?.kind === "interrupted"
              ? `latest request ${state.latest.id} was interrupted`
              : "ready"),
        ),
      );
    }
    if (!root.ok) reports.push(status("repository path", false, root.error));
    else {
      const configured = await nativeGit([
        "-C",
        root.value,
        "config",
        "--get",
        "core.hooksPath",
      ]);
      reports.push(
        status(
          "repository hook",
          configured.ok && prefix.ok &&
            configured.value === `${prefix.value}/libexec/hooks`,
          configured.ok ? configured.value : configured.error,
        ),
      );
    }
  }
  return ok(reports);
};
