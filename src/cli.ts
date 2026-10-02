import { attempt } from "./result.ts";
import { resolveBash, runPlan } from "./runner.ts";
import { planWorkflow } from "./workflow.ts";

const usage = `mci 0.1.0 — local macOS CI
Usage: mci <check|run> <workflow.yml> --job <id>
       mci --help | --version

Run from the workspace root. check executes no workflow commands.
Only run steps with an explicit effective shell: bash are supported.`;

export const main = async (args: readonly string[]): Promise<number> => {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  if (args.length === 1 && args[0] === "--version") {
    console.log("0.1.0");
    return 0;
  }
  const [command, file, flag, job] = args;
  if (
    args.length !== 4 || !["check", "run"].includes(command ?? "") || !file ||
    flag !== "--job" || !job
  ) {
    console.error(usage);
    return 2;
  }
  if (command === "run" && Deno.build.os !== "darwin") {
    console.error("mci run supports macOS only. check is portable.");
    return 2;
  }
  const loaded = await attempt(async () => ({
    source: await Deno.readTextFile(file),
    workspace: await Deno.realPath(Deno.cwd()),
    inherited: Deno.env.toObject(),
  }));
  if (!loaded.ok) {
    console.error(loaded.error);
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
  console.log(`Host: ${Deno.build.os}/${Deno.build.arch}; bash: ${shell.value}`);
  console.log("Manual local invocation; on is not evaluated.");
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
    Deno.removeSignalListener("SIGINT", interrupt);
    Deno.removeSignalListener("SIGTERM", terminate);
  }
};
