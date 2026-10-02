// @light-fp adapter
import { runLoggedCi } from "../src/ci.ts";
import { cliSourceArgs } from "../src/runtime.ts";

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

const main = async (): Promise<number> => {
  const parent = Deno.ppid;
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  Deno.addSignalListener("SIGINT", interrupt);
  Deno.addSignalListener("SIGTERM", terminate);
  const checkParent = () => {
    if (parent <= 1 || Deno.ppid !== parent) controller.abort("SIGTERM");
  };
  const supervised = Deno.env.get("MCI_TASK_PARENT") === "true";
  const parentTimer = supervised ? setInterval(checkParent, 25) : undefined;
  if (supervised) checkParent();
  try {
    const result = await runLoggedCi({
      workspace: Deno.cwd(),
      command: Deno.execPath(),
      args: cliSourceArgs(["run", "ci/local-ci.yml", "--job", "check"]),
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
    if (parentTimer !== undefined) clearInterval(parentTimer);
    Deno.removeSignalListener("SIGINT", interrupt);
    Deno.removeSignalListener("SIGTERM", terminate);
  }
};

if (import.meta.main) Deno.exit(await main());
