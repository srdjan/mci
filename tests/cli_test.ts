import { assert, equal, exists, fixture, inWorkspace, waitFor } from "./helpers.ts";

const entry = new URL("../src/main.ts", import.meta.url).pathname;
const config = new URL("../deno.json", import.meta.url).pathname;
const command = (workspace: string, args: readonly string[]) =>
  new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-sys=osRelease",
      "--config",
      config,
      entry,
      ...args,
    ],
    cwd: workspace,
    stdout: "piped",
    stderr: "piped",
  });
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

Deno.test("CLI check prints plan but never executes it", () =>
  inWorkspace(async (workspace) => {
    await Deno.writeTextFile(
      `${workspace}/ci.yml`,
      fixture("      - run: touch must-not-run"),
    );
    const result = await command(workspace, ["check", "ci.yml", "--job", "check"])
      .output();
    equal(result.code, 0);
    assert(text(result.stdout).includes("Valid plan"), text(result.stderr));
    assert(!await exists(`${workspace}/must-not-run`));
    const invalid = await command(workspace, ["check", "ci.yml"]).output();
    equal(invalid.code, 2);
  }));

Deno.test({
  name: "CLI rejects execution outside macOS",
  ignore: Deno.build.os === "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      const result = await command(workspace, ["run", "any.yml", "--job", "check"])
        .output();
      equal(result.code, 2);
      assert(text(result.stderr).includes("macOS only"));
    }),
});

Deno.test({
  name: "macOS CLI runs a job and forwards actual SIGINT",
  ignore: Deno.build.os !== "darwin",
  fn: () =>
    inWorkspace(async (workspace) => {
      await Deno.writeTextFile(
        `${workspace}/ci.yml`,
        fixture("      - run: echo ok > success"),
      );
      equal(
        (await command(workspace, ["run", "ci.yml", "--job", "check"]).output()).code,
        0,
      );
      assert(await exists(`${workspace}/success`));
      await Deno.writeTextFile(
        `${workspace}/ci.yml`,
        fixture(
          "      - run: |\n          touch ready\n          sleep 30\n      - run: touch skipped",
        ),
      );
      const child = command(workspace, ["run", "ci.yml", "--job", "check"]).spawn();
      const output = child.output();
      try {
        await waitFor(() => exists(`${workspace}/ready`));
      } finally {
        child.kill("SIGINT");
      }
      const result = await output;
      equal(result.code, 130);
      assert(!await exists(`${workspace}/skipped`));
    }),
});
