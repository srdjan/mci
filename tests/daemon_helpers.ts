// @light-fp adapter
import { rpc } from "../src/client.ts";
import { startDaemon } from "../src/daemon.ts";
import { assert } from "./helpers.ts";

export const withDaemon = async (
  workspace: string,
  test: (directory: string) => Promise<void>,
): Promise<void> => {
  const directory = await Deno.makeTempDir({ dir: "/tmp", prefix: "mci-service-" });
  const started = await startDaemon({ directory });
  assert(started.ok, started.ok ? "" : started.error);
  try {
    const registered = await rpc(
      { version: 1, op: "register", path: workspace },
      directory,
    );
    assert(registered.ok, registered.ok ? "" : registered.error);
    await test(directory);
  } finally {
    await started.value.close();
    await started.value.closed;
    await Deno.remove(directory, { recursive: true });
  }
};
