import { runLoggedCi } from "./ci.ts";
import { attempt } from "./result.ts";
import { resolveBash, runPlan } from "./runner.ts";
import { cliSelfArgs, cliVersion } from "./runtime.ts";
import { planWorkflow } from "./workflow.ts";

const usage = `mci ${cliVersion}: local macOS CI
Usage: mci <check|run|ci> <workflow.yml> --job <id>
       mci --help | --version

Run from the workspace root. check executes no workflow commands.
ci runs the job through run and saves .mci/ci/latest.log and status.json.
Only run steps with an explicit effective shell: bash are supported.`;

type Writer = { readonly write: (chunk: Uint8Array) => Promise<number> };

const write = async (file: Writer, chunk: Uint8Array): Promise<void> => {
  let offset = 0;
  while (offset < chunk.length) {
    const written = await file.write(chunk.subarray(offset));
    if (written === 0) {
      return Promise.reject(new Error("terminal write returned zero bytes"));
    }
    offset += written;
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

const runCi = async (file: string, job: string, parent: number): Promise<number> => {
  const workspace = await attempt(() => Deno.realPath(Deno.cwd()));
  if (!workspace.ok) {
    console.error(`workspace: ${workspace.error}`);
    return 2;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  Deno.addSignalListener("SIGINT", interrupt);
  Deno.addSignalListener("SIGTERM", terminate);
  const stopWatching = watchParent(controller, parent);
  try {
    const result = await runLoggedCi({
      workspace: workspace.value,
      command: Deno.execPath(),
      args: cliSelfArgs(["run", file, "--job", job]),
      env: { MCI_TASK_PARENT: "true" },
      signal: controller.signal,
      stdout: (chunk) => write(Deno.stdout, chunk),
      stderr: (chunk) => write(Deno.stderr, chunk),
    });
    if (!result.ok) {
      console.error(result.error);
      return 1;
    }
    for (const diagnostic of result.value.diagnostics) console.error(diagnostic);
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
