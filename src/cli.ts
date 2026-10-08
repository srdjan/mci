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
import {
  doctor,
  type DoctorReport,
  type HookCancellationReason,
  installHook,
  setupHook,
} from "./hooks.ts";
import { setup } from "./install.ts";
import { managementCommand } from "./management.ts";
import { attempt, err, ok, type Result } from "./result.ts";
import { resolveBash, runPlan } from "./runner.ts";
import { cliVersion } from "./runtime.ts";
import { planWorkflow } from "./workflow.ts";
import { runWorker } from "./worker.ts";

const usage = `mci ${cliVersion}: local macOS CI
Usage: mci <check|run|ci> <workflow.yml> --job <id>
       mci --help | --version
       mci daemon | setup | register <repository> | unregister <repository-id-or-path>
       mci status [repository-id-or-path] [--json]
       mci logs <repository-id-or-path> [--follow]
       mci doctor [repository-id-or-path]
       mci hooks install <repository> --workflow <file> --job <id> [--timeout-ms <milliseconds>]
       mci hooks setup <repository> [--replace-pre-push] [--timeout-ms <milliseconds>]
       mci codex hook | mci codex install <repository>

Run from the workspace root. check executes no workflow commands.
ci requires a registered repository and a running daemon. It waits for its request.
Only run steps with an explicit effective shell: bash are supported.`;

const hookTimeoutMaximumMs = 120000;

type HookSetupCommand = {
  readonly repository: string;
  readonly replacePrePush: boolean;
  readonly timeoutMs: number;
};

type HookInstallCommand = {
  readonly repository: string;
  readonly workflow: string;
  readonly job: string;
  readonly timeoutMs: number;
};

const parseHookTimeout = (value: string): Result<number> => {
  if (!/^[1-9][0-9]*$/.test(value)) return err("invalid hook timeout");
  const timeoutMs = Number(value);
  return Number.isSafeInteger(timeoutMs) && timeoutMs <= hookTimeoutMaximumMs
    ? ok(timeoutMs)
    : err("invalid hook timeout");
};

const parseHookSetup = (args: readonly string[]): Result<HookSetupCommand> => {
  const repository = args[2];
  if (args[0] !== "hooks" || args[1] !== "setup" || repository === undefined) {
    return err("invalid hook setup command");
  }
  let replacePrePush = false;
  let timeoutMs = hookTimeoutMaximumMs;
  let timeoutSeen = false;
  for (let index = 3; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--replace-pre-push" && !replacePrePush) {
      replacePrePush = true;
      continue;
    }
    if (argument === "--timeout-ms" && !timeoutSeen) {
      const value = args[index + 1];
      if (value === undefined) return err("missing hook timeout");
      const parsed = parseHookTimeout(value);
      if (!parsed.ok) return parsed;
      timeoutMs = parsed.value;
      timeoutSeen = true;
      index += 1;
      continue;
    }
    return err("invalid hook setup option");
  }
  return ok({ repository, replacePrePush, timeoutMs });
};

const parseHookInstall = (args: readonly string[]): Result<HookInstallCommand> => {
  if (
    args[0] !== "hooks" || args[1] !== "install" || args[2] === undefined ||
    args[3] !== "--workflow" || args[4] === undefined || args[5] !== "--job" ||
    args[6] === undefined || (args.length !== 7 && args.length !== 9)
  ) return err("invalid hook install command");
  let timeoutMs = hookTimeoutMaximumMs;
  if (args.length === 9) {
    if (args[7] !== "--timeout-ms" || args[8] === undefined) {
      return err("invalid hook install timeout");
    }
    const parsed = parseHookTimeout(args[8]);
    if (!parsed.ok) return parsed;
    timeoutMs = parsed.value;
  }
  return ok({
    repository: args[2],
    workflow: args[4],
    job: args[6],
    timeoutMs,
  });
};

const hookCancellationCode = (reason: unknown): 124 | 130 | 143 | null => {
  if (typeof reason !== "object" || reason === null || !("tag" in reason)) return null;
  if (
    reason.tag === "timeout" && "timeoutMs" in reason &&
    typeof reason.timeoutMs === "number" && Number.isSafeInteger(reason.timeoutMs) &&
    reason.timeoutMs > 0 && reason.timeoutMs <= hookTimeoutMaximumMs
  ) return 124;
  if (reason.tag === "SIGINT") return 130;
  if (reason.tag === "SIGTERM") return 143;
  return null;
};

const runHookOperation = async (
  timeoutMs: number,
  repository: string,
  operation: (root: string, signal: AbortSignal) => Promise<Result<void>>,
  success: string,
): Promise<number> => {
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort({ tag: "SIGINT" } satisfies HookCancellationReason);
  const terminate = () =>
    controller.abort({ tag: "SIGTERM" } satisfies HookCancellationReason);
  Deno.addSignalListener("SIGINT", interrupt);
  Deno.addSignalListener("SIGTERM", terminate);
  const timer = setTimeout(
    () =>
      controller.abort({ tag: "timeout", timeoutMs } satisfies HookCancellationReason),
    timeoutMs,
  );
  try {
    const root = await attempt(() => Deno.realPath(repository));
    if (!root.ok) {
      console.error(root.error);
      return 2;
    }
    const result = await operation(root.value, controller.signal);
    if (result.ok) {
      console.log(success);
      return 0;
    }
    console.error(result.error);
    return hookCancellationCode(controller.signal.reason) ?? 1;
  } finally {
    clearTimeout(timer);
    Deno.removeSignalListener("SIGINT", interrupt);
    Deno.removeSignalListener("SIGTERM", terminate);
  }
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

const runCi = async (
  file: string,
  job: string,
  parent: number,
  receipt: CiReceipt | null,
): Promise<number> => {
  const loaded = await attempt(async () => ({
    workspace: await Deno.realPath(Deno.cwd()),
    source: await Deno.readTextFile(file),
    env: Deno.env.toObject(),
  }));
  if (!loaded.ok) {
    return await failCommand(receipt, "ci", file, job, 2, `${file}: ${loaded.error}`);
  }
  const plan = planWorkflow(loaded.value.source, job);
  if (!plan.ok) {
    return await failCommand(receipt, "ci", file, job, 2, `${file}: ${plan.error}`);
  }
  const shell = await resolveBash(loaded.value.workspace, loaded.value.env.PATH ?? "");
  if (!shell.ok) {
    return await failCommand(receipt, "ci", file, job, 2, shell.error);
  }
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
      path: loaded.value.workspace,
      workflow: file,
      job,
      source: loaded.value.source,
      env: loaded.value.env,
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

export const doctorCommand = async (repository: string | undefined, capabilities: {
  readonly inspect: (repository?: string) => Promise<Result<DoctorReport>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
} = { inspect: doctor, stdout: console.log, stderr: console.error }): Promise<number> => {
  const result = await capabilities.inspect(repository);
  if (!result.ok) {
    capabilities.stderr(result.error);
    return 1;
  }
  capabilities.stdout(
    result.value.checks.map((check) =>
      `${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`
    ).join("\n"),
  );
  return result.value.healthy ? 0 : 1;
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
  if (args[0] === "doctor" && args.length <= 2) {
    return await doctorCommand(args[1]);
  }

  if (args[0] === "hooks" && args[1] === "setup") {
    const parsed = parseHookSetup(args);
    if (!parsed.ok) {
      console.error(usage);
      return 2;
    }
    return await runHookOperation(
      parsed.value.timeoutMs,
      parsed.value.repository,
      (root, signal) =>
        setupHook(root, {
          replacePrePush: parsed.value.replacePrePush,
          signal,
        }),
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
      parsed.value.timeoutMs,
      parsed.value.repository,
      (root, signal) =>
        installHook(root, parsed.value.workflow, parsed.value.job, { signal }),
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
  if (command === "ci") return await runCi(file, job, parent, receipt.value);
  const loaded = await attempt(async () => ({
    source: await Deno.readTextFile(file),
    workspace: await Deno.realPath(Deno.cwd()),
    inherited: Deno.env.toObject(),
  }));
  if (!loaded.ok) {
    if (command === "check") {
      console.error(`${file}: ${loaded.error}`);
      return 2;
    }
    return await failCommand(
      receipt.value,
      "run",
      file,
      job,
      2,
      `${file}: ${loaded.error}`,
    );
  }
  const planned = planWorkflow(loaded.value.source, job);
  if (!planned.ok) {
    if (command === "check") {
      console.error(`${file}: ${planned.error}`);
      return 2;
    }
    return await failCommand(
      receipt.value,
      "run",
      file,
      job,
      2,
      `${file}: ${planned.error}`,
    );
  }
  const plan = planned.value;
  const shell = await resolveBash(
    loaded.value.workspace,
    loaded.value.inherited.PATH ?? "",
  );
  if (!shell.ok) {
    if (command === "check") {
      console.error(shell.error);
      return 2;
    }
    return await failCommand(receipt.value, "run", file, job, 2, shell.error);
  }
  console.log(`${file} :: ${job} (${plan.name})`);
  console.log(`Workspace: ${loaded.value.workspace}`);
  console.log(
    `Host: ${Deno.build.os}/${Deno.build.arch}; Deno ${Deno.version.deno}; bash: ${shell.value}`,
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
  const supervised = loaded.value.inherited.MCI_TASK_PARENT === "true";
  const stopWatching = supervised ? watchParent(controller, parent) : () => {};
  try {
    const outcome = await runPlan(plan, {
      workspace: loaded.value.workspace,
      shell: shell.value,
      inherited: loaded.value.inherited,
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
