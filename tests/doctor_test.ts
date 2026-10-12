import { type DoctorCapabilities, type DoctorCheck, doctorWith } from "../src/hooks.ts";
import type { Snapshot } from "../src/protocol.ts";
import { err, ok } from "../src/result.ts";
import { equal, unwrap } from "./helpers.ts";

const repository = {
  id: "repository-1",
  path: "/work/repository",
  queued: 0,
  active: null,
  latest: null,
  blocked: null,
} as const;

const snapshot = (blocked: string | null = null): Snapshot => ({
  version: 1,
  instance: "doctor-test",
  pid: 1234,
  updated: "2026-10-08T12:00:00.000Z",
  repositories: [{ ...repository, blocked }],
});

const capabilities = (
  overrides: Partial<DoctorCapabilities> = {},
): DoctorCapabilities => ({
  platform: "darwin",
  command: (executable, args) =>
    Promise.resolve(
      executable === "/usr/bin/env" && args.join(" ") === "deno --version"
        ? ok({ code: 0, stdout: "deno 2.9.7\nv8 test\n", stderr: "" })
        : executable === "/bin/bash" && args.join(" ") === "--version"
        ? ok({ code: 0, stdout: "GNU bash 3.2\n", stderr: "" })
        : err(`unexpected command: ${executable} ${args.join(" ")}`),
    ),
  findBrew: () => Promise.resolve(ok("/opt/homebrew/bin/brew")),
  brewPrefix: () => Promise.resolve(ok("/opt/homebrew/opt/mci")),
  ping: () => Promise.resolve(ok(snapshot())),
  paths: () =>
    ok({
      directory: "/service",
      socket: "/service/daemon.sock",
      registry: "/service/registry.json",
      snapshot: "/service/snapshot.json",
      journal: "/service/requests.json",
    }),
  regularFile: (path) =>
    Promise.resolve(ok(path.endsWith("/registry.json") ? "file" : "absent")),
  recoveryEntries: () => Promise.resolve(ok([])),
  realPath: (path) => Promise.resolve(ok(path)),
  git: () => Promise.resolve(ok("/opt/homebrew/opt/mci/libexec/hooks")),
  ...overrides,
});

const failedChecks = (checks: readonly DoctorCheck[]) =>
  checks.filter((check) => !check.passed).map(({ name, detail }) => ({ name, detail }));

Deno.test("doctor returns every healthy check in diagnostic order", async () => {
  const report = unwrap(await doctorWith(repository.id, capabilities()));

  equal(report, {
    checks: [
      { name: "platform", passed: true, detail: "darwin" },
      { name: "Deno", passed: true, detail: "deno 2.9.7" },
      { name: "Bash", passed: true, detail: "GNU bash 3.2" },
      { name: "Homebrew", passed: true, detail: "/opt/homebrew/bin/brew" },
      { name: "formula", passed: true, detail: "/opt/homebrew/opt/mci" },
      { name: "daemon", passed: true, detail: "pid 1234" },
      { name: "daemon registry", passed: true, detail: "file" },
      { name: "recovery", passed: true, detail: "no staging or backup apps" },
      { name: "repository registration", passed: true, detail: repository.id },
      { name: "repository recovery", passed: true, detail: "ready" },
      {
        name: "repository hook",
        passed: true,
        detail: "/opt/homebrew/opt/mci/libexec/hooks",
      },
    ],
    healthy: true,
  });
});

Deno.test("doctor aggregates unavailable tools and services", async () => {
  const report = unwrap(
    await doctorWith(
      undefined,
      capabilities({
        command: (executable) =>
          Promise.resolve(
            executable === "/usr/bin/env"
              ? err("Deno is unavailable")
              : ok({ code: 127, stdout: "", stderr: "Bash is unavailable" }),
          ),
        findBrew: () => Promise.resolve(err("Homebrew is unavailable")),
        brewPrefix: () => Promise.resolve(err("formula is unavailable")),
        ping: () => Promise.resolve(err("daemon is unavailable")),
        regularFile: () => Promise.resolve(ok("absent")),
      }),
    ),
  );

  equal(report.healthy, false);
  equal(failedChecks(report.checks), [
    { name: "Deno", detail: "Deno is unavailable" },
    { name: "Bash", detail: "Bash is unavailable" },
    { name: "Homebrew", detail: "Homebrew is unavailable" },
    { name: "formula", detail: "formula is unavailable" },
    { name: "daemon", detail: "daemon is unavailable" },
    { name: "daemon registry", detail: "absent" },
  ]);
});

Deno.test("doctor reports a blocked repository as unhealthy", async () => {
  const report = unwrap(
    await doctorWith(
      repository.path,
      capabilities({
        ping: () => Promise.resolve(ok(snapshot("manual recovery required"))),
      }),
    ),
  );

  equal(report.healthy, false);
  equal(failedChecks(report.checks), [{
    name: "repository recovery",
    detail: "manual recovery required",
  }]);
});

Deno.test("doctor reports an invalid repository without a hook lookup", async () => {
  let gitCalled = false;
  const report = unwrap(
    await doctorWith(
      "/missing/repository",
      capabilities({
        ping: () => Promise.resolve(ok({ ...snapshot(), repositories: [] })),
        realPath: () => Promise.resolve(err("repository path does not exist")),
        git: () => {
          gitCalled = true;
          return Promise.resolve(err("git must not run"));
        },
      }),
    ),
  );

  equal(report.healthy, false);
  equal(failedChecks(report.checks), [
    { name: "repository registration", detail: "not registered" },
    { name: "repository path", detail: "repository path does not exist" },
  ]);
  equal(gitCalled, false);
});
