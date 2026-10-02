import { captureCommand } from "../src/command.ts";
import { assert, equal } from "./helpers.ts";

Deno.test("captureCommand returns status and standard output", async () => {
  const result = await captureCommand(
    "/bin/echo",
    { args: ["captured"] },
    { timeoutMs: 500, reapMs: 500 },
  );
  assert(result.ok);
  equal(result.value.status.code, 0);
  equal(new TextDecoder().decode(result.value.stdout), "captured\n");
});

Deno.test("captureCommand returns a launch failure", async () => {
  const result = await captureCommand(
    "/missing/meeci-command",
    {},
    { timeoutMs: 10, reapMs: 10 },
  );
  assert(!result.ok);
  assert(result.error.includes("Unable to launch command /missing/meeci-command"));
});

Deno.test("captureCommand kills and reaps a timed out command", async () => {
  const result = await captureCommand(
    "/bin/sleep",
    { args: ["10"] },
    { timeoutMs: 10, reapMs: 500 },
  );
  assert(!result.ok);
  equal(result.error, "Command /bin/sleep timed out after 10 ms");
});
