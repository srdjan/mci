# Verification

The architecture hardening checks passed on Apple Silicon macOS on 2026-10-02. The host
uses macOS 26.6.2, build 25G83, and Darwin kernel 25.6.0. Deno reports
`aarch64-apple-darwin`, version 2.9.7, V8 15.0.245.2-rusty, and TypeScript 6.0.3.

The current suite passes **54 tests**, with no failures and one Linux-only test ignored.
Formatting, linting, and type checking pass. The local workflow passes against the current
checkout.

## Commands and observed results

| Command                                           | Result                                                    |
| ------------------------------------------------- | --------------------------------------------------------- |
| `deno task verify`                                | Formatting, linting, type checking, and native tests pass |
| `deno task mci run ci/local-ci.yml --job check`   | The selected verification step passes                     |
| `deno task demo`                                  | Both example steps pass                                   |
| `deno task compile`                               | The native binary builds at `dist/mci`                    |
| `./dist/mci --version`                            | The binary reports the version from `deno.json`           |
| `./dist/mci check examples/basic.yml --job check` | The binary validates the example                          |
| `./dist/mci run examples/basic.yml --job check`   | Both example steps pass                                   |
| Compiled CLI in a separate workspace with spaces  | Validation and execution preserve the invoking directory  |

## Behavior covered

Public API tests cover validation before effects, environment precedence, fresh shells,
shared files, contained directories, paths with spaces, closed stdin, and pipeline
failure. The suite checks missing commands, global YAML errors, timeout limits, and
cancellation. CLI tests cover help, version, missing inputs, missing Bash, macOS
execution, and actual SIGINT delivery through source and task execution. Another CLI test
kills the native Deno task parent with SIGKILL. The CLI cancels its active job, clears the
journal, and permits the next run.

Native process tests cover background group cleanup, timeout, cancellation, and escalation
when a shell ignores TERM. Small capability records exercise rejected signals, rejected
status, bounded reaping, and compound diagnostics. Tests retain primary execution errors
when cleanup also fails. Command tests cover output capture, launch failure, and forced
termination after the capture deadline. Process tests cover completed children without
identities, failed registration cleanup, rejected finish registration, and command
identity refusal without signals.

Workspace tests cover competing runs, lock release, private scripts, abandoned
directories, invalid journals, and symlink rejection. A native macOS test kills the owning
runner with SIGKILL. The next run recovers its recorded process before executing the next
job. Another native test confirms that an uncertain identity preserves the journal and
leaves the unrelated process alive.

Two runner regressions failed before the corresponding changes. A competing run modified
the same workspace. A directory cleanup failure hid the original exit code 23. Both
regressions pass after workspace integration.

## Evidence limits

The initial package passed 18 tests on Linux x86_64 before architecture hardening. That
result does not establish Linux evidence for the current changes. The hosted workflow now
configures Linux, Apple Silicon macOS, and Intel macOS checks. No hosted run or Intel
execution result is available for this change. Minimum macOS compatibility and binary
distribution remain untested.

Recovery uses separate process inspection and signal operations. The native recovery test
establishes the tested scenario only. It does not establish recovery for changed
identities, detached descendants, or a crash before process registration. Local commands
retain host authority and inherited tool variability.

The repository maintainer owns the next compatibility checks and release acceptance.
