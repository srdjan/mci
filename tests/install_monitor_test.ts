import {
  infoPlist,
  installMonitor,
  type MonitorCapabilities,
  type MonitorOptions,
} from "../scripts/install-monitor.ts";
import { canonicalDirectory } from "../scripts/registry.ts";
import { err, ok, type Result } from "../src/result.ts";
import { assert, equal, exists, unwrap } from "./helpers.ts";

type Scene = {
  readonly root: string;
  readonly applications: string;
  readonly registry: string;
  readonly workspace: string;
  readonly destination: string;
  readonly options: MonitorOptions;
};

const withScene = async (test: (scene: Scene) => Promise<void>): Promise<void> => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "mci monitor " }));
  try {
    const workspace = `${root}/work space`;
    await Deno.mkdir(workspace);
    const applications = `${root}/Applications`;
    const registry = `${root}/registry`;
    await test({
      root,
      applications,
      registry,
      workspace,
      destination: `${applications}/mci Monitor.app`,
      options: {
        workspace,
        applicationsDir: applications,
        version: "9.8.7",
        packageDir: `${root}/package`,
        runningTimeoutMs: 40,
        pollMs: 5,
      },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

type Fake = {
  readonly calls: string[];
  readonly registered: string[];
  readonly capabilities: MonitorCapabilities;
};

type Overrides = Partial<MonitorCapabilities> & { readonly binary?: string };

const installerKey = async (bundle: string): Promise<Result<string>> => {
  try {
    const plist = await Deno.readTextFile(`${bundle}/Contents/Info.plist`);
    const match = /<key>MCIInstaller<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
    return match?.[1] === undefined ? err("no MCIInstaller") : ok(match[1]);
  } catch (error) {
    return err(String(error));
  }
};

const fakeCapabilities = (root: string, overrides: Overrides = {}): Fake => {
  const calls: string[] = [];
  const registered: string[] = [];
  let opened = false;
  const capabilities: MonitorCapabilities = {
    swiftAvailable: () => {
      calls.push("swift");
      return overrides.swiftAvailable?.() ?? Promise.resolve(true);
    },
    buildApp: async (packageDir) => {
      calls.push("build");
      if (overrides.buildApp !== undefined) return await overrides.buildApp(packageDir);
      const binary = `${root}/build-output`;
      await Deno.writeTextFile(binary, overrides.binary ?? "binary one");
      return ok(binary);
    },
    sign: (bundle) => {
      calls.push("sign");
      return overrides.sign?.(bundle) ?? Promise.resolve(ok(undefined));
    },
    verify: (bundle) => {
      calls.push("verify");
      return overrides.verify?.(bundle) ?? Promise.resolve(ok(undefined));
    },
    readInstallerKey: (bundle) => {
      calls.push("key");
      return overrides.readInstallerKey?.(bundle) ?? installerKey(bundle);
    },
    quit: (executablePath) => {
      calls.push("quit");
      return overrides.quit?.(executablePath) ?? Promise.resolve(ok(undefined));
    },
    open: (bundle) => {
      calls.push("open");
      if (overrides.open !== undefined) return overrides.open(bundle);
      opened = true;
      return Promise.resolve(ok(undefined));
    },
    isRunning: (executablePath) => {
      calls.push("running");
      return overrides.isRunning?.(executablePath) ?? Promise.resolve(ok(opened));
    },
    rename: async (from, to) => {
      calls.push("rename");
      if (overrides.rename !== undefined) return await overrides.rename(from, to);
      await Deno.rename(from, to);
      return ok(undefined);
    },
    register: (workspace) => {
      calls.push("register");
      registered.push(workspace);
      return overrides.register?.(workspace) ?? Promise.resolve(ok(undefined));
    },
  };
  return { calls, registered, capabilities };
};

const names = async (directory: string): Promise<string[]> => {
  const found: string[] = [];
  for await (const entry of Deno.readDir(directory)) found.push(entry.name);
  return found.sort();
};

const writeBundle = async (
  destination: string,
  plist: string,
  marker: string,
): Promise<void> => {
  await Deno.mkdir(`${destination}/Contents/MacOS`, { recursive: true });
  await Deno.writeTextFile(`${destination}/Contents/Info.plist`, plist);
  await Deno.writeTextFile(`${destination}/Contents/MacOS/MonitorApp`, marker);
};

const readMarker = (destination: string): Promise<string> =>
  Deno.readTextFile(`${destination}/Contents/MacOS/MonitorApp`);

Deno.test("fresh install builds, stages, signs, registers, and opens", async () => {
  await withScene(async (scene) => {
    const fake = fakeCapabilities(scene.root);
    const installed = unwrap(await installMonitor(scene.options, fake.capabilities));
    equal(installed.bundle, scene.destination);
    equal(installed.workspace, scene.workspace);
    equal(installed.warnings, []);
    equal(fake.calls, [
      "swift",
      "build",
      "sign",
      "verify",
      "rename",
      "register",
      "open",
      "running",
    ]);
    equal(fake.registered, [scene.workspace]);
    equal(await names(scene.applications), ["mci Monitor.app"]);
    const executable = `${scene.destination}/Contents/MacOS/MonitorApp`;
    equal(await Deno.readTextFile(executable), "binary one");
    equal((await Deno.stat(executable)).mode! & 0o777, 0o755);
    const plist = await Deno.readTextFile(`${scene.destination}/Contents/Info.plist`);
    equal(plist, infoPlist("9.8.7"));
    for (
      const line of [
        "<key>CFBundleIdentifier</key>\n  <string>dev.mci.monitor</string>",
        "<key>CFBundleName</key>\n  <string>mci Monitor</string>",
        "<key>CFBundleDisplayName</key>\n  <string>mci Monitor</string>",
        "<key>CFBundleExecutable</key>\n  <string>MonitorApp</string>",
        "<key>CFBundlePackageType</key>\n  <string>APPL</string>",
        "<key>CFBundleShortVersionString</key>\n  <string>9.8.7</string>",
        "<key>CFBundleVersion</key>\n  <string>9.8.7</string>",
        "<key>LSUIElement</key>\n  <true/>",
        "<key>LSMinimumSystemVersion</key>\n  <string>14.0</string>",
        "<key>NSHighResolutionCapable</key>\n  <true/>",
        "<key>MCIInstaller</key>\n  <string>mci</string>",
      ]
    ) assert(plist.includes(line), `Info.plist lacks ${line}`);
    assert(!await exists(scene.registry));
  });
});

Deno.test("Info.plist escapes XML in the version", () => {
  assert(infoPlist("1<&>2").includes("<string>1&lt;&amp;&gt;2</string>"));
});

Deno.test("reinstall replaces an owned bundle and leaves no staging or backup", async () => {
  await withScene(async (scene) => {
    unwrap(
      await installMonitor(scene.options, fakeCapabilities(scene.root).capabilities),
    );
    const second = fakeCapabilities(scene.root, { binary: "binary two" });
    unwrap(
      await installMonitor(
        { ...scene.options, version: "9.8.8" },
        second.capabilities,
      ),
    );
    equal(second.calls, [
      "swift",
      "build",
      "sign",
      "verify",
      "key",
      "quit",
      "rename",
      "rename",
      "register",
      "open",
      "running",
    ]);
    equal(await readMarker(scene.destination), "binary two");
    assert(
      (await Deno.readTextFile(`${scene.destination}/Contents/Info.plist`)).includes(
        "<string>9.8.8</string>",
      ),
    );
    equal(await names(scene.applications), ["mci Monitor.app"]);
    equal(second.registered, [scene.workspace]);
  });
});

const legacyPlist = () =>
  infoPlist("1.0.0").replace("<string>mci</string>", "<string>meeci</string>");

Deno.test("legacy monitor migration requires an explicit previous owner", async () => {
  await withScene(async (scene) => {
    await writeBundle(scene.destination, legacyPlist(), "old");
    const refused = await installMonitor(
      scene.options,
      fakeCapabilities(scene.root).capabilities,
    );
    assert(!refused.ok);
    equal(await readMarker(scene.destination), "old");
    unwrap(
      await installMonitor(
        { ...scene.options, previousOwners: ["meeci"] },
        fakeCapabilities(scene.root).capabilities,
      ),
    );
    equal(unwrap(await installerKey(scene.destination)), "mci");
    equal(await readMarker(scene.destination), "binary one");
  });
});

Deno.test("legacy monitor migration restores the previous app after registration fails", async () => {
  await withScene(async (scene) => {
    await writeBundle(scene.destination, legacyPlist(), "old");
    const result = await installMonitor(
      { ...scene.options, previousOwners: ["meeci"] },
      fakeCapabilities(scene.root, {
        register: () => Promise.resolve(err("daemon unavailable")),
      }).capabilities,
    );
    assert(!result.ok && result.error.includes("The old app was restored and opened."));
    equal(unwrap(await installerKey(scene.destination)), "meeci");
    equal(await readMarker(scene.destination), "old");
    equal(await names(scene.applications), ["mci Monitor.app"]);
  });
});

Deno.test("legacy monitor migration leaves an app with an invalid signature unchanged", async () => {
  await withScene(async (scene) => {
    await writeBundle(scene.destination, legacyPlist(), "old");
    const result = await installMonitor(
      { ...scene.options, previousOwners: ["meeci"] },
      fakeCapabilities(scene.root, {
        verify: (bundle) =>
          Promise.resolve(
            bundle === scene.destination ? err("signature mismatch") : ok(undefined),
          ),
      }).capabilities,
    );
    assert(!result.ok && result.error.includes("invalid signature"));
    equal(await readMarker(scene.destination), "old");
  });
});

Deno.test("a bundle without the mci key is refused and left untouched", async () => {
  const foreign = [
    `<plist><dict><key>CFBundleName</key><string>Other</string></dict></plist>`,
    `<plist><dict><key>MCIInstaller</key><string>someone</string></dict></plist>`,
  ];
  for (const plist of foreign) {
    await withScene(async (scene) => {
      await writeBundle(scene.destination, plist, "foreign");
      const fake = fakeCapabilities(scene.root);
      const result = await installMonitor(scene.options, fake.capabilities);
      assert(!result.ok && result.error.includes("was not installed by mci"));
      equal(await readMarker(scene.destination), "foreign");
      equal(await Deno.readTextFile(`${scene.destination}/Contents/Info.plist`), plist);
      equal(await names(scene.applications), ["mci Monitor.app"]);
      assert(!fake.calls.includes("quit") && !fake.calls.includes("open"));
      assert(!await exists(scene.registry));
    });
  }
});

Deno.test("an owned bundle without an executable is refused", async () => {
  await withScene(async (scene) => {
    await writeBundle(scene.destination, infoPlist("1.0.0"), "x");
    await Deno.remove(`${scene.destination}/Contents/MacOS/MonitorApp`);
    const result = await installMonitor(
      scene.options,
      fakeCapabilities(scene.root).capabilities,
    );
    assert(!result.ok && result.error.includes("has no MonitorApp executable"));
    equal(await names(scene.applications), ["mci Monitor.app"]);
  });
});

Deno.test("a symlink destination is refused and left untouched", async () => {
  await withScene(async (scene) => {
    const target = `${scene.root}/elsewhere.app`;
    await writeBundle(target, infoPlist("1.0.0"), "target");
    await Deno.mkdir(scene.applications);
    await Deno.symlink(target, scene.destination);
    const fake = fakeCapabilities(scene.root);
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("not a real folder"));
    assert((await Deno.lstat(scene.destination)).isSymlink);
    equal(await readMarker(target), "target");
    equal(await names(scene.applications), ["mci Monitor.app"]);
    assert(!fake.calls.includes("quit"));
  });
});

Deno.test("a signing or verify failure keeps the old bundle and removes staging", async () => {
  const failures: readonly Overrides[] = [
    { sign: () => Promise.resolve(err("sign broke")) },
    { verify: () => Promise.resolve(err("verify broke")) },
  ];
  for (const failure of failures) {
    await withScene(async (scene) => {
      await writeBundle(scene.destination, infoPlist("1.0.0"), "old");
      const fake = fakeCapabilities(scene.root, failure);
      const result = await installMonitor(scene.options, fake.capabilities);
      assert(!result.ok && result.error.includes("broke"));
      equal(await readMarker(scene.destination), "old");
      equal(await names(scene.applications), ["mci Monitor.app"]);
      assert(!fake.calls.includes("quit") && !fake.calls.includes("open"));
      assert(!await exists(scene.registry));
    });
  }
});

Deno.test("missing swift fails before the build and before any change", async () => {
  await withScene(async (scene) => {
    const fake = fakeCapabilities(scene.root, {
      swiftAvailable: () => Promise.resolve(false),
    });
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("swift is not available"));
    equal(fake.calls, ["swift"]);
    assert(!await exists(scene.applications));
    assert(!await exists(scene.registry));
  });
});

Deno.test("a build failure changes nothing", async () => {
  await withScene(async (scene) => {
    const fake = fakeCapabilities(scene.root, {
      buildApp: () => Promise.resolve(err("compile error")),
    });
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("compile error"));
    assert(!await exists(scene.applications));
    assert(!await exists(scene.registry));
  });
});

Deno.test("an app that does not start is an error after daemon registration", async () => {
  await withScene(async (scene) => {
    const fake = fakeCapabilities(scene.root, {
      isRunning: () => Promise.resolve(ok(false)),
    });
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("did not start"));
    equal(await readMarker(scene.destination), "binary one");
    equal(fake.registered, [scene.workspace]);
    assert(!await exists(scene.registry));
  });
});

Deno.test("a daemon registration failure prevents the app from opening", async () => {
  await withScene(async (scene) => {
    const fake = fakeCapabilities(scene.root, {
      register: () => Promise.resolve(err("daemon unavailable")),
    });
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("daemon unavailable"));
    assert(!fake.calls.includes("open"));
    assert(!await exists(scene.registry));
  });
});

Deno.test("a failed rename into place restores the old bundle", async () => {
  await withScene(async (scene) => {
    await writeBundle(scene.destination, infoPlist("1.0.0"), "old");
    const fake = fakeCapabilities(scene.root, {
      rename: async (from, to) => {
        if (from.includes(".mci-monitor-staging-")) return err("rename refused");
        await Deno.rename(from, to);
        return ok(undefined);
      },
    });
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok && result.error.includes("rename refused"));
    assert(result.error.includes("The old app is restored"));
    equal(await readMarker(scene.destination), "old");
    equal(await names(scene.applications), ["mci Monitor.app"]);
    assert(!fake.calls.includes("open"));
    assert(!await exists(scene.registry));
  });
});

const backupPrefix = ".mci-monitor-backup-";

const backupOf = async (scene: Scene): Promise<string | undefined> =>
  (await names(scene.applications)).find((name) => name.startsWith(backupPrefix));

const withOwnedScene = (test: (scene: Scene) => Promise<void>): Promise<void> =>
  withScene(async (scene) => {
    await writeBundle(scene.destination, infoPlist("1.0.0"), "old");
    await test(scene);
  });

Deno.test("a registration failure on reinstall restores and opens the old app", async () => {
  await withOwnedScene(async (scene) => {
    const fake = fakeCapabilities(scene.root, {
      register: () => Promise.resolve(err("daemon unavailable")),
    });
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok);
    assert(result.error.includes("daemon unavailable"), result.error);
    assert(result.error.includes("The old app was restored and opened."), result.error);
    assert(!result.error.includes(".."), result.error);
    equal(await readMarker(scene.destination), "old");
    equal(await names(scene.applications), ["mci Monitor.app"]);
    equal(
      fake.calls.slice(-6),
      ["rename", "rename", "register", "quit", "rename", "open"],
    );
  });
});

Deno.test("an open failure on reinstall quits the new app and restores the old app", async () => {
  await withOwnedScene(async (scene) => {
    let opens = 0;
    const fake = fakeCapabilities(scene.root, {
      open: () => {
        opens += 1;
        return Promise.resolve(opens === 1 ? err("open refused") : ok(undefined));
      },
    });
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok);
    assert(result.error.includes("open refused"), result.error);
    assert(result.error.includes("restored and opened"), result.error);
    assert(!result.error.includes(".."), result.error);
    equal(await readMarker(scene.destination), "old");
    equal(await names(scene.applications), ["mci Monitor.app"]);
    equal(fake.calls.slice(-5), ["register", "open", "quit", "rename", "open"]);
  });
});

Deno.test("a startup failure on reinstall restores and opens the old app", async () => {
  await withOwnedScene(async (scene) => {
    const fake = fakeCapabilities(scene.root, {
      isRunning: () => Promise.resolve(ok(false)),
    });
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok);
    equal(
      result.error,
      "The app did not start within 40 ms. The old app was restored and opened.",
    );
    equal(await readMarker(scene.destination), "old");
    equal(await names(scene.applications), ["mci Monitor.app"]);
  });
});

Deno.test("a restore failure names the retained backup", async () => {
  await withOwnedScene(async (scene) => {
    const fake = fakeCapabilities(scene.root, {
      register: () => Promise.resolve(err("daemon unavailable")),
      rename: async (from, to) => {
        if (from.includes(backupPrefix)) return err("restore refused");
        await Deno.rename(from, to);
        return ok(undefined);
      },
    });
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok);
    const backup = await backupOf(scene);
    assert(backup !== undefined, "the backup folder is kept");
    const backupPath = `${scene.applications}/${backup}`;
    assert(
      result.error.includes("Rollback failed. The old app remains at"),
      result.error,
    );
    assert(result.error.includes(backupPath), result.error);
    assert(result.error.includes("restore refused"), result.error);
    assert(!result.error.includes(".."), result.error);
    equal(await readMarker(backupPath), "old");
    assert(!await exists(scene.destination));
  });
});

Deno.test("a reopen failure after restoration keeps the restored old app", async () => {
  await withOwnedScene(async (scene) => {
    const fake = fakeCapabilities(scene.root, {
      open: () => Promise.resolve(err("open refused")),
    });
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok);
    assert(result.error.includes("Cannot open the app"), result.error);
    assert(result.error.includes("restored, but it did not open"), result.error);
    assert(!result.error.includes(".."), result.error);
    equal(await readMarker(scene.destination), "old");
    equal(await names(scene.applications), ["mci Monitor.app"]);
  });
});

Deno.test("a quit failure during rollback leaves the new app and the backup", async () => {
  await withOwnedScene(async (scene) => {
    let quits = 0;
    const fake = fakeCapabilities(scene.root, {
      register: () => Promise.resolve(err("daemon unavailable")),
      quit: () => {
        quits += 1;
        return Promise.resolve(quits === 1 ? ok(undefined) : err("quit refused"));
      },
    });
    const result = await installMonitor(scene.options, fake.capabilities);
    assert(!result.ok);
    const backup = await backupOf(scene);
    assert(backup !== undefined, "the backup folder is kept");
    const backupPath = `${scene.applications}/${backup}`;
    assert(result.error.includes("could not quit the new app"), result.error);
    assert(result.error.includes(backupPath), result.error);
    assert(!result.error.includes(".."), result.error);
    equal(await readMarker(scene.destination), "binary one");
    equal(await readMarker(backupPath), "old");
    equal(fake.calls.slice(-2), ["register", "quit"]);
  });
});

Deno.test("the backup stays until the new app runs and is removed afterwards", async () => {
  await withOwnedScene(async (scene) => {
    let during: string[] = [];
    const fake = fakeCapabilities(scene.root, {
      isRunning: async () => {
        during = await names(scene.applications);
        return ok(true);
      },
    });
    unwrap(await installMonitor(scene.options, fake.capabilities));
    assert(during.some((name) => name.startsWith(backupPrefix)), during.join(","));
    equal(await names(scene.applications), ["mci Monitor.app"]);
    equal(await readMarker(scene.destination), "binary one");
  });
});

Deno.test("a removal failure during rollback names the backup", async () => {
  await withOwnedScene(async (scene) => {
    const contents = `${scene.destination}/Contents`;
    try {
      const fake = fakeCapabilities(scene.root, {
        register: async () => {
          await Deno.chmod(contents, 0o555);
          return err("daemon unavailable");
        },
      });
      const result = await installMonitor(scene.options, fake.capabilities);
      assert(!result.ok);
      const backup = await backupOf(scene);
      assert(backup !== undefined, "the backup folder is kept");
      const backupPath = `${scene.applications}/${backup}`;
      assert(result.error.includes("Rollback could not remove"), result.error);
      assert(result.error.includes(backupPath), result.error);
      assert(!result.error.includes(".."), result.error);
      equal(await readMarker(backupPath), "old");
    } finally {
      await Deno.chmod(contents, 0o755);
    }
  });
});

Deno.test("a relative or missing workspace is refused before the build", async () => {
  await withScene(async (scene) => {
    for (const workspace of ["relative/path", `${scene.root}/absent`]) {
      const fake = fakeCapabilities(scene.root);
      const result = await installMonitor(
        { ...scene.options, workspace },
        fake.capabilities,
      );
      assert(!result.ok);
      assert(!fake.calls.includes("build"));
    }
  });
});

Deno.test("canonicalDirectory resolves links and rejects invalid repositories", async () => {
  await withScene(async (scene) => {
    const link = `${scene.root}/link`;
    await Deno.symlink(scene.workspace, link);
    equal(unwrap(await canonicalDirectory(link)), scene.workspace);
    const file = `${scene.root}/file.txt`;
    await Deno.writeTextFile(file, "x");
    for (const path of ["relative", file, `${scene.root}/absent`]) {
      assert(!(await canonicalDirectory(path)).ok, path);
    }
  });
});

const runMain = async (args: readonly string[]) => {
  const script = new URL("../scripts/install-monitor.ts", import.meta.url).pathname;
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--allow-read",
      "--allow-write",
      "--allow-env=HOME",
      "--allow-run=swift,/usr/bin/codesign,/usr/bin/open,/usr/bin/pkill,/usr/bin/pgrep,/usr/bin/plutil",
      script,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stderr: new TextDecoder().decode(output.stderr),
  };
};

Deno.test("main rejects a relative workspace with exit 2", async () => {
  const result = await runMain(["relative/path"]);
  equal(result.code, 2);
  assert(result.stderr.includes("workspace must be an absolute path"));
});

Deno.test("main rejects extra arguments with the usage text and exit 2", async () => {
  const result = await runMain(["/one", "/two"]);
  equal(result.code, 2);
  assert(result.stderr.includes("usage: deno task monitor:install [workspace]"));
});
