# Implementation design

The runner executes one selected job against the current working tree on macOS. Workflow
validation produces an ordered plan before execution starts. Trusted shell commands retain
the authority of the invoking user.

## Module responsibilities

| Module               | Responsibility                                                                          |
| -------------------- | --------------------------------------------------------------------------------------- |
| `workflow.ts`        | YAML parsing, supported-field validation, environment precedence, and plan construction |
| `process.ts`         | Process groups, cancellation, bounded termination, and process identity checks          |
| `command.ts`         | Bounded command capture, pipe closure, and command reaping                              |
| `workspace.ts`       | Workspace exclusion, contained step preparation, private scripts, and recovery journals |
| `runner.ts`          | Step order, environment filtering, job deadlines, and final results                     |
| `cli.ts`             | Arguments, platform policy, diagnostics, and OS signal listeners                        |
| `ci.ts`              | Saved CI output, writer exclusion, cancellation, and atomic status records              |
| `monitor.ts`         | SwiftBar menu rendering and logger inspection                                           |
| `install-monitor.ts` | Plugin generation and safe installation                                                 |
| `runtime.ts`         | Version and source arguments that select shared configuration                           |
| `result.ts`          | Expected failures and exception conversion at library and OS boundaries                 |

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

The adapter launches the source CLI directly with parent supervision enabled. It forwards
OS cancellation and observes its own Deno task parent. The existing CLI handles workflow
process cleanup if the logging adapter dies.

The status record includes the logger's PID, native process start text, and command. The
SwiftBar plugin compares that identity through bounded `/bin/ps` inspection. An absent or
changed identity with running status displays interrupted.

Completed legacy records remain readable. A live legacy running record displays an
identity error. The menu opens the fixed log path or repository and refreshes its display.
The monitor provides no CI trigger.

The installer creates an executable plugin with absolute Deno and repository paths. It
uses the configured SwiftBar plugin directory when available. Otherwise it selects a
dedicated directory outside SwiftBar's internal cache. Plugin installation leaves
unrelated plugins in place. The plugin enters the quoted repository path before using
`--allow-read=.`. Its process permission permits only `/bin/ps`. Logs and status remain
local and gitignored.

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
