# Verification

Initial package verified on Linux x86_64 with Deno 2.9.7, V8 15.0.245.2-rusty and
TypeScript 6.0.3. This is source-level and portable-runtime evidence, not macOS release
certification.

Final result: **18 passed, 0 failed, 1 macOS-only test ignored**. Formatting, linting and
type checking all passed. The valid example passed CLI preflight; the unsupported example
returned exit 2 before executing any step.

## Checks performed

- `deno fmt --check`
- `deno lint`
- `deno task check`
- `deno task test`
- CLI `check` against the supplied valid and intentionally unsupported workflows
- CLI refusal to execute jobs on Linux

Real subprocess tests cover environment precedence, independent shells, shared files,
directories created by earlier steps, paths with spaces, closed stdin, pipeline failure,
missing commands, symlink escapes, group cleanup after success, timeout and cancellation,
forced termination after ignored TERM, and zero effects when a later step has unsupported
syntax. No process API is mocked.

## macOS checks still required

Run `deno task verify` on a Mac. It includes a platform-specific CLI success and actual
SIGINT test which is intentionally skipped on Linux. Repeat on Apple Silicon and Intel
before advertising support for both. The same portable process tests run on macOS,
providing evidence for detached process groups on that OS.

Then run `deno task demo`, followed by `deno task compile` and the compiled CLI against
`examples/basic.yml`. Compilation, binary distribution and minimum macOS version
compatibility have not been tested here. No hosted GitHub Actions run or Docker behavior
is claimed.
