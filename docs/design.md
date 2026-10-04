# Implementation design

The runner executes one selected job against the current working tree on macOS. Workflow
validation produces an ordered plan before execution starts. Trusted shell commands retain
the authority of the invoking user.

## Module responsibilities

| Module            | Responsibility                                                                 |
| ----------------- | ------------------------------------------------------------------------------ |
| `workflow.ts`     | YAML validation, environment precedence, and plan construction                 |
| `process.ts`      | Process groups, cancellation, bounded termination, and identity checks         |
| `workspace.ts`    | Workspace exclusion, private scripts, and run recovery journals                |
| `runner.ts`       | Step order, environment filtering, deadlines, and final results                |
| `protocol.ts`     | Exact daemon request, response, snapshot, and terminal record shapes           |
| `ipc.ts`          | Bounded newline-delimited JSON transport                                       |
| `client.ts`       | Daemon requests, request-log streaming, and caller cancellation                |
| `daemon.ts`       | Registration, queues, worker ownership, snapshots, and shutdown                |
| `daemon-store.ts` | Registry, request journal, result projection, and spool retention              |
| `worker.ts`       | Isolated execution of one accepted plan                                        |
| `install.ts`      | Homebrew service startup and packaged monitor installation                     |
| `hooks.ts`        | Managed pre-commit hooks, stable tasks, and installation diagnosis             |
| `cli.ts`          | Command routing, direct runs, daemon submission, and signal handling           |
| `runtime.ts`      | Version, source arguments, and self-invocation                                 |
| `result.ts`       | Expected failures and exception conversion at library and operating boundaries |
| `command.ts`      | Helper command capture with deadlines, byte budgets, and bounded cleanup       |
| `management.ts`   | Register, unregister, status, and log commands over the daemon socket          |
| `paths.ts`        | Service directory and socket paths, including the `MCI_HOME` override          |
| `main.ts`         | Process entry point: runs the CLI, reports a fatal error, and exits            |

The menu bar app lives in the Swift package `monitor/`. `MonitorCore` decodes daemon
snapshots, talks to the daemon socket, reads log tails, and maps repository states to
display states.

`MonitorApp` owns the SwiftUI panel, directory watch, log window, and login item.
`MonitorChecks` runs plain checks because Swift Testing macros failed in 10 of 22 runs on
the Command Line Tools toolchain. `VERIFICATION.md` records that evidence.

The YAML package version and integrity value reside in `deno.lock`. The parser checks the
entire document before selected-job validation. An invalid unselected job can therefore
prevent execution when its YAML syntax is invalid. Unsupported semantics in an unselected
job do not prevent selected-job execution.

## Shared daemon lifecycle

One daemon serves one user through a private Unix socket. The daemon holds one FIFO queue
for each registered repository.

The daemon starts one worker per active repository. Different repositories can run at the
same time, while each repository runs one request at a time.

If `accept()` fails while the daemon is open, the daemon writes the error to stderr and
retries. The wait starts at 50 ms, doubles after each consecutive error, and stops at 1000
ms. A successful accept resets the wait. Shutdown ends the wait at once.

If `accept()` fails without a success for 60000 ms, the daemon stops. It writes
`mci daemon: accept failed for <n> ms; stopping` to stderr and shuts down. The shutdown
interrupts running jobs, as any shutdown does. The process exits with code 1, and launchd
restarts the daemon. The value 60000 ms is a policy, not a measured capacity.

A connection must send its first request within 5000 ms. The daemon closes a connection
that sends no first frame in that time. This value is a policy, not a measured capacity.

The submitting connection owns its request. A cancel message or connection loss cancels
only that request.

The submission client starts a 5000 ms acceptance deadline after connection. This deadline
covers the request write and acceptance reply. An acceptance reply clears that deadline.
An accepted request has no client deadline for execution or queue waiting.

The first abort starts a separate 10000 ms cancellation deadline and clears the acceptance
deadline. Cancellation handling starts before the request write. The client sends its
cancellation frame after the complete request frame. A blocked request write therefore
cannot mix submission and cancellation bytes.

If a deadline expires, the client closes its socket and reports unknown completion. The
request does not resume automatically. These deadlines are policies, not measured capacity
limits. A terminal reply clears both deadlines before the client drains its log. Blocked
terminal output writes remain outside these socket deadlines.

The daemon journals every accepted request before it confirms acceptance. On restart, it
records each unfinished request that began as INTERRUPTED and does not retry it. A durable
terminal record preserves completed work if projection or journal cleanup fails.

The daemon sends the response to a register or unregister request after the management
chain step ends. A client that does not read its response cannot stall later management
requests. The daemon publishes the snapshot before it resolves a job result. A shutdown
therefore ends after the last snapshot write.

The daemon resolves request paths in one chain for each path text. A stalled volume delays
only requests for its own path. An unregister request no longer reports busy after the
result frame of a finished client, even if that client keeps its connection open.

Shutdown cancels each pending submission wait for path resolution. The daemon releases its
socket and service lock without waiting for that resolver. A late resolution cannot accept
a request, allocate a spool, change the request journal, or start a worker.

The filesystem lookup can continue after the submission wait ends. This cancellation
boundary adds no timer and does not bound other filesystem operations during shutdown.

Registration and daemon startup recover each workspace. A held workspace lock, such as a
direct `mci run`, does not block the repository. The worker acquires the workspace before
each job, so recovery still precedes the next command. `mci doctor` reads `blocked`, so it
reports such a repository as ready.

A request that leaves the queue before it starts is not a result. Its own client receives
the terminal, and the daemon removes its journal entry and spool. It never replaces the
latest completed result or `latest.log`. This rule also covers a queued request at
shutdown. An active request at shutdown still records INTERRUPTED as the latest result.

The request journal records whether a request began. The daemon writes `begun: true`
before it spawns the worker. After a daemon crash, restart recovery records INTERRUPTED
only for a request that began. A request that never began is not a result. Recovery
finishes its journal entry, removes its spool files, and keeps the latest result.

A crash between the journal write and the worker spawn records INTERRUPTED for a worker
that never ran. This order keeps the safe direction. A journal entry without the `begun`
key comes from an older daemon. The new daemon reads such an entry as begun.

The daemon writes the registry, the request journal, the terminal records, `latest.json`,
`status.json`, `latest.log`, and the legacy log copy as durable writes. A durable write
syncs the temporary file, renames it, and then syncs the parent directory. A sync failure
fails the write and removes the temporary file. The daemon also syncs the spool log before
it closes the log. The daemon does not sync `snapshot.json`. It never reads that file, and
it rewrites the file at each step change. On 2026-10-03, a 2 KB atomic write took 0.23 ms
without sync and 8.58 ms with sync on an Apple Silicon host. Each value is the mean of 50
writes. No power-loss test confirms this behavior. Nobody verified whether Deno `syncData`
on macOS flushes the drive cache or only the kernel buffers.

An interrupted atomic write leaves a `.write-*` or `.copy-*` file. Older daemons also left
`.latest-*` files. At startup, before the listener opens, the daemon removes regular files
with these three prefixes from the service directory, `.mci/ci`, and `.mci/ci/requests`.
Only the daemon that holds `daemon.lock` writes these prefixes, so the cleanup cannot
remove a file in use. The daemon keeps other names, such as `.status-*` from a direct run.
A removal failure in the service directory stops the daemon at startup. A removal failure
in a repository blocks that repository, as other retention failures do.

After a worker exits, the daemon waits at most 2000 ms for its output to close. It then
cancels the readers. A request whose output stays open after that fails unless it was
cancelled. An earlier probe of the CI adapter measured stream EOF within 0.09 ms of child
exit. The 2000 ms value matches the process grace period.

A signal to a worker that already exited is not a failure. The daemon tracks worker exit
and skips the signal. At shutdown, only a cancelled result becomes INTERRUPTED. A worker
that already returned its final result keeps that result. A queued request that the daemon
settles because its repository is blocked keeps the kind failure at shutdown.

When a repository becomes blocked, the daemon settles every queued request of that
repository with a failure result. The detail names the block. The daemon starts no queued
command for a blocked repository. It rejects a later submission with the block as the
unavailable reason.

When a pending request has no spool log on restart, the daemon treats the log as empty. It
creates an empty log in the request directory and finishes the journal entry. A log path
outside that directory keeps the failure.

Each snapshot carries an active request, queue count, latest completed result, and blocked
state for every repository. New work does not replace the latest completed result.

Each request writes an immutable spool under `.mci/ci/requests/`. The daemon retains the
latest completed spool and every spool held by a connected client. Pending journal entries
also retain their recovery files.

When a newer request completes, the daemon removes the older spool after its clients
disconnect. It projects the new result to `latest.json`, `status.json`, and `latest.log`.

The daemon accepts three limits. First, per-path routing keeps the arrival order only for
one path text. Two texts for one repository can reorder. The CLI sends the real path, so
the effect is small. Second, an older daemon refuses an 8-key journal entry. A downgrade
with pending requests fails to start. Third, the accept failure stop interrupts running
jobs.

## Workspace lifecycle

The runner resolves the workspace to a canonical directory before acquiring its lock. A
permanent `.mci/lock` file identifies the lock inode. A nonblocking exclusive file lock
prevents cooperating runners from sharing the workspace during execution. The operating
system releases the lock when the owning file descriptor closes.

The runner creates a private `run-*` directory beneath `.mci/`. The journal records its
format version, private directory, and active process record. The runner writes the
initial journal before it creates a script or launches a process. Journal updates use a
temporary file and atomic rename.

On each acquisition, the workspace module removes orphan `run-*` directories from earlier
runs. It skips every other `run-*` entry, such as a file, a symlink, or a directory whose
name is not a private name. A skipped entry never blocks a run. A conforming directory
that cannot be removed still fails the acquisition.

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
with SIGKILL escalation after the grace period. The grace period is two seconds. This
value is a policy, not a measured capacity. The process module bounds the subsequent wait
for the direct child. Cleanup errors make the run fail and preserve the original execution
detail. OS scheduling and filesystem operations prevent a hard real-time completion
guarantee.

On macOS, a group signal returns EPERM when the remaining group members are all unreaped
zombies. Deno reaps the direct child and launchd reaps orphans, so such a group soon
disappears. After a group signal error, the process module polls the group with signal 0
for at most the reap period. A group that disappears counts as clean. Otherwise the
original error remains. The module sends no other signal to a reaped PID. Run cleanup and
recovery use the same rule.

Native process inspection uses bounded command capture. If inspection times out or exceeds
an output budget, the capture module starts bounded cleanup. The module kills its live
direct child, bounds reaping, and closes both output pipes. Registration failure keeps its
original diagnostic. Confirmed group cleanup and reaping allow the process module to clear
the record even after registration fails.

Capture policies require independent byte budgets for stdout and stderr. Ordinary helpers
allow 1 MiB per stream. The source monitor's Swift build allows 16 MiB per stream. A MiB
is 1,048,576 bytes. These budgets limit retained bytes, not total process memory. The
packager and `app:check` run helpers without capture budgets.

An exact budget remains valid. The first chunk beyond the remaining budget causes a
capture failure. The diagnostic names the command, stream, and byte budget. The module
retains that diagnostic if cleanup also fails. The module rejects invalid budgets before
spawning the command. Workflow output continues to stream through the runner.

The `mci` task sets an internal marker for parent supervision. The CLI captures its parent
PID and checks the current parent during execution. `mci ci` always watches its parent.
`mci run` watches its parent only when the marker is set. Parent death cancels the job
through the existing signal path. The CLI clears the watcher after the run. The runner
removes the marker from step environments, and workflow validation rejects marker
overrides.

## Recovery rules

The next run reads the journal while it holds the workspace lock. Recovery compares the
recorded PID, process group, start text, and unique script path. The process module uses
wide `ps` output with a fixed locale and the UTC time zone. A change of the host time zone
then cannot change the recorded start text. A journal that an earlier version wrote in the
host time zone fails recovery once with a different start time. Recovery checks identity
immediately before SIGTERM and at each grace poll.

`ps` exits 1 with empty output for an absent PID. It exits 1 with stderr text for an
invalid PID. The process module treats only the first case as absent. It reports every
other `ps` failure as an error.

A missing leader with no remaining group counts as completed cleanup. A missing leader
with an existing group leaves identity uncertain. A changed command or start identity also
leaves identity uncertain. Recovery reports those states and preserves the journal instead
of signaling an unconfirmed process. This refusal applies to the first check, before
recovery sends any signal. The diagnostic identifies the recorded PID and private state
location for manual investigation.

After recovery confirms the leader and sends SIGTERM, it waits for the grace period. If
the group still exists then, the leader can be present or gone. Recovery sends SIGKILL to
the group without another identity check and waits for the group to disappear. Run cleanup
also escalates to SIGKILL. A group that survives SIGKILL leaves cleanup uncertain.

Recovery makes no second identity check before SIGKILL. It confirmed the leader before
SIGTERM and saw the group at the last grace check. A reused group ID needs three events
between two polls: the group vanishes, the PID becomes a new group leader, and that leader
exits. This window is the same class as the race in run cleanup. The claim that macOS
keeps a group ID reserved while any member exists is an inference from XNU source. Nobody
measured it.

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

`ci/local-ci.yml` contains the supported local workflow. Its shell steps call Deno tasks
directly.

GitHub serves only as a repository backup service. The repository has no GitHub Actions
workflow or remote test trigger.

Automatic CI runs only through `.githooks/pre-commit`. The hook resolves the repository
root and calls `deno task ci`.

`deno task hooks:install` sets the local Git hook path to `.githooks`. Each clone needs
its own installation because Git does not copy local configuration. The checks cover the
working tree, including unstaged changes. Manual verification and compilation remain
available. `VERIFICATION.md` records observed coverage and keeps evidence limits explicit.

## Homebrew package and managed hooks

`scripts/package.ts` compiles the CLI and builds the signed monitor bundle. It writes a
local archive and `dist/tap/Formula/mci.rb`.

The packager creates tar output under a unique private path. It computes the archive
checksum and prepares complete formula text before publication. The published archive
filename includes the full SHA-256 checksum, as
`mci-<version>-darwin-<architecture>-<sha256>.tar.gz`. Publication never replaces an
existing checksum-named archive. An existing archive must be a real regular file with
matching contents.

The packager publishes the complete archive before replacing the formula. The packager
removes its private archive before the formula switch. A successful switch therefore
returns success with no later fallible step. One rename beside `dist/tap/Formula/mci.rb`
switches the formula to the new archive. A checksum, preparation, archive publication, or
formula switch failure preserves the earlier formula and its archive.

Concurrent publishers prepare separate files. Each formula switch names an already
published matching archive. The last switch wins. Earlier archives remain available for
copied formulas. A failed switch can leave an unreferenced complete archive. The
repository maintainer owns archive removal. Power-loss durability retains its existing
evidence limits.

The formula installs the CLI, stores the monitor under `libexec`, and defines `mci daemon`
as a Homebrew service.

`mci setup` installs the packaged monitor and starts the service when the daemon does not
answer. Setup runs its helper commands with bounded waits and byte budgets. After a
service, readiness, or launch failure, setup restores the previous app. Setup stops only a
service that setup started.

The daemon imports the earlier registry only when its own registry does not exist. For a
repository without `latest.json`, the daemon imports a version 1 `status.json` from the
legacy CI adapter. Removing the `status.json` projection requires a compatibility
decision.

`mci hooks install` validates one job and rejects recursive CI calls. It adds a stable
`mci:ci` Deno task and selects the packaged hook through an absolute Homebrew path. Git
configuration applies to the current worktree.

If Git configuration fails after the task write, the installer attempts to restore the
previous `deno.json` contents. If the installer enabled `extensions.worktreeConfig`, it
attempts to restore the previous value or absence of that setting. One failed rollback
does not prevent the remaining restoration attempts.

The diagnostic retains the primary error and every failed restoration result. Each
rollback failure names the affected target and gives the recovery action. Git recovery
commands use the previous value or remove a previously absent setting. The rollback
diagnostic does not print the previous `deno.json` contents.

A future worktree can inherit this hook path. Without the required task, the inherited
hook blocks commits. Hook installation rejects unsafe shared Git settings.

The managed hook is the only automatic trigger. Manual CLI commands remain available for
diagnosis and release evidence.

## Menu bar monitor

The app requests status from the daemon. The request has a one-second deadline and a four
MiB response limit. The app reads `snapshot.json` only when the daemon is unavailable, and
treats active data in that snapshot as stale.

The app watches the daemon state directory and refreshes on changes. It coalesces
filesystem events for 100 ms. A five-second timer repairs the watch and refreshes relative
times.

The app can register or unregister a repository through daemon requests. Unregistration
fails while that repository has accepted requests.

The monitor does not submit or cancel CI. It opens repositories and reads selected spool
logs without changing them.

The log window reads only a regular file and refuses symbolic links. It reads the last 256
KiB, replaces invalid UTF-8, and renders ANSI SGR foreground colors and bold text.

The Launch at login control uses `SMAppService.mainApp`. The installers never change the
login preference.

Each row shows the active request, queued count, and latest completed result. A separate
button opens the last completed log during an active request.

The combined icon uses the most urgent repository state. The states include unavailable,
error, missing, interrupted, failure, running, queued, cancelled, pass, and no runs. The
attention count covers unavailable, error, missing, interrupted, and failed repositories.

Both installers stage the bundle next to the destination. They replace
`~/Applications/mci Monitor.app` only when the destination is a real folder whose
`Info.plist` carries `MCIInstaller = meeci`. Each moves the old bundle aside, moves the
new one into place, and restores the old one if that move fails.

`deno task monitor:install` builds the app, signs it ad hoc, verifies the signature, and
registers the repository through the daemon. It requires a running daemon. On a reinstall,
the source installer keeps the old bundle until the new app runs. After a registration,
open, or startup failure, it quits the new app, restores the previous bundle, and opens
it. If restoration fails, the error names the retained backup. The command `mci setup`
copies the packaged bundle and verifies its signature. Setup also requires a valid
signature on an existing owned bundle.

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
