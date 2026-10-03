// @light-fp adapter
import { rpc, submit } from "./client.ts";
import { runDaemon } from "./daemon.ts";
import { doctor, installHook } from "./hooks.ts";
import { setup } from "./install.ts";
import { managementCommand } from "./management.ts";
import { attempt } from "./result.ts";
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
       mci hooks install <repository> --workflow <file> --job <id>

Run from the workspace root. check executes no workflow commands.
ci requires a registered repository and a running daemon. It waits for its request.
Only run steps with an explicit effective shell: bash are supported.`;

// Aborts the controller when the original parent process exits. Returns the stop function.
const watchParent = (controller: AbortController, parent: number): () => void => {
  const check = () => {
    if (parent <= 1 || Deno.ppid !== parent) controller.abort("SIGTERM");
  };
  const timer = setInterval(check, 25);
  check();
  return () => clearInterval(timer);
};

const runCi = async (file: string, job: string, parent: number): Promise<number> => {
  const loaded = await attempt(async () => ({
    workspace: await Deno.realPath(Deno.cwd()),
    source: await Deno.readTextFile(file),
    env: Deno.env.toObject(),
  }));
  if (!loaded.ok) {
    console.error(`${file}: ${loaded.error}`);
    return 2;
  }
  const plan = planWorkflow(loaded.value.source, job);
  if (!plan.ok) {
    console.error(`${file}: ${plan.error}`);
    return 2;
  }
  const shell = await resolveBash(loaded.value.workspace, loaded.value.env.PATH ?? "");
  if (!shell.ok) {
    console.error(shell.error);
    return 2;
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
      console.error(result.error);
      return 1;
    }
    console.log(`${result.value.kind}: ${result.value.detail}`);
    return result.value.code;
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
  if (args[0] === "doctor" && args.length <= 2) {
    const result = await doctor(args[1]);
    if (!result.ok) {
      console.error(result.error);
      return 1;
    }
    console.log(result.value.join("\n"));
    return 0;
  }
  if (
    args[0] === "hooks" && args[1] === "install" && args.length === 7 && args[2] &&
    args[3] === "--workflow" && args[4] && args[5] === "--job" && args[6]
  ) {
    const root = await attempt(() => Deno.realPath(args[2]!));
    if (!root.ok) {
      console.error(root.error);
      return 2;
    }
    const result = await installHook(root.value, args[4], args[6]);
    if (!result.ok) {
      console.error(result.error);
      return 1;
    }
    console.log("Installed the pre-commit hook and its Deno task.");
    return 0;
  }
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
  if (command !== "check" && Deno.build.os !== "darwin") {
    console.error(`mci ${command} supports macOS only. check is portable.`);
    return 2;
  }
  if (command === "ci") return await runCi(file, job, parent);
  const loaded = await attempt(async () => ({
    source: await Deno.readTextFile(file),
    workspace: await Deno.realPath(Deno.cwd()),
    inherited: Deno.env.toObject(),
  }));
  if (!loaded.ok) {
    console.error(`${file}: ${loaded.error}`);
    return 2;
  }
  const planned = planWorkflow(loaded.value.source, job);
  if (!planned.ok) {
    console.error(`${file}: ${planned.error}`);
    return 2;
  }
  const plan = planned.value;
  const shell = await resolveBash(
    loaded.value.workspace,
    loaded.value.inherited.PATH ?? "",
  );
  if (!shell.ok) {
    console.error(shell.error);
    return 2;
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
    return outcome.code;
  } finally {
    stopWatching();
    Deno.removeSignalListener("SIGINT", interrupt);
    Deno.removeSignalListener("SIGTERM", terminate);
  }
};
