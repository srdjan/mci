// @light-fp adapter
import { type CiStatus, readCiStatus } from "../src/ci.ts";
import { inspectProcessIdentity } from "../src/process.ts";
import { err, ok, type Result } from "../src/result.ts";

type MenuState = {
  readonly label:
    | "PASS"
    | "FAIL"
    | "RUNNING"
    | "CANCELLED"
    | "INTERRUPTED"
    | "NO RUNS"
    | "ERROR";
  readonly symbol: string;
  readonly color: string;
  readonly lastRun: string | null;
  readonly code: number | null;
  readonly detail: string | null;
};

const fixedState = (
  label: MenuState["label"],
  symbol: string,
  color: string,
  detail: string | null = null,
): MenuState => ({ label, symbol, color, lastRun: null, code: null, detail });

const safeText = (value: string): string =>
  [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || character === "|" ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();

const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

const fileUrl = (path: string): string => {
  const absolute = path.startsWith("/") ? path : `${Deno.cwd()}/${path}`;
  const encoded = absolute.split("/").map(encodeURIComponent).join("/");
  return new URL(`file://${encoded}`).href;
};

const completedState = (status: CiStatus): MenuState => {
  const lastRun = status.finished ?? status.started;
  if (status.state === "pass") {
    return {
      label: "PASS",
      symbol: "checkmark.circle.fill",
      color: "green",
      lastRun,
      code: status.code,
      detail: null,
    };
  }
  if (status.state === "fail") {
    return {
      label: "FAIL",
      symbol: "xmark.circle.fill",
      color: "red",
      lastRun,
      code: status.code,
      detail: null,
    };
  }
  return {
    label: "CANCELLED",
    symbol: "stop.circle.fill",
    color: "orange",
    lastRun,
    code: status.code,
    detail: null,
  };
};

const runningState = async (status: CiStatus): Promise<MenuState> => {
  const inspected = await inspectProcessIdentity(status.pid);
  if (!inspected.ok) {
    return fixedState(
      "ERROR",
      "exclamationmark.triangle.fill",
      "red",
      `Logger inspection failed: ${inspected.error}`,
    );
  }
  if (inspected.value !== null && status.logger === null) {
    return {
      ...fixedState(
        "ERROR",
        "exclamationmark.triangle.fill",
        "red",
        "Logger identity is unavailable.",
      ),
      lastRun: status.started,
    };
  }
  const matches = inspected.value !== null && status.logger !== null &&
    inspected.value.pid === status.pid &&
    inspected.value.started === status.logger.started &&
    inspected.value.command === status.logger.command;
  return matches
    ? {
      label: "RUNNING",
      symbol: "arrow.triangle.2.circlepath",
      color: "blue",
      lastRun: status.started,
      code: null,
      detail: null,
    }
    : {
      label: "INTERRUPTED",
      symbol: "exclamationmark.triangle.fill",
      color: "orange",
      lastRun: status.started,
      code: null,
      detail: "The recorded CI logger is no longer running.",
    };
};

const inspectState = async (workspace: string): Promise<MenuState> => {
  const status = await readCiStatus(workspace);
  if (!status.ok) {
    return fixedState(
      "ERROR",
      "exclamationmark.triangle.fill",
      "red",
      status.error,
    );
  }
  if (status.value === null) {
    return fixedState("NO RUNS", "minus.circle", "gray");
  }
  return status.value.state === "running"
    ? await runningState(status.value)
    : completedState(status.value);
};

const logAvailable = async (workspace: string): Promise<Result<boolean>> => {
  try {
    const info = await Deno.lstat(`${workspace}/.mci/ci/latest.log`);
    return ok(info.isFile && !info.isSymlink);
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? ok(false) : err(String(error));
  }
};

const menuLines = (
  workspace: string,
  state: MenuState,
  hasLog: Result<boolean>,
): readonly string[] => {
  const lines = [
    `${
      safeText(basename(workspace)) || "mci"
    }: ${state.label} | sfimage=${state.symbol} color=${state.color}`,
    "---",
    `Repository: ${safeText(workspace)}`,
  ];
  if (state.lastRun !== null) lines.push(`Last run: ${state.lastRun}`);
  if (state.code !== null) lines.push(`Exit code: ${state.code}`);
  if (state.detail !== null) lines.push(`Detail: ${safeText(state.detail)}`);
  if (!hasLog.ok) lines.push(`Log unavailable: ${safeText(hasLog.error)}`);
  lines.push("---");

  if (hasLog.ok && hasLog.value) {
    lines.push(
      `Open log | bash=/usr/bin/open param1=-a param2=TextEdit param3=${
        fileUrl(`${workspace}/.mci/ci/latest.log`)
      } terminal=false`,
    );
  }
  lines.push(
    `Open repository | bash=/usr/bin/open param1=${fileUrl(workspace)} terminal=false`,
    "Refresh | refresh=true",
  );
  return lines;
};

export const renderMonitor = async (workspace: string): Promise<string> => {
  const [state, hasLog] = await Promise.all([
    inspectState(workspace),
    logAvailable(workspace),
  ]);
  return menuLines(workspace, state, hasLog).join("\n");
};

const defaultWorkspace = (): string =>
  decodeURIComponent(new URL("../", import.meta.url).pathname).replace(/\/$/, "");

const main = async (args: readonly string[]): Promise<number> => {
  if (args.length > 1) {
    console.log(
      menuLines(
        defaultWorkspace(),
        fixedState(
          "ERROR",
          "exclamationmark.triangle.fill",
          "red",
          "Usage: monitor.ts [workspace]",
        ),
        ok(false),
      ).join("\n"),
    );
    return 2;
  }
  console.log(await renderMonitor(args[0] ?? defaultWorkspace()));
  return 0;
};

if (import.meta.main) Deno.exit(await main(Deno.args));
