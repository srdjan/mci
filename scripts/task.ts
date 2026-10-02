import { cliCompileArgs, cliSourceArgs, testArgs } from "../src/runtime.ts";
import { attempt } from "../src/result.ts";

type Task = "compile" | "mci" | "test";

const task = (value: string | undefined): value is Task =>
  value === "compile" || value === "mci" || value === "test";

const run = async (args: readonly string[]): Promise<number> => {
  const [name, ...rest] = args;
  if (!task(name)) {
    console.error("Usage: task.ts <compile|mci|test> [mci arguments]");
    return 2;
  }
  if (name !== "mci" && rest.length > 0) {
    console.error(`${name} does not accept arguments`);
    return 2;
  }
  const commandArgs = name === "mci"
    ? cliSourceArgs(rest)
    : name === "compile"
    ? cliCompileArgs()
    : testArgs();
  const outcome = await attempt(async () => {
    const child = new Deno.Command(Deno.execPath(), {
      args: commandArgs,
      stdin: name === "mci" ? "inherit" : "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    let signalError: string | undefined;
    const forward = (signal: Deno.Signal) => {
      void attempt(() => child.kill(signal)).then((sent) => {
        if (!sent.ok) signalError = sent.error;
      });
    };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    if (Deno.build.os !== "windows") {
      Deno.addSignalListener("SIGINT", interrupt);
      Deno.addSignalListener("SIGTERM", terminate);
    }
    try {
      const status = await child.status;
      if (signalError) {
        console.error(`${name}: signal forwarding failed: ${signalError}`);
        return 1;
      }
      return status.code;
    } finally {
      if (Deno.build.os !== "windows") {
        Deno.removeSignalListener("SIGINT", interrupt);
        Deno.removeSignalListener("SIGTERM", terminate);
      }
    }
  });
  if (outcome.ok) return outcome.value;
  console.error(`${name}: ${outcome.error}`);
  return 1;
};

if (import.meta.main) Deno.exit(await run(Deno.args));
