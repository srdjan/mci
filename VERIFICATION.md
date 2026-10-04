# Verification

## Submission cancellation

On 2026-10-03, `deno task verify` passed on Apple Silicon macOS. The Deno suite passed 187
tests with one opposite-platform test ignored. The native monitor passed 309 checks.
Formatting, linting, and type checking passed.

Six public client tests use temporary Unix sockets. The tests cover silent acceptance,
cancellation before and after acceptance, a blocked request write, complete frame order,
and success after cancellation. All six tests passed after the final code cleanup. The
blocked-write test reads an incomplete frame after the deadline closes the client socket.

Code review completed with no remaining findings. The review confirmed all twelve
requirements in the submission plan. The review identified the need to observe an
incomplete frame in the blocked-write test. That correction passed the six client tests.

The initial regression failed before the source change. The server received submission and
cancellation, but the client did not stop waiting within the test observation period.

These checks cover source execution on this host. The installed package retains its
earlier binary. Blocked terminal output remains outside the socket deadlines.

## Earlier packaged baseline

On 2026-10-03, final `deno task verify` passed on Apple Silicon macOS. Formatting,
linting, type checking, and architecture checks passed.

The Deno suite passed 155 tests with one opposite-platform test ignored. The native
monitor suite passed 309 checks.

The final archive built successfully and installed through the local Homebrew tap.
`brew test local/meeci/mci` passed. The Homebrew daemon restarted successfully. Setup also
started a stopped service after reading Homebrew state.

Two temporary repositories ran Deno tasks concurrently through the installed daemon. The
native socket client read both repositories.

The installed Git hook blocked a failed check and permitted a passing check. The hook used
the packaged absolute path.

Two `mci setup` runs replaced and opened the packaged monitor. The installed app passed
`codesign --verify --deep --strict`.

The native socket client also read this registered checkout through the installed service.
`deno task ci` passed through that service. The final archive checksum is
`f0c22161265891f9bc5dcb33f712819e0f446d2d433e5f810cad66b5224bd1c0`.

## Earlier hardening baseline

Architecture hardening and earlier monitor checks passed on Apple Silicon macOS on
2026-10-02. The host used macOS 26.6.2, build 25G83, and Darwin kernel 25.6.0.

Deno reported `aarch64-apple-darwin`, version 2.9.7, V8 15.0.245.2-rusty, and TypeScript
6.0.3. The earlier suite passed 96 tests, with one Linux-only test ignored.

## Earlier commands and observed results

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

## Shared-daemon behavior covered

Focused tests cover FIFO execution within each repository and concurrent execution across
repositories. They cover isolated cancellation after a client cancel or disconnect.

Restart tests confirm that accepted unfinished requests become INTERRUPTED. The daemon
does not retry those requests.

Snapshot tests keep the latest completed result visible during active and queued work.
Retention tests keep the latest spool and spools used by connected clients.

Shutdown tests close idle clients and mark unfinished requests as interrupted. IPC tests
enforce strict UTF-8, complete frames, and the four MiB frame limit.

Terminal-copy tests cover serialized result projection for each repository. Protocol tests
reject unknown fields and invalid response shapes.

## Earlier runner behavior covered

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

On 2026-10-03, a probe confirmed that macOS returns EPERM for `killpg` on a group whose
only member is an unreaped zombie, and ESRCH after reaping. A native probe cancelled a
step with a background child. With the old cleanup code, it failed in 4 of 180 rounds with
a group EPERM. An intermediate version that waited only for the direct child failed in 12
of 60 rounds, because launchd reaps the orphan later. With the final change, the probe
passed 240 of 240 rounds, and a faster-policy probe passed 200 of 200. Three capability
tests cover a vanished group after an EPERM, an EPERM during the grace poll, and an EPERM
that remains while the group exists. Recovery used to send its group signals without that
poll. Four recovery capability tests failed before the change and pass after it. The tests
cover an EPERM probe for a missing leader, an EPERM on SIGTERM, and an EPERM probe during
the grace wait. The fourth test keeps the error while EPERM continues, and it sends only
signal 0.

On 2026-10-03, a native probe measured whether recovery meets a zombie leader. `ps` shows
a zombie as `<defunct>` with an unchanged PID, group, and start time. Recovery would then
report a command mismatch and keep the journal. In each round, a short-lived parent
started a detached Bash group leader and exited, so launchd adopted the leader. Then
`recoverProcess` recovered the recorded identity. Recovery succeeded in 1,800 of 1,800
rounds and never inspected a `<defunct>` leader. The rounds were 500 with one sleep, 500
with an added background sleep, 500 with native capabilities, and 300 with 14 busy CPU
cores. The probe does not cover other hosts or heavier load.

On 2026-10-03, eight hardening fixes added 11 tests. Each test failed before its fix,
except the D1 test for a pending retry timer at shutdown. That test guards new code and
had no earlier failure. `deno task test` passed 170 tests with 1 ignored. After the fixes,
the audit probes showed the corrected behavior. Under `ulimit -n 48`, the daemon received
80 idle connections. It logged EMFILE, kept its socket, and continued to run. Restart
recovery without a spool log left the repository unblocked twice. A queued request behind
a retention block received a failure result. A cancelled queued request left the PASS
result and a 41-byte `latest.log`. Registration during a held lock left the repository
unblocked, and the next job succeeded. Recovery killed a TERM-ignoring child and returned
success. Four stray `run-*` entries no longer blocked a run.

Workspace tests cover competing runs, lock release, private scripts, abandoned
directories, invalid journals, and symlink rejection. A native macOS test kills the owning
runner with SIGKILL. The next run recovers its recorded process before executing the next
job. Another native test confirms that an uncertain identity preserves the journal and
leaves the unrelated process alive.

Two runner regressions failed before the corresponding changes. A competing run modified
the same workspace. A directory cleanup failure hid the original exit code 23. Both
regressions pass after workspace integration.

The earlier installed pre-commit hook passed all 96 tests and the other verification
checks. A temporary local repository with spaces exercised the Git commit boundary. A
failed check blocks the commit without creating a revision. A passing check permits the
commit. The hook resolves the correct repository root in both cases.

## Earlier saved CI output

The pre-commit hook calls `deno task ci`. The logging adapter executes the local YAML,
which calls `deno task verify` directly. The adapter records stdout, stderr, exit status,
and failures beneath `.mci/ci/`. The saved files remain gitignored. Fifteen public tests
cover stream forwarding, exit preservation, failed sinks, launch failure, writer
exclusion, status validation, cancellation, linked log preservation, and publication
failure. Two tests start a detached background process that holds the output pipes after
the command exits. One test confirms that the adapter cuts the held streams after the
output grace period and reports failure. The other test cancels after the command exits
and confirms that the adapter returns at once with cancelled status. Both tests confirm
that the lock is released. The adapter lifecycle test runs `mci ci` without the task
marker and kills its disposable parent. It confirms workflow cancellation, journal
cleanup, cancelled status, and successful writer reuse.

CLI tests run `mci ci` from source. A passing job saves pass status and its output. A
failing step returns the same code as `mci run`. A validation error saves fail status with
code 2. A missing `--job` returns 2 and saves nothing.

On 2026-10-03, `deno task compile` built `dist/mci`. A temporary Git repository with
spaces and a comma in its path used the documented hook. A passing workflow created the
commit and saved pass status. A failing step blocked the commit and saved fail status with
code 1, the same code as `dist/mci run`. SIGINT during `dist/mci ci` returned 130 within
0.08 s and saved cancelled status. No step process remained.

Native probes killed the Deno task parent and the CI logger in separate temporary
workspaces. Both probes confirmed active workflow cancellation and removal of the
workspace journal. Logger death left running status for the monitor to identify as
interrupted.

On 2026-10-03, SwiftBar was uninstalled with `brew uninstall --zap --cask swiftbar`. Its
plugin, its support folder, and the SwiftBar plugin code and tests were removed. A native
menu bar app replaces them; see `docs/monitor-app-plan.md`.

## Earlier menu bar app evidence

On 2026-10-03 with the Command Line Tools only (Swift 6.4), `deno task verify` ran the
Deno suite and `app:check` in 11 s wall time with a warm Swift build. `MonitorChecks`
passed 342 checks in 10 of 10 runs. A cold release build of the package took 22-44 s.
Swift Testing `@Test` macros failed in 10 of 22 runs, and SwiftUI `@State` does not build
because the Command Line Tools ship no SwiftUIMacros plugin.

A changed fixture expectation made both `MonitorChecks` and the Deno fixture test fail,
and both passed after the restore. Nineteen installer tests use fake capabilities and
temporary folders. They cover a fresh install, an owned reinstall, foreign and symlinked
destinations, signing and verification failures, rollback, a missing `swift`, an app that
does not start, and the registry rules. An installation into temporary folders with the
real `swift`, `codesign`, and `plutil` produced a bundle that passed
`codesign --verify --strict`, and a second run replaced it.

On 2026-10-03, `deno task monitor:install` installed `~/Applications/mci Monitor.app` for
this repository. The bundle passed `codesign --verify --strict`, and the registry held the
repository path. A screenshot showed the PASS icon in the menu bar. The first icon was a
plain green disc, because a one-color symbol palette filled the checkmark; a tinted
monochrome symbol fixed it. During a pre-commit run, the icon showed the RUNNING arrows,
and the icon returned to PASS. A second `deno task monitor:install` run quit the running
app, replaced the bundle, and started the app again.

The user checked the panel, the log window with colors, Reload, Show in Finder, copy,
window reuse, Add repository, and Remove. All worked. This record does not cover these
checks from `docs/monitor-app-plan.md`: the RUNNING update within 1 s, INTERRUPTED within
5 s, watch recovery, and a picker cancel.

The "Launch at login" checkbox first appeared disabled. `SMAppService.mainApp` reports
`notFound` for an app that was never registered. A probe showed that `register()` works
for an ad-hoc signed bundle: the status changed from `notFound` to `enabled`, and
`unregister()` changed it to `notRegistered`. After commit `c78b2a5` kept the checkbox
enabled for `notFound`, the user turned on "Launch at login", and the checkbox stayed
checked. For plan step 5, the installer then rebuilt and reinstalled the app with commit
`469ee32`, which gave the bundle a new ad-hoc signature. The user read the panel again,
and "Launch at login" was still checked. A start at the next login is not yet confirmed.

## Evidence limits

The final host checks establish package installation, daemon startup, concurrent
execution, socket decoding, signature validity, and hook behavior.

A native probe used an accepted socket that sent no response. The native client reported
its deadline after 1002.8 ms.

The current app still needs a visual and VoiceOver check. A start at the next login
remains unconfirmed.

The initial package passed 18 tests on Linux x86_64 before architecture hardening. That
result does not establish Linux evidence for the current changes. Current Linux and Intel
execution results remain unavailable. Minimum macOS compatibility and public binary
distribution remain untested. Any additional compatibility checks run locally on the
claimed systems.

GitHub serves only as a repository backup service. Automatic CI runs only through the
local Git pre-commit hook. The repository does not require hosted checks.

Recovery uses separate process inspection and signal operations. The native recovery test
establishes the tested scenario only. It does not establish recovery for changed
identities, detached descendants, or a crash before process registration. Local commands
retain host authority and inherited tool variability.

The repository maintainer owns any additional local compatibility checks and release
acceptance.
