# Implementation design

The runner executes one selected job against the current working tree on macOS. Workflow
validation produces an ordered plan before execution starts. Trusted shell commands retain
the authority of the invoking user.

## Module responsibilities

| Module               | Responsibility                                                                 |
| -------------------- | ------------------------------------------------------------------------------ |
| `workflow.ts`        | YAML validation, environment precedence, and plan construction                 |
| `process.ts`         | Process groups, cancellation, bounded termination, and identity checks         |
| `workspace.ts`       | Workspace exclusion, private scripts, and run recovery journals                |
| `runner.ts`          | Step order, environment filtering, deadlines, and final results                |
| `protocol.ts`        | Exact daemon request, response, snapshot, and terminal record shapes           |
| `ipc.ts`             | Bounded newline-delimited JSON transport and complete byte writes              |
| `client.ts`          | Daemon requests, request-log streaming, and caller cancellation                |
| `daemon.ts`          | Registration, queues, worker ownership, snapshots, and shutdown                |
| `daemon-store.ts`    | Registry, request journal, result projection, and spool retention              |
| `worker.ts`          | Isolated execution of one accepted plan                                        |
| `install.ts`         | Homebrew service startup and packaged monitor installation                     |
| `hooks.ts`           | Managed pre-commit hooks, stable tasks, and installation diagnosis             |
| `ci-receipt.ts`      | Session identity, invocation receipts, and atomic receipt storage              |
| `codex.ts`           | Session warnings, repair continuation, and Codex hook installation             |
| `cli.ts`             | Command routing, direct runs, daemon submission, and signal handling           |
| `runtime.ts`         | Version, source arguments, and self-invocation                                 |
| `result.ts`          | Expected failures and exception conversion at library and operating boundaries |
| `command.ts`         | Helper command capture with deadlines, byte budgets, and bounded cleanup       |
| `management.ts`      | Register, unregister, status, and log commands over the daemon socket          |
| `paths.ts`           | Service directory and socket paths, including the `MCI_HOME` override          |
| `homebrew.ts`        | Absolute Homebrew executable location shared by the installers                 |
| `monitor-process.ts` | Monitor process inspection and confirmed shutdown for the installer            |
| `main.ts`            | Process entry point: runs the CLI, reports a fatal error, and exits            |

The menu bar app lives in the Swift package `monitor/`. `MonitorCore` decodes daemon
snapshots, talks to the daemon socket, reads log tails, and maps repository states to
display states.

`MonitorApp` owns the SwiftUI panel, directory watch, log window, and login item.
`MonitorChecks` runs plain checks because Swift Testing macros failed in 10 of 22 runs on
the Command Line Tools toolchain.

The YAML package version and integrity value reside in `deno.lock`. The parser checks the
entire document before selected-job validation. An invalid unselected job can therefore
prevent execution when its YAML syntax is invalid. Unsupported semantics in an unselected
job do not prevent selected-job execution.

The planner retains unselected job names as display metadata. Worker input requires those
names to be strings. Empty names and NUL characters do not prevent selected-job execution.
Selected jobs and executable fields retain their stricter validation.

## Shared daemon lifecycle

One daemon serves one user through a private Unix socket. The daemon holds one FIFO queue
for each registered repository.

The daemon starts one worker per active repository. Different repositories can run at the
same time, while each repository runs one request at a time.

If `accept()` fails while the daemon is open, the daemon writes
`mci daemon: accept failed: <error>` to stderr and shuts down. The daemon does not retry.
The shutdown cancels the running job, as any shutdown does. The process exits with code 1.
The Homebrew service restarts the daemon. A daemon that runs in a terminal stays stopped.

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

Submission rejection finishes the journal before removing request files. Failed journal
cleanup retains those files for recovery. Any cleanup failure blocks further repository
work. The response preserves the primary rejection and cleanup failures. The daemon also
writes cleanup diagnostics to stderr, including during shutdown.

The daemon publishes a candidate queue count before admission. The candidate cannot enter
the executable queue until publication succeeds. Shutdown after publication still rejects
the candidate and completes rollback.

The daemon journals every accepted request before it confirms acceptance. On restart, it
records each unfinished request that began as INTERRUPTED and does not retry it. A durable
terminal record preserves completed work if projection or journal cleanup fails.

Terminal recording and projection are separate operations. Recording preserves the first
result for each request identifier. An identical repeated record succeeds. A conflicting
record fails. Projection updates `latest.json` from the recorded result.

After recording succeeds, the daemon returns that result and preserves it in memory. A
projection fault blocks further repository work and retains the journal and recovery
files. Restart projects the recorded result before journal cleanup. Recording failure
returns a storage diagnostic without replacing a possibly saved result. These operations
retain the existing sync policy. Power-loss durability remains unmeasured.

The daemon sends the response to a register or unregister request after the management
chain step ends. A client that does not read its response cannot stall later management
requests. The daemon publishes the snapshot before it resolves a job result. A shutdown
therefore ends after the last snapshot write.

Job snapshot publication is best effort at job start, at each step change, and at the end.
A failed write sends a diagnostic to stderr with the stage and request identifier. The
worker continues, and the daemon preserves the workflow result and live status. Snapshot
failure alone does not block execution. The fallback file can retain active or queued
state until a later publication succeeds. Service startup saves stderr in `daemon.log`.

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
each job, so recovery still precedes the next command. A request that leaves the queue
before it starts is not a result. Its own client receives the terminal, and the daemon
removes its journal entry and spool. It never replaces the latest completed result. This
rule also covers a queued request at shutdown. An active request at shutdown still records
INTERRUPTED as the latest result.

The request journal records whether a request began. The daemon writes `begun: true`
before it spawns the worker. After a daemon crash, restart recovery records INTERRUPTED
only for a request that began. A request that never began is not a result. Recovery
finishes its journal entry, removes its spool files, and keeps the latest result.

Startup retains logs and terminal records for pending requests and the latest result. It
retains worker control files only for pending journal entries. Successful recovery removes
obsolete controls, including files left after normal deletion fails. Failed recovery
retains pending controls for the next restart.

A crash between the journal write and the worker spawn records INTERRUPTED for a worker
that never ran. This order keeps the safe direction. The journal requires the `begun` key
in every entry. The daemon refuses to start on an entry without it and reports a decode
error. It does not guess whether the worker began.

The daemon writes the registry, the request journal, the terminal records, and
`latest.json` as durable writes. A durable write syncs the temporary file, renames it, and
then syncs the parent directory. A sync failure fails the write and removes the temporary
file. The daemon also syncs the spool log before it closes the log. The daemon does not
sync `snapshot.json`. It never reads that file, and it rewrites the file at each step
change. On 2026-10-03, a 2 KB atomic write took 0.23 ms without sync and 8.58 ms with sync
on an Apple Silicon host. Each value is the mean of 50 writes. No power-loss test confirms
this behavior. Nobody verified whether Deno `syncData` on macOS flushes the drive cache or
only the kernel buffers.

An interrupted atomic write leaves a `.write-*` file. At startup, before the listener
opens, the daemon removes regular files with this prefix from the service directory,
`.mci/ci`, and `.mci/ci/requests`. Only the daemon that holds `daemon.lock` writes this
prefix, so the cleanup cannot remove a file in use. The daemon keeps other names, such as
`.copy-*` and `.latest-*` from earlier versions. A removal failure in the service
directory stops the daemon at startup. A removal failure in a repository blocks that
repository, as other retention failures do.

After a worker exits, the daemon waits at most 2000 ms for its output to close. It then
cancels the readers. A request whose output stays open after that fails unless it was
cancelled. An earlier probe of the removed CI adapter measured stream EOF within 0.09 ms
of child exit. The 2000 ms value matches the process grace period.

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
disconnect. It projects the new result to `latest.json`.

The daemon accepts three limits. First, per-path routing keeps the arrival order only for
one path text. Two texts for one repository can reorder. The CLI sends the real path, so
the effect is small. Second, an older daemon refuses an 8-key journal entry. A downgrade
with pending requests fails to start. Third, one accept failure ends the daemon and
cancels the running job. The Homebrew service restarts the daemon.

## Workspace lifecycle

The runner resolves the workspace to a canonical directory before acquiring its lock. A
permanent `.mci/lock` file identifies the lock inode. A nonblocking exclusive file lock
prevents cooperating runners from sharing the workspace during execution. The operating
system releases the lock when the owning file descriptor closes.

Registration and daemon startup recover state under the same permanent lock. Recovery
alone creates no run directory or journal. The workspace module releases the lock after
recovery completes.

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
allow 1 MiB per stream. A MiB is 1,048,576 bytes. These budgets limit retained bytes, not
total process memory. The packager and `app:check` run helpers without capture budgets.

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
wide `ps` output with the C time locale and the UTC time zone. A change of the host time
zone then cannot change the recorded start text. The UTF-8 character locale prints
non-ASCII workspace paths verbatim. The C character locale would escape those bytes, and
the script path comparison would then fail. A journal that an earlier version wrote in the
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

Automatic CI runs only through Git's effective pre-commit hook. Git selects one hook path
for the repository. The packaged hook calls `deno task mci:ci`. That task submits
`ci/local-ci.yml`, job `check`, to the local daemon.

Managed hook installation sets the packaged Homebrew path with
`git config --local core.hooksPath`. Each clone needs its own configuration because Git
does not copy local settings. The tracked `mci:ci` task names the Apple Silicon prefix
`/opt/homebrew`. On an Intel-prefix host, setup refuses it as foreign until the task names
`/usr/local/opt/mci/bin/mci`. The checks cover the working tree, including unstaged
changes.

Manual verification and compilation remain available.

## Homebrew package and managed hooks

Hook installation and packaged installation share supported Homebrew location checks. They
inspect `/opt/homebrew/bin/brew` before `/usr/local/bin/brew`. Location does not depend on
`PATH`.

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
service, readiness, or launch failure, setup confirms monitor exit before restoring the
previous app. Uncertain shutdown retains the app and backup. Setup stops only a service
that setup started.

The daemon does not import state from earlier versions. It ignores `monitor.json` and
starts with an empty registry when `registry.json` does not exist. The daemon does not
read `status.json` or `latest.log`. A repository without `latest.json` has no latest
result. A state file with an unknown format stops the daemon with a decode error.

`mci hooks install` runs these steps in order. It stops at the first refusal.

1. Resolve the repository root with Git. A path that is not a worktree root is refused.
2. Validate the workflow and job with the workflow planner.
3. Validate the packaged hook installation: the binary exists, and the packaged
   `pre-commit` text equals the built-in hook script.
4. Read the effective `core.hooksPath`. If it equals the packaged hooks directory or its
   real path, skip step 6. If it names another directory, refuse and name it. Otherwise
   inspect the hooks directory that Git uses now. A new hook path disables every hook in
   that directory, so the installer refuses when it holds an active Git hook. A known hook
   name counts as active when the file is executable or a symbolic link. A `.sample` file
   does not count. The message names each active hook.
5. Add or keep the `mci:ci` task in `deno.json`. A matching task stays unchanged and
   causes no write. A different `mci:ci` task is refused. The write keeps the POSIX
   permission bits and replaces the file atomically. The write does not keep owners, ACLs,
   or extended attributes.
6. Run `git config --local core.hooksPath` with the packaged hooks directory.

Steps 1 to 4 and the conflict check of step 5 write nothing. If step 6 fails after the
`deno.json` write, the error names step 6 and says that a rerun completes the work.
Installation has no cancellation and no rollback. It does not enable
`extensions.worktreeConfig`. Linked worktrees share the local setting.

`mci hooks setup` configures one repository from a terminal. It keeps an existing
`ci/local-ci.yml` byte for byte. If that workflow is absent, it creates one step per
defined standard Deno task. The order is `fmt:check`, `lint`, `check`, then `test`. An
absent task is omitted. Setup requires at least one task. The repository workflow selects
optional tasks, including builds and browser checks. The corresponding commands remain in
`deno.json`. The YAML is the sole task-selection configuration. No repository name or path
selects different behavior in mci. Setup runs all install checks on the generated or
existing workflow before it writes the workflow or the ignore file. Then it adds `.mci/`
to `.gitignore` when necessary. This entry keeps runtime files outside Git changes and
Deno formatting. Last, setup runs steps 5 and 6 with job `check`.

mci does not scan task commands for recursion. A runtime check replaces the scan. The
daemon adds `MCI_DAEMON_SOCKET` and `MCI_REPOSITORY_PATH` to the inherited environment of
each job, after the client values. The workflow planner reserves both names. Before
`mci
ci` creates a receipt or submits, it compares its own daemon socket with
`MCI_DAEMON_SOCKET` and the real current directory with `MCI_REPOSITORY_PATH`. If both
match, the command prints an error and exits with status 2, because the job would wait for
itself. A daemon with another `MCI_HOME` has another socket, so a test daemon inside a job
accepts the submission.

A future worktree can inherit this hook path. Without the required task, the inherited
hook blocks commits.

Git's effective pre-commit hook is the only automatic trigger. Manual CLI commands remain
available for diagnosis and release evidence.

## CI failure communication in Codex

The CLI records each valid `ci` or `run` invocation when a session identifier exists. The
CLI selects `MCI_SESSION_ID`, then `CODEX_SESSION_ID`, then `CODEX_THREAD_ID`. Commands
outside a session do not create receipts.

Receipts live under the service directory in `sessions/<session-hash>/<invocation>.json`.
Receipt storage does not apply the daemon socket path limit, so a direct `mci run` works
with a long `MCI_HOME`. The session hash uses SHA-256. Each invocation uses a UUID. Each
receipt identifies the session, workspace, workflow, job, command, and start time.
Workspace and workflow paths use canonical identities when those paths exist. A missing
workflow keeps the canonical identity of its deepest existing parent, followed by the
missing path parts.

The CLI publishes a pending receipt before it validates the workflow or submits CI. The
final receipt records validation errors, daemon errors, unknown completion, or the
terminal outcome. The final time cannot precede the recorded start time. A completed
daemon request also records its request identifier and saved log path. An interrupted
client can leave a pending receipt. Receipt writes use private temporary files and atomic
rename. The reader rejects malformed receipts and symlinked receipt directories or files.

Workflow identity resolves symbolic links before following parent components. Existing
paths use filesystem resolution of the original invocation path. Missing paths resolve
existing components in order and retain the unresolved suffix. Relative and dangling link
targets follow the same order. Active link cycles and non-missing filesystem errors
produce a failure instead of a guessed identity.

Receipt fields and session rules remain unchanged. Earlier incorrect identities cannot
always be reconstructed because receipts contain no original invocation path. The adapter
does not rewrite or delete those receipts. A legacy unresolved receipt can need owner
inspection. Concurrent path changes between recording and execution remain outside the
atomicity contract.

`mci codex hook` reads receipts for an explicit `MCI_SESSION_ID` override or the event's
session identifier. The adapter ignores inherited `CODEX_SESSION_ID` and `CODEX_THREAD_ID`
because hook processes can retain identifiers from a parent session. An override must
exist before Codex starts so tools and hooks receive the same value. The adapter does not
correlate results through command text, modification times, or `latest.json`. A later
success clears only matching workspace, workflow, and job failures. The success must start
at or after the finish time of the failed invocation. For a pending invocation, the
adapter compares start times. A backward clock change can delay resolution until a passing
run starts at or after the recorded failure finish time. A result from another session
cannot clear the failure. A validation error receipt, with kind `error` and code 2, is the
one exception. A later success in the same workspace and session clears it for any
workflow and job, because a mistyped job or workflow path cannot pass on a rerun.

The adapter sends a warning for the user and repair context for the agent. Session start
and prompt submission restore unresolved failure context. A `Stop` event requests repair
continuation when unresolved results remain. If `stop_hook_active` is true, the adapter
reports the unresolved state without another continuation. The failure remains pending for
the next turn. This bound permits a blocker report without an endless continuation loop.

`mci codex install` merges managed handlers into the repository's `.codex/hooks.json`. The
installer preserves foreign handlers and replaces recognized mci handlers. Source hooks
call the source CLI. Packaged hooks call the stable Homebrew binary. Codex requires review
and trust for each new hook definition. The installer does not bypass trust or change the
daemon protocol. Session hooks read receipts and never start CI themselves.

Codex hook installation preserves existing POSIX permission bits. A new `hooks.json` uses
the explicit `0644` creation policy. Hosts without POSIX file modes do not establish
permission preservation through these checks.

Before replacing Codex configuration, installation compares the captured input with the
current file. Changed bytes, available identity metadata, or permissions cause a conflict.
Concurrent creation or removal also causes a conflict. The installer retains the current
file and removes its staged replacement. Separate inspection and rename do not exclude an
arbitrary writer after the comparison.

The adapter stores notification state separately from receipt JSON files. Receipts contain
result metadata, not inherited environment values or transcript content. Receipt storage
is separate from daemon projection and spool retention. The session owner removes receipt
directories after the session no longer needs them. No power-loss test establishes receipt
durability.

## Menu bar monitor

The app requests status from the daemon. The request has a one-second deadline and a four
MiB response limit. The app reads `snapshot.json` only when the daemon is unavailable, and
treats active data in that snapshot as stale.

The app watches the daemon state directory and refreshes on changes. It coalesces
filesystem events for 100 ms. A five-second timer repairs the watch and refreshes status.
The panel refreshes relative times every second.

The app can register or unregister a repository through daemon requests. Unregistration
fails while that repository has accepted requests.

The app does not install hooks. After folder registration succeeds, the panel shows a
hint. The hint tells the user to run `mci hooks setup <path>` once in a terminal. The
monitor does not inspect hooks.

The monitor does not submit or cancel CI. It opens repositories and reads selected spool
logs without changing them.

The log window reads only a regular file and refuses symbolic links. It reads the last 256
KiB, replaces invalid UTF-8, and renders ANSI SGR foreground colors and bold text.

The Launch at login control uses `SMAppService.mainApp`. The installer never changes the
login preference.

Each row shows the active request, queued count, and latest completed result. A separate
button opens the last completed log during an active request.

The combined icon uses the most urgent repository state. The states include unavailable,
error, missing, interrupted, failure, running, queued, cancelled, pass, and no runs. The
attention count covers unavailable, error, missing, interrupted, and failed repositories.

The packaged installer stages the bundle next to the destination. It replaces
`~/Applications/mci Monitor.app` only when the destination is a real folder whose
`Info.plist` carries `MCIInstaller = mci`. The installer moves the old bundle aside, then
moves the new bundle into place. If that move fails, the installer restores the old
bundle.

The installer uses monitor process inspection and shutdown. The matcher requires the
complete executable path at the command start, followed by whitespace or the command end.
The matcher treats regular-expression characters in the path literally and rejects sibling
executable prefixes. Native commands inspect full argument lists; this does not
authenticate the executable or make inspection and signaling atomic.

Shutdown sends SIGTERM once, then confirms absence through process inspection. The
observation policy is 2000 ms, with 100 ms between inspections. Command capture can extend
elapsed time beyond that policy. Packaged capture retains a 5000 ms deadline and 1000 ms
reaping policy. Packaged capture allows one MiB per output stream.

An inspection failure or observation timeout blocks bundle removal and replacement.
Packaged rollback also confirms shutdown before removing the new bundle. Failed rollback
shutdown retains the new bundle and any previous backup. A fresh packaged installation
retains only its new bundle when shutdown fails. The diagnostic retains the primary
failure and names the recovery location.

SIGTERM forces termination. Custom argument lists, ambiguous whitespace, process
replacement, and launches after inspection remain process matching limits.

The command `mci setup` copies the packaged bundle and verifies its signature. Setup also
requires a valid signature on an existing owned bundle.

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
