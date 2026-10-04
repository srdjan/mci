import { readCiStatus } from "../src/ci.ts";
import { assert, equal, inWorkspace, unwrap } from "./helpers.ts";

Deno.test("CI status reader distinguishes missing and invalid records", () =>
  inWorkspace(async (workspace) => {
    equal(unwrap(await readCiStatus(workspace)), null);
    await Deno.mkdir(`${workspace}/.mci/ci`, { recursive: true });
    await Deno.writeTextFile(
      `${workspace}/.mci/ci/status.json`,
      JSON.stringify({ version: 1, state: "pass" }),
    );
    const invalid = await readCiStatus(workspace);
    assert(!invalid.ok && invalid.error.includes("invalid CI status"));
  }));
