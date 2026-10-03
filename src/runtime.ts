import denoConfig from "../deno.json" with { type: "json" };

export const cliVersion = denoConfig.version;

const pathFrom = (relative: string): string =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);

export const cliSourceArgs = (args: readonly string[]): string[] => [
  "run",
  "--quiet",
  "--permission-set=mci",
  "--config",
  pathFrom("../deno.json"),
  pathFrom("main.ts"),
  ...args,
];

// A compiled binary re-invokes itself; a source run goes through the Deno executable.
export const cliSelfArgs = (args: readonly string[]): string[] =>
  Deno.build.standalone ? [...args] : cliSourceArgs(args);
