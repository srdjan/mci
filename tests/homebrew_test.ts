import { findBrewWith } from "../src/homebrew.ts";
import { err, ok, type Result } from "../src/result.ts";
import { assert, equal } from "./helpers.ts";

const appleSiliconBrew = "/opt/homebrew/bin/brew";
const intelBrew = "/usr/local/bin/brew";

type Inspection = Result<{ readonly isFile: boolean }>;

const inspectFrom = (
  inspections: Readonly<Record<string, Inspection>>,
  calls: string[],
): (path: string) => Promise<Inspection> => {
  return (path) => {
    calls.push(path);
    return Promise.resolve(inspections[path] ?? err(`Unexpected path: ${path}`));
  };
};

Deno.test("Homebrew locator selects the Apple Silicon location", async () => {
  const calls: string[] = [];
  const result = await findBrewWith(inspectFrom({
    [appleSiliconBrew]: ok({ isFile: true }),
  }, calls));

  equal(result, ok(appleSiliconBrew));
  equal(calls, [appleSiliconBrew]);
});

Deno.test("Homebrew locator selects the Intel location", async () => {
  const calls: string[] = [];
  const result = await findBrewWith(inspectFrom({
    [appleSiliconBrew]: err("missing"),
    [intelBrew]: ok({ isFile: true }),
  }, calls));

  equal(result, ok(intelBrew));
  equal(calls, [appleSiliconBrew, intelBrew]);
});

Deno.test("Homebrew locator gives the Apple Silicon location precedence", async () => {
  const calls: string[] = [];
  const result = await findBrewWith(inspectFrom({
    [appleSiliconBrew]: ok({ isFile: true }),
    [intelBrew]: ok({ isFile: true }),
  }, calls));

  equal(result, ok(appleSiliconBrew));
  equal(calls, [appleSiliconBrew]);
});

Deno.test("Homebrew locator skips a location that is not a file", async () => {
  const result = await findBrewWith(inspectFrom({
    [appleSiliconBrew]: ok({ isFile: false }),
    [intelBrew]: ok({ isFile: true }),
  }, []));

  equal(result, ok(intelBrew));
});

Deno.test("Homebrew locator skips a location that cannot be inspected", async () => {
  const result = await findBrewWith(inspectFrom({
    [appleSiliconBrew]: err("inspection failed"),
    [intelBrew]: ok({ isFile: true }),
  }, []));

  equal(result, ok(intelBrew));
});

Deno.test("Homebrew locator reports absence after checking each location", async () => {
  const calls: string[] = [];
  const result = await findBrewWith(inspectFrom({
    [appleSiliconBrew]: err("missing"),
    [intelBrew]: ok({ isFile: false }),
  }, calls));

  assert(!result.ok);
  equal(result.error, "Homebrew was not found at /opt/homebrew or /usr/local.");
  equal(calls, [appleSiliconBrew, intelBrew]);
});

Deno.test("native Homebrew locator ignores restricted PATH", async () => {
  const moduleUrl = new URL("../src/homebrew.ts", import.meta.url).href;
  const source = `
    import { findBrew } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await findBrew()));
  `;
  const command = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--allow-read", source],
    env: { PATH: "/bin:/usr/bin" },
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const expected = await findBrewWith(async (path) => {
    try {
      return ok(await Deno.stat(path));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  });

  assert(output.success, new TextDecoder().decode(output.stderr));
  equal(new TextDecoder().decode(output.stdout).trim(), JSON.stringify(expected));
});
