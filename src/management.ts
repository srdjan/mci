// @light-fp adapter
import type { RepositoryState, Request, Snapshot } from "./protocol.ts";
import { attempt, type Result } from "./result.ts";

type Rpc = (request: Request) => Promise<Result<Snapshot>>;
const resolveRepository = async (
  snapshot: Snapshot,
  input: string,
): Promise<RepositoryState | undefined> => {
  const direct = snapshot.repositories.find((r) => r.id === input || r.path === input);
  if (direct) return direct;
  const real = await attempt(() => Deno.realPath(input));
  return real.ok ? snapshot.repositories.find((r) => r.path === real.value) : undefined;
};
const summary = (r: RepositoryState): string => {
  const active = r.active
    ? `running ${r.active.job}${r.active.step ? `: ${r.active.step}` : ""}`
    : "idle";
  const latest = r.latest
    ? `last run ${r.latest.kind}: ${r.latest.detail} (${r.latest.finished})`
    : "no completed runs";
  return `${r.id} ${r.path}\n  ${active}; ${r.queued} queued; ${latest}${
    r.blocked ? `\n  blocked: ${r.blocked}` : ""
  }`;
};
const write = async (bytes: Uint8Array): Promise<boolean> => {
  let rest = bytes;
  while (rest.length > 0) {
    const next = await attempt(() => Deno.stdout.write(rest));
    if (!next.ok || next.value <= 0) return false;
    rest = rest.subarray(next.value);
  }
  return true;
};
const logs = async (repository: string, follow: boolean, rpc: Rpc): Promise<number> => {
  let cancelled = false;
  const stop = () => {
    cancelled = true;
  };
  if (follow) Deno.addSignalListener("SIGINT", stop);
  let path: string | undefined;
  let file: Deno.FsFile | undefined;
  const buffer = new Uint8Array(32 * 1024);
  try {
    do {
      const status = await rpc({ version: 1, op: "status" });
      if (!status.ok) {
        console.error(status.error);
        return 1;
      }
      const row = await resolveRepository(status.value, repository);
      if (!row) {
        console.error("Repository is not registered");
        return 1;
      }
      const selected = row.active?.log ?? row.latest?.log;
      if (selected === undefined && !follow) {
        console.error("No log exists for this repository");
        return 1;
      }
      if (selected !== undefined && selected !== path) {
        file?.close();
        file = undefined;
        const opened = await attempt(async () => {
          const info = await Deno.lstat(selected);
          if (!info.isFile || info.isSymlink) return undefined;
          return await Deno.open(selected, { read: true });
        });
        if (!opened.ok || opened.value === undefined) {
          console.error("Cannot read the selected log");
          return 1;
        }
        file = opened.value;
        path = selected;
      }
      if (file !== undefined) {
        while (true) {
          const next = await attempt(() => file?.read(buffer));
          if (!next.ok) {
            console.error(next.error);
            return 1;
          }
          if (next.value == null) break;
          if (!await write(buffer.subarray(0, next.value))) return 1;
        }
      }
      if (!follow) return 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    } while (!cancelled);
    return 130;
  } finally {
    file?.close();
    if (follow) Deno.removeSignalListener("SIGINT", stop);
  }
};

export const managementCommand = async (
  args: readonly string[],
  rpc: Rpc,
): Promise<number | null> => {
  const command = args[0];
  if (command === "register" || command === "unregister") {
    if (args.length !== 2 || !args[1]) {
      console.error(`Usage: mci ${command} <repository>`);
      return 2;
    }
    let request: Request;
    if (command === "register") {
      const path = await attempt(() => Deno.realPath(args[1]!));
      if (!path.ok) {
        console.error(path.error);
        return 2;
      }
      request = { version: 1, op: "register", path: path.value };
    } else {
      const current = await rpc({ version: 1, op: "status" });
      if (!current.ok) {
        console.error(current.error);
        return 1;
      }
      const selected = await resolveRepository(current.value, args[1]);
      request = { version: 1, op: "unregister", repository: selected?.id ?? args[1] };
    }
    const result = await rpc(request);
    if (!result.ok) {
      console.error(result.error);
      return 1;
    }
    console.log(
      command === "register"
        ? result.value.repositories.map(summary).join("\n")
        : "Repository unregistered",
    );
    return 0;
  }
  if (command === "status") {
    const json = args.includes("--json");
    const positional = args.slice(1).filter((arg) => arg !== "--json");
    if (
      positional.length > 1 || args.filter((arg) => arg === "--json").length > 1 ||
      positional.some((arg) => arg.startsWith("--"))
    ) {
      console.error("Usage: mci status [repository] [--json]");
      return 2;
    }
    const result = await rpc({ version: 1, op: "status" });
    if (!result.ok) {
      console.error(result.error);
      return 1;
    }
    const selected = positional[0]
      ? await resolveRepository(result.value, positional[0])
      : undefined;
    if (positional[0] && !selected) {
      console.error("Repository is not registered");
      return 1;
    }
    console.log(
      json
        ? JSON.stringify(selected ?? result.value, null, 2)
        : (selected
          ? summary(selected)
          : result.value.repositories.map(summary).join("\n") ||
            "No registered repositories"),
    );
    return 0;
  }
  if (command === "logs") {
    if (!args[1] || args.length > 3 || (args.length === 3 && args[2] !== "--follow")) {
      console.error("Usage: mci logs <repository> [--follow]");
      return 2;
    }
    return await logs(args[1], args[2] === "--follow", rpc);
  }
  return null;
};
