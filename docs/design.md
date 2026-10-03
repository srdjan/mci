# Implementation design

The runner executes one selected job against the current working tree on macOS. Workflow
validation produces an ordered plan before execution starts. Trusted shell commands retain
the authority of the invoking user.

## Module responsibilities

| Module         | Responsibility                                                                          |
| -------------- | --------------------------------------------------------------------------------------- |
| `workflow.ts`  | YAML parsing, supported-field validation, environment precedence, and plan construction |
| `process.ts`   | Process groups, cancellation, bounded termination, and process identity checks          |
| `command.ts`   | Bounded command capture, pipe closure, and command reaping                              |
| `workspace.ts` | Workspace exclusion, contained step preparation, private scripts, and recovery journals |
| `runner.ts`    | Step order, environment filtering, job deadlines, and final results                     |
| `cli.ts`       | Arguments, platform policy, diagnostics, OS signal listeners, and the `ci` command      |
| `ci.ts`        | Saved CI output, writer exclusion, cancellation, and atomic status records              |
| `runtime.ts`   | Version, source arguments, and self-invocation for source and compiled modes            |
| `result.ts`    | Expected failures and exception conversion at library and OS boundaries                 |

The menu bar app lives in the Swift package `monitor/`. `MonitorCore` holds the status
decoder, display states, the combined state, the registry, and process inspection.
`MonitorApp` holds the SwiftUI panel and the file watches. `MonitorChecks` runs plain
checks, because Swift Testing macros fail intermittently with only the Command Line Tools.
`scripts/install-monitor.ts` builds, signs, and installs the app. `scripts/registry.ts`
writes the registry. `scripts/app-check.ts` builds the package and runs `MonitorChecks`
inside `deno task verify` on macOS.

The YAML package version and integrity value reside in `deno.lock`. The parser checks the
entire document before selected-job validation. An invalid unselected job can therefore
prevent execution when its YAML syntax is invalid. Unsupported semantics in an unselected
job do not prevent selected-job execution.

## Workspace lifecycle

The runner resolves the workspace to a canonical directory before acquiring its lock. A
permanent `.mci/lock` file identifies the lock inode. A nonblocking exclusive file lock
prevents cooperating runners from sharing the workspace during execution. The operating
system releases the lock when the owning file descriptor closes.

The runner creates a private `run-*` directory beneath `.mci/`. The journal records its
format version, private directory, and active process record. The runner writes the
initial journal before it creates a script or launches a process. Journal updates use a
temporary file and atomic rename.

The workspace module resolves each step directory when that step starts. A prior step can
create the directory. Canonical containment checks reject configured directories outside
the workspace. The workspace module writes each script with private file permissions.

The process module records the group leader identity after process creation. The runner
clears that record only after process cleanup and child reaping succeed. The workspace
module removes the private directory before removing the journal. An uncertain process or
failed cleanup retains recovery evidence. The workspace module releases the lock last on
every handled return.

## Process supervision

Each step uses a fresh Bash process group with closed stdin and inherited output. Bash
receives `--noprofile --norc -e -o pipefail`. The first failed step stops the selected
job. An export or directory change affects only the current shell; file changes persist
between steps.

The job deadline starts immediately before the first process launch. The deadline remains
active between steps and during ordinary cleanup. Cancellation reaches the active group,
with SIGKILL escalation after the configured grace period. The process module bounds the
subsequent wait for the direct child. Cleanup errors make the run fail and preserve the
original execution detail. OS scheduling and filesystem operations prevent a hard
real-time completion guarantee.

On macOS, a group signal returns EPERM when the remaining group members are all unreaped
zombies. Deno reaps the direct child and launchd reaps orphans, so such a group soon
disappears. After a group signal error, the process module polls the group with signal 0
for at most the reap period. A group that disappears counts as clean. Otherwise the
original error remains. The module sends no other signal to a reaped PID.

Native process inspection uses bounded command capture. If inspection times out, the
capture module kills its subprocess, bounds reaping, and closes its output pipe.
Registration failure keeps its original diagnostic. Confirmed group cleanup and reaping
allow the process module to clear the record even after registration fails.

The `mci` task sets an internal marker for parent supervision. The CLI captures its parent
PID and checks the current parent during execution. Parent death cancels the job through
the existing signal path. The CLI clears the watcher after the run. The runner removes the
marker from step environments, and workflow validation rejects marker overrides.

## Recovery rules

The next run reads the journal while it holds the workspace lock. Recovery compares the
recorded PID, process group, start text, and unique script path. The process module uses
wide `ps` output with a fixed locale. Recovery checks identity immediately before each
signal.

A missing leader with no remaining group counts as completed cleanup. A missing leader
with an existing group leaves identity uncertain. A changed command or start identity also
leaves identity uncertain. Recovery reports those states and preserves the journal instead
of signaling an unconfirmed process. The diagnostic identifies the recorded PID and
private state location for manual investigation.

Recovery remains best effort because process inspection and signaling are separate
operations. A crash between process creation and journal persistence can leave an
unrecorded process. The runner does not claim automatic recovery for that interval or for
detached descendants. File locks are advisory and inode-bound; trusted commands can
replace the lock file or alter runner state.

## Configuration and checks

`deno.json` owns the application version and the `mci` permission set. Direct source,
compilation, and test tasks select that set. The runtime module supplies source arguments
with absolute source and configuration paths. The CLI reports the host, Deno version, and
resolved Bash path.

`ci/local-ci.yml` contains the supported local workflow. GitHub serves only as a
repository backup service. Automatic CI runs only through `.githooks/pre-commit`. The hook
resolves the repository root and calls `deno task ci`. The logging adapter executes the
local YAML, which calls `deno task verify` directly. Failed checks block the commit.

`deno task hooks:install` sets the local Git hook path to `.githooks`. Each clone needs
its own installation because Git does not copy local configuration. The checks cover the
working tree, including unstaged changes. Manual verification and compilation remain
available. `VERIFICATION.md` records observed coverage and keeps evidence limits explicit.

## Saved CI results and monitor

The CI adapter holds a separate file lock beneath `.mci/ci/` before replacing saved
output. It publishes running status before replacing the log with a private new file. The
adapter rejects log symlinks and preserves other hard links. It streams both output
channels to the terminal and `.mci/ci/latest.log`.

Atomic status updates record running, pass, fail, or cancelled. A nonzero child exit keeps
its exit code when logging also fails. Cancellation converts a zero child exit to the
interruption code.

After the child process exits, the adapter waits for stdout and stderr to close for an
output grace period of 2000 ms. A detached process, for example one started with `setsid`,
can hold a pipe open. The adapter then cancels the stream reader and records a diagnostic.
The diagnostic converts a zero child exit to failure. Cancellation after the child exits
cuts open streams at once and keeps the cancelled state. The adapter never signals the
detached holder. The holder receives EPIPE or SIGPIPE on its next write.

The `mci ci` command runs the adapter. The adapter launches `mci run` from the same
program with parent supervision enabled. A source run starts Deno with the source
arguments. A compiled binary starts itself. `mci ci` always watches its own parent, so the
death of Git or `deno task` cancels the job. It forwards OS cancellation. The existing CLI
handles workflow process cleanup if the logging adapter dies.

The status record includes the logger's PID, native process start text, and command. A
reader can compare that identity through bounded `/bin/ps` inspection. An absent or
changed identity with running status means that the logger was interrupted. Completed
legacy records remain readable. Logs and status remain local and gitignored.

## Menu bar monitor

The status decoder in `MonitorCore` accepts exactly what `readCiStatus` accepts. Shared
fixtures in `tests/fixtures/monitor/decode/` hold raw status text and the expected value
or error category. Both `MonitorChecks` and `tests/monitor_fixtures_test.ts` check every
fixture, so the two decoders cannot drift apart unnoticed.

A running record is checked with bounded `/bin/ps` inspection, as before. A matching
logger shows RUNNING; an absent or changed logger shows INTERRUPTED. A registered folder
that no longer exists shows MISSING. The combined icon shows the most urgent state in this
order: ERROR, MISSING, INTERRUPTED, FAIL, RUNNING, CANCELLED, PASS, NO RUNS.

The registry `~/Library/Application Support/meeci/monitor.json` holds exactly
`{ "version": 1, "workspaces": [...] }`. Every writer holds an exclusive lock on
`monitor.json.lock` around read, validation, write, and rename. Deno `FsFile.lock` and
Swift `flock(2)` exclude each other; a probe confirmed this on macOS 26.6.2. A writer
stores canonical directory paths without duplicates and leaves a malformed registry
unchanged.

The app watches the registry folder and each `.mci/ci/` folder. It recreates a watch after
its folder is deleted or renamed. A 5 s timer re-checks running loggers, retries missing
watches, and updates relative times.

The installer stages the bundle next to the destination, signs it ad hoc, and verifies the
signature. It replaces `~/Applications/mci Monitor.app` only when the destination is a
real folder whose `Info.plist` carries `MCIInstaller = meeci`. It moves the old bundle
aside, moves the new one into place, and restores the old one if that move fails.

## Release responsibility

The repository maintainer owns release acceptance, supported-host claims, and dependency
updates. A contributor owns the checks and evidence for each submitted change. The
repository maintainer accepts a release only after reviewing those results and unresolved
compatibility limits. The workflow author owns command versions and the trust decision for
workflow scripts. The invoking user owns local credentials, installed tools, and manual
investigation after uncertain recovery.

## Product boundaries

The runner does not sandbox child commands or mask secrets. The runner does not implement
GitHub actions, expressions, event evaluation, scheduling, or unselected-job execution.
The runner does not restore project files or record a history of completed runs. The
runner validates reserved environment names and removes inherited GitHub runner state. The
remaining inherited environment and installed commands remain inputs to the job.

A local pass covers the selected job and current workspace only. It does not establish
clean-commit status, reproducible toolchains, or GitHub-hosted image parity. A
compatibility claim requires execution on the named operating system and architecture.
Unmeasured hosts remain outside the verified support statement.
