// @light-fp adapter
import { rpc, submit } from "./client.ts";
import {
  beginReceipt,
  type CiReceipt,
  type CiReceiptOutcome,
  finishReceipt,
} from "./ci-receipt.ts";
import { codexCommand } from "./codex.ts";
import { runDaemon } from "./daemon.ts";
import { installHook, setupHook } from "./hooks.ts";
import { setup } from "./install.ts";
import { managementCommand } from "./management.ts";
import { attempt, err, ok, type Result } from "./result.ts";
import { resolveBash, runPlan } from "./runner.ts";
import { cliVersion } from "./runtime.ts";
import { type Env, type Plan, planWorkflow } from "./workflow.ts";
import { runWorker } from "./worker.ts";

const usage = `mci ${cliVersion}: local macOS CI
Usage: mci <check|run|ci> <workflow.yml> --job <id>
       mci --help | --version
       mci daemon | setup | register <repository> | unregister <repository-id-or-path>
       mci status [repository-id-or-path] [--json]
       mci logs <repository-id-or-path> [--follow]
       mci hooks install <repository> --workflow <file> --job <id>
       mci hooks setup <repository> [--replace-pre-push]
       mci codex hook | mci codex install <repository>

Run from the workspace root. check executes no workflow commands.
ci requires a registered repository and a running daemon. It waits for its request.
Only run steps with an explicit effective shell: bash are supported.`;

type HookSetupCommand = {
  readonly repository: string;
  readonly replacePrePush: boolean;
};

type HookInstallCommand = {
  readonly repository: string;
  readonly workflow: string;
  readonly job: string;
};

type WorkflowInputs = {
  readonly source: string;
  readonly workspace: string;
};

type WorkflowPreparation = WorkflowInputs & {
  readonly environment: Env;
  readonly plan: Plan;
  readonly shell: string;
};

const parseHookSetup = (args: readonly string[]): Result<HookSetupCommand> => {
  const repository = args[2];
  if (args[0] !== "hooks" || args[1] !== "setup" || repository === undefined) {
    return err("invalid hook setup command");
  }
  let replacePrePush = false;
  for (let index = 3; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--replace-pre-push" && !replacePrePush) {
      replacePrePush = true;
      continue;
    }
    return err("invalid hook setup option");
  }
  return ok({ repository, replacePrePush });
};

const parseHookInstall = (args: readonly string[]): Result<HookInstallCommand> => {
  if (
    args[0] !== "hooks" || args[1] !== "install" || args[2] === undefined ||
    args[3] !== "--workflow" || args[4] === undefined || args[5] !== "--job" ||
    args[6] === undefined || args.length !== 7
  ) return err("invalid hook install command");
  return ok({
    repository: args[2],
    workflow: args[4],
    job: args[6],
  });
};

const runHookOperation = async (
  repository: string,
  operation: (root: string) => Promise<Result<void>>,
  success: string,
): Promise<number> => {
  const root = await attempt(() => Deno.realPath(repository));
  if (!root.ok) {
    console.error(root.error);
    return 2;
  }
  const result = await operation(root.value);
  if (result.ok) {
    console.log(success);
    return 0;
  }
  console.error(result.error);
  return 1;
};

// Aborts the controller when the original parent process exits. Returns the stop function.
const watchParent = (controller: AbortController, parent: number): () => void => {
  const check = () => {
    if (parent <= 1 || Deno.ppid !== parent) controller.abort("SIGTERM");
  };
  const timer = setInterval(check, 25);
  check();
  return () => clearInterval(timer);
};

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

const rerun = (command: "ci" | "run", file: string, job: string): void =>
  console.error(
    `Then rerun \`mci ${command} ${shellQuote(file)} --job ${shellQuote(job)}\`.`,
  );

const recordCompletion = async (
  receipt: CiReceipt | null,
  outcome: CiReceiptOutcome,
  code: number,
  command: "ci" | "run",
  file: string,
  job: string,
): Promise<number> => {
  const recorded = await finishReceipt(receipt, outcome);
  if (recorded.ok) return code;
  console.error(`CI receipt update failed: ${recorded.error}`);
  console.error("The CI result is unresolved. Fix the receipt storage failure.");
  rerun(command, file, job);
  return code === 0 ? 1 : code;
};

const failCommand = async (
  receipt: CiReceipt | null,
  command: "ci" | "run",
  file: string,
  job: string,
  code: 1 | 2,
  detail: string,
  kind: "error" | "unknown" = "error",
): Promise<number> => {
  console.error(`CI did not pass: ${detail}`);
  console.error("Fix the CI failure before continuing.");
  rerun(command, file, job);
  const outcome: CiReceiptOutcome = kind === "unknown"
    ? { kind, code: 1, detail, requestId: null, log: null }
    : { kind, code, detail, requestId: null, log: null };
  return await recordCompletion(receipt, outcome, code, command, file, job);
};

const prepareWorkflow = async (
  file: string,
  job: string,
  loadInputs: () => Promise<WorkflowInputs>,
): Promise<Result<WorkflowPreparation>> => {
  const loaded = await attempt(async () => ({
    ...await loadInputs(),
    environment: Deno.env.toObject(),
  }));
  if (!loaded.ok) return err(`${file}: ${loaded.error}`);
  const plan = planWorkflow(loaded.value.source, job);
  if (!plan.ok) return err(`${file}: ${plan.error}`);
  const shell = await resolveBash(
    loaded.value.workspace,
    loaded.value.environment.PATH ?? "",
  );
  return shell.ok ? ok({ ...loaded.value, plan: plan.value, shell: shell.value }) : shell;
};

const runCi = async (
  file: string,
  job: string,
  parent: number,
  receipt: CiReceipt | null,
  prepared: WorkflowPreparation,
): Promise<number> => {
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  Deno.addSignalListener("SIGINT", interrupt);
  Deno.addSignalListener("SIGTERM", terminate);
  const stopWatching = watchParent(controller, parent);
  try {
    const result = await submit({
      version: 1,
      op: "submit",
      path: prepared.workspace,
      workflow: file,
      job,
      source: prepared.source,
      env: prepared.environment,
    }, controller.signal);
    if (!result.ok) {
      const known =
        /^(Daemon unavailable|invalid:|unavailable:|unregistered:|busy:|storage:)/
          .test(result.error);
      return await failCommand(
        receipt,
        "ci",
        file,
        job,
        1,
        result.error,
        known ? "error" : "unknown",
      );
    }
    console.log(`${result.value.kind}: ${result.value.detail}`);
    if (result.value.code !== 0) {
      console.error(`CI did not pass: ${result.value.kind}: ${result.value.detail}`);
      console.error(`Request: ${result.value.id}`);
      console.error(`Log: ${result.value.log}`);
      console.error("Fix the CI failure before continuing.");
      rerun("ci", file, job);
    }
    return await recordCompletion(
      receipt,
      {
        kind: result.value.kind,
        code: result.value.code,
        detail: result.value.detail,
        requestId: result.value.id,
        log: result.value.log,
      },
      result.value.code,
      "ci",
      file,
      job,
    );
  } finally {
    stopWatching();
    Deno.removeSignalListener("SIGINT", interrupt);
    Deno.removeSignalListener("SIGTERM", terminate);
  }
};

export const main = async (args: readonly string[]): Promise<number> => {
  const parent = Deno.ppid;
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  if (args.length === 1 && args[0] === "--version") {
    console.log(cliVersion);
    return 0;
  }
  if (args[0] === "__worker" && args.length === 2 && args[1]) {
    return await runWorker(args[1]);
  }
  if (args.length === 1 && args[0] === "daemon") {
    if (Deno.build.os !== "darwin") {
      console.error("mci daemon supports macOS only");
      return 2;
    }
    return await runDaemon();
  }
  if (args.length === 1 && args[0] === "setup") {
    const result = await setup();
    if (!result.ok) {
      console.error(result.error);
      return 1;
    }
    console.log(
      "Daemon and monitor are ready. Register a repository with mci register <repository>.",
    );
    return 0;
  }
  if (args[0] === "hooks" && args[1] === "setup") {
    const parsed = parseHookSetup(args);
    if (!parsed.ok) {
      console.error(usage);
      return 2;
    }
    return await runHookOperation(
      parsed.value.repository,
      (root) => setupHook(root, { replacePrePush: parsed.value.replacePrePush }),
      "Configured pre-commit CI for this worktree.",
    );
  }
  if (args[0] === "hooks" && args[1] === "install") {
    const parsed = parseHookInstall(args);
    if (!parsed.ok) {
      console.error(usage);
      return 2;
    }
    return await runHookOperation(
      parsed.value.repository,
      (root) => installHook(root, parsed.value.workflow, parsed.value.job),
      "Installed the pre-commit hook and its Deno task.",
    );
  }
  const codex = await codexCommand(args);
  if (codex !== null) return codex;
  const managed = await managementCommand(args, rpc);
  if (managed !== null) return managed;
  const [command, file, flag, job] = args;
  if (
    args.length !== 4 || !["check", "run", "ci"].includes(command ?? "") || !file ||
    flag !== "--job" || !job
  ) {
    console.error(usage);
    return 2;
  }
  const executionCommand = command === "ci" || command === "run" ? command : null;
  const receipt = executionCommand !== null
    ? await beginReceipt({
      workspace: Deno.cwd(),
      workflow: file,
      job,
      command: executionCommand,
    })
    : { ok: true as const, value: null };
  if (!receipt.ok) {
    console.error(`CI receipt creation failed: ${receipt.error}`);
    console.error("The CI result is unresolved. Fix the receipt storage failure.");
    rerun(executionCommand!, file, job);
    return 1;
  }
  if (executionCommand !== null && Deno.build.os !== "darwin") {
    return await failCommand(
      receipt.value,
      executionCommand,
      file,
      job,
      2,
      `mci ${executionCommand} supports macOS only. check is portable.`,
    );
  }
  const loadInputs = command === "ci"
    ? async (): Promise<WorkflowInputs> => {
      const workspace = await Deno.realPath(Deno.cwd());
      const source = await Deno.readTextFile(file);
      return { source, workspace };
    }
    : async (): Promise<WorkflowInputs> => {
      const source = await Deno.readTextFile(file);
      const workspace = await Deno.realPath(Deno.cwd());
      return { source, workspace };
    };
  const prepared = await prepareWorkflow(file, job, loadInputs);
  if (!prepared.ok) {
    if (executionCommand === null) {
      console.error(prepared.error);
      return 2;
    }
    return await failCommand(
      receipt.value,
      executionCommand,
      file,
      job,
      2,
      prepared.error,
    );
  }
  if (command === "ci") {
    return await runCi(file, job, parent, receipt.value, prepared.value);
  }
  const { environment, plan, shell, workspace } = prepared.value;
  console.log(`${file} :: ${job} (${plan.name})`);
  console.log(`Workspace: ${workspace}`);
  console.log(
    `Host: ${Deno.build.os}/${Deno.build.arch}; Deno ${Deno.version.deno}; bash: ${shell}`,
  );
  console.log("Result covers the selected job only; on is not evaluated.");
  if (plan.otherJobs.length) console.log(`Unselected jobs: ${plan.otherJobs.join(", ")}`);
  if (command === "check") {
    console.log(
      `Valid plan: ${plan.steps.length} steps; timeout ${plan.timeoutMs / 60_000} min`,
    );
    plan.steps.forEach((step, i) =>
      console.log(`  ${i + 1}. ${step.name} (cwd: ${step.directory})`)
    );
    return 0;
  }
  console.log(`OS kernel release: ${Deno.osRelease()}`);
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  Deno.addSignalListener("SIGINT", interrupt);
  Deno.addSignalListener("SIGTERM", terminate);
  const supervised = environment.MCI_TASK_PARENT === "true";
  const stopWatching = supervised ? watchParent(controller, parent) : () => {};
  try {
    const outcome = await runPlan(plan, {
      workspace,
      shell,
      inherited: environment,
      signal: controller.signal,
    });
    console.log(
      `${outcome.kind}: ${outcome.detail}; completed ${outcome.completed}/${outcome.total}; unrun ${
        outcome.total - outcome.completed
      }`,
    );
    if (outcome.code !== 0) {
      console.error(`CI did not pass: ${outcome.kind}: ${outcome.detail}`);
      console.error("Fix the CI failure before continuing.");
      rerun("run", file, job);
    }
    return await recordCompletion(
      receipt.value,
      {
        kind: outcome.kind,
        code: outcome.code,
        detail: outcome.detail,
        requestId: null,
        log: null,
      },
      outcome.code,
      "run",
      file,
      job,
    );
  } finally {
    stopWatching();
    Deno.removeSignalListener("SIGINT", interrupt);
    Deno.removeSignalListener("SIGTERM", terminate);
  }
};
