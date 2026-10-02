# Verification

The architecture hardening and CI monitor checks passed on Apple Silicon macOS on
2026-10-02. The host uses macOS 26.6.2, build 25G83, and Darwin kernel 25.6.0. Deno
reports `aarch64-apple-darwin`, version 2.9.7, V8 15.0.245.2-rusty, and TypeScript 6.0.3.

The current suite passes **80 tests**, with no failures and one Linux-only test ignored.
Formatting, linting, and type checking pass. The local workflow passes against the current
checkout.

## Commands and observed results

| Command                                           | Result                                                    |
| ------------------------------------------------- | --------------------------------------------------------- |
| `deno task verify`                                | Formatting, linting, type checking, and native tests pass |
| `deno task hooks:install`                         | The local Git configuration selects `.githooks`           |
| `git hook run pre-commit` from `src/`             | The hook runs checks from the repository root             |
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

The installed pre-commit hook passes all 80 active tests and the other verification
checks. A temporary local repository with spaces exercises the Git commit boundary. A
failed check blocks the commit without creating a revision. A passing check permits the
commit. The hook resolves the correct repository root in both cases.

## Saved CI output and SwiftBar

The pre-commit hook calls `deno task ci`. The logging adapter executes the local YAML,
which calls `deno task verify` directly. The adapter records stdout, stderr, exit status,
and failures beneath `.mci/ci/`. The saved files remain gitignored. Thirteen public tests
cover stream forwarding, exit preservation, failed sinks, launch failure, writer
exclusion, status validation, cancellation, linked log preservation, and publication
failure. The adapter lifecycle test kills a disposable task parent. It confirms workflow
cancellation, journal cleanup, cancelled status, and successful writer reuse.

Native probes killed the Deno task parent and the CI logger in separate temporary
workspaces. Both probes confirmed active workflow cancellation and removal of the
workspace journal. Logger death left running status for the monitor to identify as
interrupted.

Thirteen public monitor tests cover display states, malformed records, changed identities,
legacy records, paths with commas and shell punctuation, missing logs, executable plugin
generation, collisions, owned reinstall, and internal cache refusal. The generated plugin
executes against copied sources in a temporary repository. Each new test completed in less
than one second during the full verification run.

SwiftBar 2.1.1 is installed at `/Applications/SwiftBar.app`. The configured plugin folder
is `~/Library/Application Support/meeci/SwiftBar`. The installer generated
`mci-meeci.5s.sh` in that folder. The installed script displays PASS with an empty
environment and `PATH=/usr/bin:/bin`. The menu output includes Open log, Open repository,
and Refresh. The plugin enters the quoted repository path and grants only repository reads
and `/bin/ps` execution. The monitor provides no CI action.

macOS accepted the app as a notarized developer application. Application startup was
requested, but native inspection did not confirm completed startup or menu display. The
installed plugin and app configuration are checked. Visual menu confirmation remains
unavailable in this session.

## Evidence limits

The initial package passed 18 tests on Linux x86_64 before architecture hardening. That
result does not establish Linux evidence for the current changes. Current Linux and Intel
execution results remain unavailable. Minimum macOS compatibility and binary distribution
remain untested. Any additional compatibility checks run locally on the claimed systems.

GitHub serves only as a repository backup service. Automatic CI runs only through the
local Git pre-commit hook. The repository does not require hosted checks.

Recovery uses separate process inspection and signal operations. The native recovery test
establishes the tested scenario only. It does not establish recovery for changed
identities, detached descendants, or a crash before process registration. Local commands
retain host authority and inherited tool variability.

The repository maintainer owns any additional local compatibility checks and release
acceptance.
