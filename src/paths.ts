// @light-fp adapter
import { err, ok, type Result } from "./result.ts";

export type ServicePaths = {
  readonly directory: string;
  readonly socket: string;
  readonly registry: string;
  readonly snapshot: string;
  readonly journal: string;
};
/** Return the service directory without the daemon socket length check. */
export const serviceDirectory = (home?: string): Result<string> => {
  const directory = home ?? Deno.env.get("MCI_HOME") ??
    `${Deno.env.get("HOME") ?? ""}/Library/Application Support/mci`;
  if (
    !directory.startsWith("/") || directory.includes("\0") ||
    (!home && !Deno.env.get("MCI_HOME") && !Deno.env.get("HOME")?.startsWith("/"))
  ) {
    return err("HOME or MCI_HOME must identify an absolute directory");
  }
  return ok(directory.replace(/\/+$/, ""));
};

export const servicePaths = (home?: string): Result<ServicePaths> => {
  const directory = serviceDirectory(home);
  if (!directory.ok) return directory;
  const trimmed = directory.value;
  const socket = `${trimmed}/daemon.sock`;
  // Darwin reserves one byte for the terminating NUL in sockaddr_un.sun_path.
  if (new TextEncoder().encode(socket).length >= 104) {
    return err(
      "The daemon socket path is too long. Set MCI_HOME to a shorter private directory.",
    );
  }
  return ok({
    directory: trimmed,
    socket,
    registry: `${trimmed}/registry.json`,
    snapshot: `${trimmed}/snapshot.json`,
    journal: `${trimmed}/requests.json`,
  });
};
