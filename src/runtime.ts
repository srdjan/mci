import denoConfig from "../deno.json" with { type: "json" };

export const cliVersion = denoConfig.version;

const cliPermissionArgs = [
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys=osRelease",
] as const;

const pathFrom = (relative: string): string =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);

export const cliSourceArgs = (args: readonly string[]): string[] => [
  "run",
  ...cliPermissionArgs,
  "--config",
  pathFrom("../deno.json"),
  pathFrom("main.ts"),
  ...args,
];

export const cliCompileArgs = (): string[] => [
  "compile",
  ...cliPermissionArgs,
  "--config",
  pathFrom("../deno.json"),
  "--output",
  "dist/mci",
  pathFrom("main.ts"),
];

export const testArgs = (): string[] => [
  "test",
  ...cliPermissionArgs,
  "--config",
  pathFrom("../deno.json"),
  pathFrom("../tests/"),
];
