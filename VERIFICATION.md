# Verification

## Legacy import while the legacy adapter runs

On 2026-10-04, the legacy `status.json` import gained a check for a running legacy
adapter. The adapter held an exclusive lock on `.mci/ci/lock` for its whole run. Before
the import, the daemon tries that lock without waiting and without creating the file.
While another process holds the lock, the daemon skips the import and keeps `status.json`.

A new test holds the lock and registers a repository with a running legacy record. It
requires no latest result, no block, no `latest.json`, and an unchanged `status.json`. It
failed before the change because the daemon imported the record as interrupted. After the
test releases the lock, a new daemon imports the record. The 55 tests in
`tests/daemon_test.ts` and `tests/daemon_race_test.ts` passed after the change.

The test holds the lock in the test process. The daemon uses a separate file handle in the
same process, and the lock conflict held on macOS. No earlier binary ran in this check.

## Run removal without a request directory

On 2026-10-04, a review found that `removeRun` in `src/daemon-store.ts` matched the text
"NotFound" in the error message. The message holds only the operating system text, so a
missing `.mci/ci/requests` directory became a retention failure. That failure blocks the
repository.

A new store test calls `removeRun` for a workspace without a request directory. It failed
before the change with "No such file or directory (os error 2)". `removeRun` now checks
the directory first. It treats a missing directory as removed and rejects a symbolic link.
The 54 tests in `tests/daemon_test.ts` and `tests/daemon_race_test.ts` passed after the
change.

## Legacy import without a log

On 2026-10-04, the daemon changed its import of a version 1 `status.json` without
`latest.log`. Before the change, the missing log blocked the repository at every start.
The daemon now imports the record with an empty request log. Terminal recovery already
treats a missing spool log the same way. A legacy log that is not a regular file still
blocks the repository.

A new test imports a record without a log and requires an empty copied log and a written
`latest.json`. It failed before the change and passed after it. A second new test makes
`latest.log` a directory and requires the block. The ten tests in `tests/daemon_test.ts`
that match `--filter registration` passed after the change.

A review then found that this import left `.mci/ci/latest.log` missing. The daemon now
creates the empty legacy log with an exclusive create and copies it as before. The import
test now also covers a running record and requires an empty `latest.log`. At the earlier
commit, this test failed because `latest.log` did not exist. The block test now also
covers a symbolic link and requires an unchanged `status.json`. After the fix, the
complete Deno suite passed 248 tests, with 1 test ignored.

A second review found that the import created the empty log before it checked the `.mci`
directories. If `.mci` was a symbolic link, the daemon created `latest.log` in the link
target and then blocked the repository. The daemon now checks the directories first. A new
test links `.mci` to another directory and requires no `latest.log` there. This test
failed before the fix and passed after it. The block test now requires the log path in the
message. After the fix, the complete Deno suite passed 249 tests, with 1 test ignored.

## CI failure communication in Codex

On 2026-10-04, the complete local CI gate passed 242 Deno tests and 242 native monitor
checks. One opposite-platform test was ignored. Formatting, linting, and type checking
passed. The workflow completed in 29.32 seconds. This gate preceded the final
session-override regression.

The initial focused receipt, CLI, and adapter checks passed 29 tests in three seconds.
After the missing-path correction, 15 receipt and adapter tests passed in 962
milliseconds. Further CLI and adapter coverage passed 26 tests in three seconds. The
checks assert final direct-run receipts and concurrent warning deduplication.

The final focused receipt, CLI, and adapter checks passed 35 tests in three seconds. One
opposite-platform test was ignored. Receipt storage tests confirm refusal before
execution, failure after successful execution, and preservation of a nonzero cancellation
code.

A disposable Codex session received stale parent identifiers. Tool commands received the
current session identifiers, but hook processes retained the parent identifiers. The
failure receipt matched the event's session identifier. This probe completed in 50.58
seconds. An override regression failed before the adapter honored `MCI_SESSION_ID`. After
the fix, the adapter reported the failure and requested repair. It still ignored inherited
Codex identifiers.

A disposable Codex 0.160.0 session ran a deliberately failing job. The captured
`PostToolUse` response contained a user warning and detailed repair context. The agent
reported the failure, repaired the fixture, and passed the matching rerun. The final
`Stop` response was empty. This probe completed in 19.45 seconds.

A second disposable session tested `Stop` without `PostToolUse`. The agent first reported
failure without repair. The hook requested continuation. The agent then repaired the
fixture and passed the matching rerun. This probe completed in 23.03 seconds.

A third session retained failure after the authorized repair could not fix the job. The
first `Stop` requested continuation. The second `Stop` returned `continue: false`. The
agent reported the repair blocker. This probe completed in 35.36 seconds.

All three sessions used gpt-5.6-sol with high effort. The probes bypassed hook trust only
for the disposable sessions. Normal installation retains Codex's trust requirement.

The native CLI compiled successfully. A temporary workspace tested its failure warning,
matching-pass clearance, and installer. The installer selected the stable Homebrew path.
These checks did not update the installed package.

Nine independent Sol review passes and separate finding validation completed. Corrections
resolved all actionable findings. Review retained one advisory about duplicated validation
of terminal kinds. No independent review used another model family.

Review found that a missing workflow under a symlink changed identity after file creation.
A public receipt test reproduced the mismatch before the fix. The CLI now resolves the
deepest existing parent before it appends missing path parts.

A future-start receipt test reproduced an invalid final time before the clock fix. The CLI
now clamps the final time to the recorded start. The stored result remains decodable. This
test uses a controlled receipt timestamp; it does not change the host clock.

The runner recovery test initially inherited the coding session and left pending test
receipts. A regression assertion failed before the test cleared session identifiers. After
isolation, the recovery test passed in 165 milliseconds and left no receipt storage. The
two known test receipts were removed from the active session.

The source adapter installed successfully in this checkout. A second install produced the
same configuration. The installer removed the exact legacy handler and retained hook trust
settings. The user must review the new definitions before normal hook execution.

The JSON transport proves hook output and agent communication. It does not prove the
warning's visual presentation in the Codex desktop app. The session hooks request repair
and continuation. They do not enforce a universal lock on tool calls.

## Legacy status import coverage

On 2026-10-04, the legacy import tests in `tests/daemon_test.ts` gained coverage for the
real record shape and for daemon startup. The nine legacy tests passed.

The removed direct CI logger always wrote a `logger` key, as an identity object or null.
The earlier import tests used only records without that key. The import test now covers an
identity object, a null logger, and no logger key. The invalid-record test now also covers
an invalid logger and an unfinished record with an exit code.

The entry "Legacy status import tests" below says that the daemon runs this import when a
repository registers. That statement is incomplete. The daemon also runs the import at
startup for each registered repository without `latest.json`. A new test starts the daemon
with a legacy `monitor.json` and a legacy `status.json`. It checks the imported result and
its copied log after the startup retention sweep.

Four temporary mutations confirmed that the tests detect defects. Each mutation was
reverted with `git checkout`:

1. A key count that ignored the `logger` key failed three tests. The tests from commit
   `a369133` passed 8 of 8 with this mutation.
2. A logger check that accepted any value failed the invalid-record test.
3. An unfinished-record check that accepted an exit code failed the invalid-record test.
4. A startup sweep that did not keep the latest result failed the startup test.

## Legacy unfinished run finish time

On 2026-10-04, a new test showed a defect in the import of an unfinished legacy run. The
import set the finish time to the current clock. When the legacy start time was later than
the clock, the finish time came before the start time. `decodeTerminal` rejects that
record, so the client rejected every snapshot that contained it.

Before the fix, the test "registration ends a future unfinished legacy run at its start
time" failed. The register call returned "Invalid terminal record fields". The fix in
`src/daemon-store.ts` uses the start time as the finish time when the clock is earlier.
After the fix, the eight legacy tests in `tests/daemon_test.ts` passed.

The same unclamped finish time remains in `workerTerminal`, `failedTerminal`, and the
startup interrupted record in `src/daemon.ts`. Those records fail only when the clock
moves back during a run. This change does not alter them.

## Legacy status import tests

On 2026-10-04, four new tests in `tests/daemon_test.ts` cover the daemon import of a
version 1 `status.json`. The daemon runs this import when a repository registers without
`latest.json`. Before this change, no test covered it.

The tests check pass, fail, and cancelled records, and an unfinished record. Each check
confirms the imported kind, code, detail, and copied log. Further checks cover an invalid
record, an invalid exit code, and a missing log, which block the repository. A status file
of another version is not imported.

Three temporary mutations of `src/daemon-store.ts` confirmed that the tests detect
defects. A decoder that accepted no version 1 record failed three tests. A cancelled
record mapped to failure failed the import test. A missing check on the log file failed
the invalid-record test. Each mutation was reverted with `git checkout`.

The six registration tests in `tests/daemon_test.ts` passed in about 1 s. These checks use
temporary workspaces and an in-process daemon. They do not import status files from an
installed earlier version.

## Monitor status decoder removal

On 2026-10-04, `deno task verify` passed on Apple Silicon macOS. The Deno suite passed 215
tests with one opposite-platform test ignored. The native monitor passed 242 checks.
Formatting, linting, and type checking passed.

The monitor app reads daemon snapshots, and no app code called the old status decoder. The
change removes `CiStatus`, `CiState`, `LoggerIdentity`, `decodeStatus`, `statusPath`, and
`readCiStatus` from `monitor/Sources/MonitorCore/CiStatus.swift`. It removes `StatusError`
in `monitor/Sources/MonitorCore/MonitorError.swift`. It deletes both files. It also
deletes `monitor/Sources/MonitorChecks/DecodeChecks.swift`, `src/ci.ts`,
`tests/ci_test.ts`, `tests/monitor_fixtures_test.ts`, and the 59 files in
`tests/fixtures/monitor/`. The daemon store and `tests/fixtures/daemon/` did not change.

The native checks fell from 309 to 242. The 67 removed checks are 60 decode fixture checks
and 7 status file checks. The Deno suite fell from 217 to 215 passed tests. The two
removed tests are "CI status reader distinguishes missing and invalid records" and
"monitor decode fixtures match readCiStatus".

`parseTimestamp` and its two private helpers moved to
`monitor/Sources/MonitorCore/Timestamp.swift`. The function bodies and doc comments are
unchanged. The calendar checks moved to
`monitor/Sources/MonitorChecks/TimestampChecks.swift`. The timestamp checks stay at 18: 6
valid and 12 invalid texts. `DaemonProtocol.swift`, `DisplayState.swift`, and
`SnapshotChecks.swift` still call `parseTimestamp`.

The import graph check ran this command:

`grep -rn "CiStatus\|StatusError\|decodeStatus\|readCiStatus\|statusPath\|ci\.ts\|fixtures/monitor\|checkDecodeFixtures\|checkStatusFiles" src scripts tests monitor --exclude-dir=.build`

The command printed no lines.

This verification has limits. The grep checks names, not dynamic imports. The lower check
counts remove coverage of the old status contract only. The legacy `status.json` import in
`src/daemon-store.ts` has no direct test before or after this change. The deleted fixtures
tested `src/ci.ts`, not that import.

## Direct CI logger removal

On 2026-10-04, `deno task verify` passed on Apple Silicon macOS. The Deno suite passed 217
tests with one opposite-platform test ignored. The native monitor passed 309 checks.
Formatting, linting, and type checking passed.

The change removes `runLoggedCi` and its private helpers from `src/ci.ts`. The file shrank
from 499 lines to 115 lines. The CLI submits CI to the daemon, and no source file called
`runLoggedCi`. The module keeps `readCiStatus` and its decoders, because the monitor
fixture test and one status reader test still use them. The daemon store did not change.

`tests/ci_test.ts` held 15 tests. Thirteen tests covered only the removed logger, and the
change deletes them. One test, "CI status reader distinguishes missing and invalid
records", stays in place. The Deno suite fell from 230 to 217 passed tests, which matches
the 13 deleted tests.

The test "daemon CI cancels its workflow when the disposable parent dies" moved to
`tests/cli_test.ts`. Its name now starts with "macOS", as in the other darwin-only CLI
tests. The final assertion changed. It called the removed logger to prove that the
workspace was free. It now submits a second daemon job and requires the terminal kind
"success" and the file `reused` in the workspace. The moved test passed in 494 ms.

A mutation check changed the second job to `run: exit 3`. The moved test failed with
`expected "success", received "failure"`. The change was reverted, and the test passed
again.

The import graph check ran this command:

`grep -rn "ci.ts\|readCiStatus\|runLoggedCi" src scripts tests monitor --exclude-dir=.build`

The command printed 18 lines. In `src` and `tests`, 7 lines matched: the `readCiStatus`
definition in `src/ci.ts`, 3 lines in `tests/monitor_fixtures_test.ts`, and 3 lines in
`tests/ci_test.ts`. These lines are the two retained users of `readCiStatus`. No
`runLoggedCi` name and no `scripts` file matched. In `monitor`, 11 Swift lines matched: 7
calls in `DecodeChecks.swift`, and 4 definitions or comments in `CiStatus.swift` and
`MonitorError.swift`. These Swift lines belong to the status decoder that pruning item P2
removes.

This verification has limits. The grep checks names, not dynamic imports. The reuse
assertion proves that a second job runs after a cancelled job. It does not measure the
time to release the workspace. No change in elapsed test time is claimed.

## Daemon readiness in restart tests

On 2026-10-04, one full `deno task verify` run failed "daemon restart marks an accepted
request interrupted without retry". The client reported "Connection refused (os error
61)". The two restart tests spawn a daemon process and waited only until its socket file
existed.

A Python probe bound a Unix socket and connected before `listen()`. The socket file
existed, and the connection failed with errno 61. After `listen()`, the connection
succeeded. A connection between the two calls therefore produces the reported error. This
is the probable cause. Twenty-five runs of both restart tests under load on all 14 cores
did not reproduce the failure.

Both tests now wait until the daemon answers a ping. Five runs of the four restart tests
passed afterward. Production clients already poll with a ping or report an unavailable
daemon. The daemon itself is unchanged.

## Source monitor installer rollback

On 2026-10-04, `deno task verify` passed on Apple Silicon macOS. The Deno suite passed 230
tests with one opposite-platform test ignored. The native monitor passed 309 checks.
Formatting, linting, and type checking passed.

One earlier full run failed "daemon restart marks an accepted request interrupted without
retry" with a refused daemon connection. Ten isolated runs and three runs of
`tests/daemon_test.ts` passed. This change does not touch the daemon. The section "Daemon
readiness in restart tests" records the probable cause and the test change.

Eight new public tests call `installMonitor` with fake capabilities in temporary
directories. All eight failed before the source change. Four tests received the unchanged
primary error with no restoration text. Three tests found no retained backup folder,
because the old installer deleted it after the swap. One test found no backup while the
startup check ran.

The fixed installer keeps the old bundle until the new app runs. After a registration,
open, or startup failure on a reinstall, it quits the new app and removes it. It then
renames the backup to the destination and opens the restored app. Checks cover each of
these failures, and the exact startup failure text. Further checks cover a failed restore,
a failed reopen, a failed quit, and a failed removal. Each failed rollback names the
retained backup, and the backup keeps its old content. A fresh install keeps today's
behavior.

After the change, the 24 tests in `tests/install_monitor_test.ts` passed in 163 ms. The
slowest test took 48 ms, because it waits for the 40 ms startup limit.

These checks use fake capabilities only. They do not run the native quit, open, or
reinstall steps. The native quit confirms process absence only at that moment. A first
launch slower than the 5000 ms default now causes a rollback, instead of leaving the new
app installed. The installed app is unchanged.

## Matching package artifacts

On 2026-10-04, `deno task verify` passed on Apple Silicon macOS. The Deno suite passed 222
tests with one opposite-platform test ignored. The native monitor passed 309 checks.
Formatting, linting, type checking, layer checking, and suppression checking passed.

Fourteen new public tests call `publishPackageWith` in temporary directories. Checks cover
checksum failure, partial formula preparation, archive publication failure, and formula
switch failure. Failure fixtures start with a matching earlier archive and formula.
Success checks parse the formula URL and hash the referenced file.

Further checks cover duplicate content, conflicting files, directories, and symlinks.
Checks also cover source symlinks, literal characters in file URLs, concurrent formula
switches, and private cleanup failures. Earlier published archives remain available.

The first regression failed before the publication change in 19 ms. The old publisher
changed archive bytes before formula preparation failed. A second regression failed in 20
ms after review found cleanup after the formula switch. The corrected publisher cleans the
private source before that switch. No fallible operation follows a successful switch.

The main agent ran all 16 package tests after the correction. Those tests passed in 47 ms.
The slowest test took 9 ms on that run. An independent review found no remaining defect
after the cleanup correction.

A native tar failure probe changed a stable archive and left its earlier formula
unchanged. The same failure against a private candidate preserved the earlier matching
pair. A native publication check used valid compressed tar archives in a temporary
directory. The formula checksum matched the published archive. Duplicate publication
preserved the archive inode. A later publication retained the earlier archive and created
a distinct matching archive.

These checks cover publication and source execution. They do not rebuild or reinstall the
full package. The installed binary and monitor remain unchanged. Power-loss durability and
external archive modification remain outside the checked contract. Failed switches can
leave complete unreferenced archives; the repository maintainer owns archive removal.

## Command capture byte limits

On 2026-10-04, `deno task verify` passed on Apple Silicon macOS. The Deno suite passed 208
tests with one opposite-platform test ignored. The native monitor passed 309 checks.
Formatting, linting, type checking, layer checking, and suppression checking passed.

Eleven new public command tests cover independent stdout and stderr limits. Checks also
cover exact budgets, multibyte output, zero budgets, and invalid budgets before launch.
The overflow regression failed before the source change in 17 ms. The old module accepted
five stdout bytes under a four-byte budget.

The main agent ran all 15 command tests after the changes. Those tests passed in 101 ms.
The slowest test took 29 ms on that run. The cleanup tests confirm direct child reaping
and pipe closure after the direct child exits. The descendant fixture waits for its known
direct parent to disappear before producing excess output.

The main agent reran a generated-output probe with exact byte budgets. It captured 1,024,
1,048,576, and 16,777,216 bytes on each stream without truncation. Those runs took 12.33,
8.17, and 58 ms respectively. A closure probe passed 30 captures, then 1,500 captures
after only the repetition count changed. The larger run took 3,811.32 ms.

An independent review found no supported defect in retained byte limits, overflow races,
or cleanup. The final lock-state check selects reader cancellation while a pipe remains
locked. The module uses stream cancellation after the reader releases its lock.

Ordinary helpers allow 1 MiB per stream. The source monitor build allows 16 MiB per
stream. These values are policy budgets, not measured maxima.

On 2026-10-04, caller measurements produced these raw byte counts on this host:

| Command category                      | Exit status | Stdout bytes | Stderr bytes |
| ------------------------------------- | ----------: | -----------: | -----------: |
| Current parent identity from `ps`     |           0 |          183 |            0 |
| Present Git configuration             |           0 |      6 or 10 |            0 |
| Absent Git configuration              |           1 |            0 |            0 |
| Git worktree root                     |           0 |           26 |            0 |
| Git active hooks path                 |           0 |           36 |            0 |
| Homebrew prefix                       |           0 |           22 |            0 |
| Homebrew service JSON                 |           0 |          582 |            0 |
| Swift version                         |           0 |           96 |           30 |
| Managed bundle owner                  |           0 |            6 |            0 |
| Managed bundle signature verification |           0 |            0 |            0 |
| Monitor process lookup                |           0 |            6 |            0 |
| Cached Swift release build            |           0 |          279 |          832 |
| Immediate warm Swift build            |           0 |          273 |          832 |

The two build measurements took 5.1 and 4.1 seconds. The builds used the existing ignored
build directory. The measurements exclude clean builds, deliberate compiler failures, and
service changes.

The main agent checked the capture pipeline with generated bytes before changing source.
The probe first produced 1,024 bytes per stream. It then changed only the block count.
Captures returned 1,048,576 and 16,777,216 bytes per stream without truncation. Those runs
took 7.01, 7.33, and 55.26 ms respectively. This probe checks byte handling and current
runtime behavior. It does not establish a safe maximum process memory usage.

Current measurements do not establish an upper bound for future compiler diagnostics or
every repository path. The byte budgets do not bound total process memory or workflow log
growth. These checks cover source execution on this host. The installed binary remains
unchanged.

## Hook rollback diagnostics

On 2026-10-04, `deno task verify` passed on Apple Silicon macOS. The Deno suite passed 197
tests with one opposite-platform test ignored. The native monitor passed 309 checks.
Formatting, linting, type checking, and the suppression check passed.

Nine new public tests call `installHookWith` in temporary repositories. Five regression
tests failed before the source change because rollback diagnostics were absent. Two
successful rollback checks passed before that change.

The main agent ran all 23 hook tests after the changes. These checks cover file and Git
restoration failures, combined failures, and continued file restoration after Git failure.
They also cover successful restoration of absent and false extension settings. A separate
check confirms that installation preserves an extension that was already enabled.

Failure diagnostics retain the primary error and every failed restoration result. The
checks confirm target paths, recovery actions, and absence of prior configuration
contents. The repository fixtures contain spaces and an apostrophe. The recovery checks
execute Git commands through `/bin/sh` and confirm the restored setting.

An independent review found no supported defect in failure aggregation, recovery commands,
or extension preservation. The reviewer also executed both Git recovery commands in
temporary repositories and confirmed their effects.

These checks use injected Git failures and a directory that blocks file restoration. They
do not reproduce disk exhaustion or native Git failures. These checks cover source
execution; the installed binary remains unchanged.

## Shutdown during path resolution

On 2026-10-04, `deno task verify` passed on Apple Silicon macOS. The Deno suite passed 188
tests with one opposite-platform test ignored. The native monitor passed 309 checks.
Formatting, linting, type checking, and the suppression check passed.

The new public regression holds submission path resolution during shutdown. Shutdown
finishes, the client reaches EOF, and the socket disappears before the resolver returns. A
successor daemon starts in the same directory while the old resolver remains pending. This
establishes release of the service lock and socket.

After the old resolver returns, no forbidden command runs. The request journal and spool
remain unchanged. A later daemon startup retains the registered repository without a new
terminal result.

The regression failed before the source change because shutdown waited for resolution.
That failure took 583 ms. The corrected focused regression passed in 89 ms. The main agent
also ran the daemon and race suites: all 42 tests passed. An independent review found no
supported defect in the cancellation boundary or late-result handling.

The controlled resolver proves the cancellation boundary. The test does not reproduce a
stalled native filesystem. Other filesystem operations retain their existing shutdown
limits. These checks cover source execution; the installed binary remains unchanged.

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

The final archive built successfully and installed through the local Homebrew tap. The
Homebrew formula test passed. The Homebrew daemon restarted successfully. Setup also
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

Restart tests confirm that an unfinished request that began becomes INTERRUPTED. A queued
request that never began is dropped with no result. The daemon retries neither.

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

In the earlier design, the pre-commit hook called `deno task ci`. The logging adapter
executed the local YAML, which calls `deno task verify` directly. The adapter recorded
stdout, stderr, exit status, and failures beneath `.mci/ci/`. The saved files remain
gitignored. The `deno task ci` task now submits to the daemon. Fifteen public tests
covered stream forwarding, exit preservation, failed sinks, launch failure, writer
exclusion, status validation, cancellation, linked log preservation, and publication
failure. Two tests started a detached background process that held the output pipes after
the command exited. One test confirmed that the adapter cut the held streams after the
output grace period and reported failure. The other test cancelled after the command
exited and confirmed that the adapter returned at once with cancelled status. Both tests
confirmed that the lock was released. The adapter lifecycle test ran `mci ci` without the
task marker and killed its disposable parent. It confirmed workflow cancellation, journal
cleanup, cancelled status, and successful writer reuse.

A later change removed the adapter and its tests. The lifecycle test moved to
`tests/cli_test.ts` and now confirms a second daemon submission.

CLI tests run `mci ci` from source. A passing job saves pass status and its output. A
failing step returns the same code as `mci run`. A validation error returns 2 before
submission and leaves the saved status and log unchanged. A missing `--job` returns 2 and
saves nothing.

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
menu bar app replaces them.

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
checks: the RUNNING update within 1 s, INTERRUPTED within 5 s, watch recovery, and a
picker cancel.

The "Launch at login" checkbox first appeared disabled. `SMAppService.mainApp` reports
`notFound` for an app that was never registered. A probe showed that `register()` works
for an ad-hoc signed bundle: the status changed from `notFound` to `enabled`, and
`unregister()` changed it to `notRegistered`. After commit `c78b2a5` kept the checkbox
enabled for `notFound`, the user turned on "Launch at login", and the checkbox stayed
checked. For the reinstall check, the installer then rebuilt and reinstalled the app with
commit `469ee32`, which gave the bundle a new ad-hoc signature. The user read the panel
again, and "Launch at login" was still checked. A start at the next login is not yet
confirmed.

## Hardening audit fixes (2026-10-03)

Labels with D come from the daemon review. Labels with P come from the process review. T1
is a test finding. On 2026-10-03, eight confirmed findings received fixes. Each fix has a
test that failed before the change. The main session reran the audit probes after the
fixes, and each probe showed the corrected behavior.

| Label | Commit    | Result after the fix                                               |
| ----- | --------- | ------------------------------------------------------------------ |
| P3    | `a7f6af6` | `ps` reports the start time in UTC                                 |
| P2    | `d899a4b` | Stray `run-*` entries stay in place, and the run succeeds          |
| P1    | `8a3ca33` | Recovery kills a TERM-resistant child and clears the journal       |
| D4    | `efb8ed9` | A busy lock at registration leaves the repository unblocked        |
| D5    | `cc55bb0` | A cancelled queued request keeps the latest result and its log     |
| D2    | `b199005` | A queued request behind a block receives a failure result          |
| D3    | `9ed9343` | Restart recovery creates an empty log and finishes the entry       |
| D1    | `6344db5` | The daemon logs an `accept()` error, waits, and continues to serve |

Commit `73c3c3b` corrected the P1 late-exit test. Commit `1a75652` corrected two design
sentences.

A follow-up fixed the plausible findings D6 to D9, P4, and the test finding T1. It also
fixed the restart limit of the earlier D5 fix and the retry loop for a permanent
`accept()` failure. Each code fix except D6 has a test that failed before the change. No
test can simulate the power loss that D6 describes. D9 has three parts, so it has three
rows.

| Label    | Commit    | Result after the fix                                                   |
| -------- | --------- | ---------------------------------------------------------------------- |
| P4       | `7787de1` | `ps` failure with a message or an exit code other than 1 is an error   |
| D6       | `f97de84` | Atomic writes sync the file and the directory, and the spool log syncs |
| D9 files | `5826c37` | Startup removes `.write-*`, `.copy-*`, and `.latest-*` leftovers       |
| D5 limit | `163a0be` | A queued request that never began is not recorded after a crash        |
| D7       | `2edb7dc` | A signal to an exited worker is ignored, and its result survives close |
| D8       | `69a6da7` | A management response goes out after the management chain step ends    |
| D9 route | `c93c80e` | Each request path has its own routing chain                            |
| D9 busy  | `160e517` | Unregister succeeds after a finished client keeps its connection open  |
| D1 limit | `b15ade4` | The daemon stops and exits with code 1 after 60000 ms of accept errors |
| T1       | `b03729f` | The test name states that a worker with large output finishes          |

Commit `9423360` fixed a race that the new work exposed. A job result resolved before its
last snapshot write. A shutdown then returned while that write still ran, and the test
cleanup failed with "Directory not empty". The daemon now publishes the snapshot before it
resolves the result.

No power-loss test confirms D6. The fix follows the standard write, sync, rename, and
directory sync order. Nobody verified whether Deno `syncData` on macOS flushes the drive
cache or only the kernel buffers.

## Evidence limits

### Receipt path identity

The public baseline regression selected the workspace workflow identity after
`alias/../ci.yml` redirected to another workflow. The corrected focused suite passed 42
tests and ignored one platform test. The integrated gate passed 348 Deno tests and 307
native checks.

The native CLI test executed the external workflow, left the workspace workflow
unexecuted, and saved a matching success receipt. It required native process inspection
outside the sandbox. Receipt tests cover dangling targets before and after creation,
relative links, confirmed cycles, long non-cyclic chains, non-directory components, and
native permission failure. The public Codex test confirms that unrelated success leaves a
failure unresolved. These tests do not establish atomic selection during concurrent
filesystem changes or migration of earlier incorrect identities.

### Source startup ownership

Public service tests reproduced unchecked baseline signaling after readiness failure. The
corrected service passed 28 focused tests. Tests cover changed identity, missing identity,
inspection failure, early exit, unknown child status, owned termination, launcher command
transition, and prior record restoration.

A native probe confirmed child status observation after `unref()`. The integrated gate
passed 348 Deno tests and 307 native checks, with one platform test ignored. The PID reuse
cases use capability doubles and signal no unrelated process. Inspection and signaling
remain separate operations.

### Recorded workflow results

The public daemon regression failed on the baseline because projection failure changed the
client's success result. The correction passed 63 focused daemon tests. The integrated
gate passed 348 Deno tests and 307 native checks, with one platform test ignored.

Public tests cover each projection target, conflicting recording, recording failure, and
ambiguous failure after recording. Restart restores the recorded result and clears its
journal without repeating execution. Tests also preserve prior spool files during a
projection fault and remove them after recovery. Existing journal cleanup and shutdown
checks pass. These checks do not establish power-loss durability.

### Task option parsing

The new public setup regression failed because baseline dependency discovery selected
`deno.json` as a task name. The corrected scanner passed 74 hook tests. Each new option
case completed below one second. Tests cover root options, recursion after options,
foreign configuration, changed directories, workspace runs, and printed command text.

Local Deno 2.9.7 probes confirmed optional-value behavior. `--lock probe` consumed `probe`
as a lock path and listed tasks. Bare `--env-file`, `--node-modules-dir`, and
`--frozen-lockfile` left `probe` as the task name. Equals forms selected the task
normally. These probes do not establish behavior for other Deno versions.

The first integrated gate passed 348 Deno tests, ignored one platform test, and passed 307
native checks. Formatting, lint, type checks, layer checks, and suppression checks passed.
This gate covers the first four fixes. Later sections record subsequent checks.

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
