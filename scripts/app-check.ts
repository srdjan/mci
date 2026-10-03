// @light-fp adapter
import { attempt, err, ok, type Result } from "../src/result.ts";

const noise = "ld: warning: search path";

/** Command Line Tools make `swift build` print harmless search path warnings. */
export const keepLine = (line: string): boolean => !line.includes(noise);

const pump = async (
  stream: ReadableStream<Uint8Array>,
  sink: (text: string) => void,
): Promise<void> => {
  const decoder = new TextDecoder();
  let pending = "";
  const emit = (lines: readonly string[]) => {
    const kept = lines.filter(keepLine);
    if (kept.length > 0) sink(kept.join("\n") + "\n");
  };
  for await (const chunk of stream) {
    const parts = (pending + decoder.decode(chunk, { stream: true })).split("\n");
    pending = parts.pop() ?? "";
    emit(parts);
  }
  pending += decoder.decode();
  if (pending !== "") emit([pending]);
};

const write = (stream: { writeSync(data: Uint8Array): number }) => {
  const encoder = new TextEncoder();
  return (text: string) => {
    let rest = encoder.encode(text);
    while (rest.length > 0) rest = rest.subarray(stream.writeSync(rest));
  };
};

/** Run swift with filtered output. A launch failure is an error, a status is a value. */
const runSwift = async (args: readonly string[]): Promise<Result<number>> => {
  const spawned = await attempt(() =>
    new Deno.Command("swift", {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn()
  );
  if (!spawned.ok) return err(`Unable to launch swift: ${spawned.error}`);
  const child = spawned.value;
  const [status] = await Promise.all([
    child.status,
    pump(child.stdout, write(Deno.stdout)),
    pump(child.stderr, write(Deno.stderr)),
  ]);
  return ok(status.code);
};

const root = decodeURIComponent(new URL("../", import.meta.url).pathname).replace(
  /\/$/,
  "",
);

export const main = async (): Promise<number> => {
  if (Deno.build.os !== "darwin") {
    console.log("app:check skipped: the native monitor app is validated only on macOS");
    return 0;
  }
  const steps: readonly (readonly string[])[] = [
    ["build", "-c", "release", "--package-path", `${root}/monitor`],
    ["run", "-c", "release", "--package-path", `${root}/monitor`, "MonitorChecks"],
  ];
  for (const step of steps) {
    const ran = await runSwift(step);
    if (!ran.ok) {
      console.error(`app:check failed: ${ran.error}`);
      console.error("Install the Xcode Command Line Tools: xcode-select --install");
      return 1;
    }
    if (ran.value !== 0) {
      console.error(`app:check failed: swift ${step[0]} exited with ${ran.value}`);
      return ran.value;
    }
  }
  return 0;
};

if (import.meta.main) Deno.exit(await main());
