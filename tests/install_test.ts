import { type SetupCapabilities, type SetupOptions, setupWith } from "../src/install.ts";
import { err, ok } from "../src/result.ts";
import { assert, equal, exists, unwrap } from "./helpers.ts";

type Scene = {
  readonly root: string;
  readonly source: string;
  readonly applications: string;
  readonly destination: string;
  readonly legacy: string;
  readonly options: SetupOptions;
};

type Fake = {
  readonly calls: string[];
  readonly registrations: string[];
  readonly capabilities: SetupCapabilities;
};

type Overrides = Partial<SetupCapabilities>;

const withScene = async (test: (scene: Scene) => Promise<void>): Promise<void> => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "mci setup " }));
  try {
    const source = `${root}/package/mci Monitor.app`;
    const applications = `${root}/Applications`;
    const legacy = `${root}/state/monitor.json`;
    await Deno.mkdir(source, { recursive: true });
    await Deno.writeTextFile(`${source}/marker`, "new");
    await test({
      root,
      source,
      applications,
      destination: `${applications}/mci Monitor.app`,
      legacy,
      options: {
        sourceBundle: source,
        applicationsDirectory: applications,
        stateDirectory: `${root}/state`,
        daemonTimeoutMs: 30,
        pollMs: 2,
      },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

const fakeCapabilities = (overrides: Overrides = {}): Fake => {
  const calls: string[] = [];
  const registrations: string[] = [];
  const capabilities = {
    readOwner: () => {
      calls.push("owner");
      return Promise.resolve(ok("meeci"));
    },
    verifySignature: () => {
      calls.push("signature");
      return Promise.resolve(ok(undefined));
    },
    copyBundle: async (source: string, destination: string) => {
      calls.push("copy");
      await Deno.mkdir(destination, { recursive: true });
      await Deno.copyFile(`${source}/marker`, `${destination}/marker`);
      return ok(undefined);
    },
    rename: async (source: string, destination: string) => {
      calls.push("rename");
      await Deno.rename(source, destination);
      return ok(undefined);
    },
    remove: async (path: string) => {
      calls.push("remove");
      await Deno.remove(path, { recursive: true }).catch(() => {});
      return ok(undefined);
    },
    quit: () => {
      calls.push("quit");
      return Promise.resolve(ok(undefined));
    },
    startService: () => {
      calls.push("service");
      return Promise.resolve(ok(true));
    },
    stopService: () => {
      calls.push("stop");
      return Promise.resolve(ok(undefined));
    },
    ping: () => {
      calls.push("ping");
      return Promise.resolve(ok(undefined));
    },
    register: (repository: string) => {
      calls.push("register");
      registrations.push(repository);
      return Promise.resolve(ok(undefined));
    },
    open: () => {
      calls.push("open");
      return Promise.resolve(ok(undefined));
    },
    ...overrides,
  };
  return { calls, registrations, capabilities };
};

Deno.test("repeated setup does not replay the preserved legacy registry", async () => {
  await withScene(async (scene) => {
    const one = `${scene.root}/one`;
    const two = `${scene.root}/two`;
    await Deno.mkdir(one);
    await Deno.mkdir(two);
    await Deno.mkdir(`${scene.root}/state`);
    await Deno.writeTextFile(
      scene.legacy,
      `${JSON.stringify({ version: 1, workspaces: [one, two] }, null, 2)}\n`,
    );
    const fake = fakeCapabilities();
    unwrap(await setupWith(scene.options, fake.capabilities));
    unwrap(await setupWith(scene.options, fake.capabilities));
    equal(await Deno.readTextFile(`${scene.destination}/marker`), "new");
    equal(
      JSON.parse(await Deno.readTextFile(scene.legacy)),
      { version: 1, workspaces: [one, two] },
    );
    equal(fake.registrations, []);
    assert(!fake.calls.includes("service"));
    equal(
      await Array.fromAsync(Deno.readDir(scene.applications)).then((items) =>
        items.map((item) => item.name)
      ),
      ["mci Monitor.app"],
    );
  });
});

Deno.test("setup refuses a foreign destination before it copies files", async () => {
  await withScene(async (scene) => {
    await Deno.mkdir(scene.destination, { recursive: true });
    await Deno.writeTextFile(`${scene.destination}/marker`, "foreign");
    const fake = fakeCapabilities({
      readOwner: (bundle) =>
        Promise.resolve(ok(bundle === scene.source ? "meeci" : "other")),
    });
    const result = await setupWith(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("not owned"));
    equal(await Deno.readTextFile(`${scene.destination}/marker`), "foreign");
    assert(!fake.calls.includes("copy"));
  });
});

Deno.test("setup restores the old app when the service fails", async () => {
  await withScene(async (scene) => {
    await Deno.mkdir(scene.destination, { recursive: true });
    await Deno.writeTextFile(`${scene.destination}/marker`, "old");
    const fake = fakeCapabilities({
      ping: () => Promise.resolve(err("daemon unavailable")),
      startService: () => Promise.resolve(err("brew failed")),
    });
    const result = await setupWith(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("brew failed"));
    assert(result.error.includes("old app was restored"));
    equal(await Deno.readTextFile(`${scene.destination}/marker`), "old");
    assert(fake.calls.includes("quit"));
    assert(fake.calls.includes("open"));
    assert(!fake.calls.includes("stop"));
    assert(!await exists(`${scene.applications}/.mci-monitor-staging-test.app`));
  });
});

Deno.test("setup starts the service only when the daemon is unavailable", async () => {
  await withScene(async (scene) => {
    let pingCount = 0;
    const fake = fakeCapabilities({
      ping: () => {
        pingCount += 1;
        return Promise.resolve(pingCount === 1 ? err("offline") : ok(undefined));
      },
    });
    unwrap(await setupWith(scene.options, fake.capabilities));
    equal(fake.calls.filter((call) => call === "service"), ["service"]);
    assert(pingCount >= 2);
  });
});

Deno.test("setup validates the packaged signature before changing the destination", async () => {
  await withScene(async (scene) => {
    const fake = fakeCapabilities({
      verifySignature: () => Promise.resolve(err("unsigned")),
    });
    const result = await setupWith(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("unsigned"));
    assert(!await exists(scene.applications));
  });
});

Deno.test("setup removes the unique staging path after a partial copy", async () => {
  await withScene(async (scene) => {
    let staging = "";
    const fake = fakeCapabilities({
      copyBundle: async (_source, destination) => {
        staging = destination;
        await Deno.mkdir(destination, { recursive: true });
        await Deno.writeTextFile(`${destination}/partial`, "partial");
        return err("copy failed after partial output");
      },
    });
    const result = await setupWith(scene.options, fake.capabilities);
    assert(!result.ok);
    assert(result.error.includes("copy failed after partial output"));
    assert(staging.startsWith(`${scene.applications}/.mci-monitor-staging-`));
    assert(staging.endsWith(".app"));
    assert(!await exists(staging));
  });
});

Deno.test("setup preserves copy and staging cleanup failures", async () => {
  await withScene(async (scene) => {
    let staging = "";
    const fake = fakeCapabilities({
      copyBundle: async (_source, destination) => {
        staging = destination;
        await Deno.mkdir(destination, { recursive: true });
        return err("copy failed after partial output");
      },
      remove: () => Promise.resolve(err("cleanup failed")),
    });
    const result = await setupWith(scene.options, fake.capabilities);
    assert(!result.ok);
    assert(result.error.includes("copy failed after partial output"));
    assert(result.error.includes("staging cleanup failed: cleanup failed"));
    assert(await exists(staging));
  });
});

Deno.test("setup restores the old app when the new app does not open", async () => {
  await withScene(async (scene) => {
    await Deno.mkdir(scene.destination, { recursive: true });
    await Deno.writeTextFile(`${scene.destination}/marker`, "old");
    let opens = 0;
    const fake = fakeCapabilities({
      open: () => {
        opens += 1;
        return Promise.resolve(opens === 1 ? err("open failed") : ok(undefined));
      },
    });
    const result = await setupWith(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("open failed"));
    equal(await Deno.readTextFile(`${scene.destination}/marker`), "old");
    equal(opens, 2);
    assert(!fake.calls.includes("stop"));
  });
});

Deno.test("setup stops its service before rollback when readiness fails", async () => {
  await withScene(async (scene) => {
    await Deno.mkdir(scene.destination, { recursive: true });
    await Deno.writeTextFile(`${scene.destination}/marker`, "old");
    const fake = fakeCapabilities({
      ping: () => Promise.resolve(err("daemon unavailable")),
    });
    const result = await setupWith(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("did not start"));
    equal(await Deno.readTextFile(`${scene.destination}/marker`), "old");
    assert(fake.calls.includes("service"));
    assert(fake.calls.includes("open"));
    assert(fake.calls.indexOf("service") < fake.calls.indexOf("stop"));
    assert(fake.calls.indexOf("stop") < fake.calls.indexOf("remove"));
  });
});

Deno.test("setup stops its service before rollback when the new app does not open", async () => {
  await withScene(async (scene) => {
    await Deno.mkdir(scene.destination, { recursive: true });
    await Deno.writeTextFile(`${scene.destination}/marker`, "old");
    let pings = 0;
    let opens = 0;
    const events: string[] = [];
    const fake = fakeCapabilities({
      ping: () => {
        pings += 1;
        return Promise.resolve(pings === 1 ? err("offline") : ok(undefined));
      },
      startService: () => {
        events.push("service");
        return Promise.resolve(ok(true));
      },
      stopService: () => {
        events.push("stop");
        return Promise.resolve(ok(undefined));
      },
      open: () => {
        opens += 1;
        events.push("open");
        return Promise.resolve(opens === 1 ? err("new app did not open") : ok(undefined));
      },
      remove: async (path) => {
        events.push("remove");
        await Deno.remove(path, { recursive: true });
        return ok(undefined);
      },
    });
    const result = await setupWith(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("new app did not open"));
    equal(await Deno.readTextFile(`${scene.destination}/marker`), "old");
    equal(events, ["service", "open", "stop", "remove", "open"]);
  });
});

Deno.test("setup preserves stop failure diagnostics and restores the old app", async () => {
  await withScene(async (scene) => {
    await Deno.mkdir(scene.destination, { recursive: true });
    await Deno.writeTextFile(`${scene.destination}/marker`, "old");
    const fake = fakeCapabilities({
      ping: () => Promise.resolve(err("daemon remains unavailable")),
      stopService: () => Promise.resolve(err("brew stop failed")),
    });
    const result = await setupWith(scene.options, fake.capabilities);
    assert(!result.ok);
    assert(result.error.includes("daemon remains unavailable"));
    assert(result.error.includes("Service rollback failed: brew stop failed."));
    assert(result.error.includes("old app was restored"));
    assert(
      result.error.indexOf("daemon remains unavailable") <
        result.error.indexOf("Service rollback failed"),
    );
    assert(
      result.error.indexOf("Service rollback failed") <
        result.error.indexOf("old app was restored"),
    );
    equal(await Deno.readTextFile(`${scene.destination}/marker`), "old");
  });
});

Deno.test("setup preserves a pre-existing service when readiness fails", async () => {
  await withScene(async (scene) => {
    await Deno.mkdir(scene.destination, { recursive: true });
    await Deno.writeTextFile(`${scene.destination}/marker`, "old");
    let starts = 0;
    const fake = fakeCapabilities({
      ping: () => Promise.resolve(err("daemon remains unavailable")),
      startService: () => {
        starts += 1;
        return Promise.resolve(ok(false));
      },
    });
    const result = await setupWith(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("daemon remains unavailable"));
    equal(starts, 1);
    assert(!fake.calls.includes("stop"));
    equal(await Deno.readTextFile(`${scene.destination}/marker`), "old");
  });
});
