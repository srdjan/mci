# Implementation design

The runner executes one selected job against the current working tree on macOS. Workflow
validation produces an ordered plan before execution starts. Trusted shell commands retain
the authority of the invoking user.

## Module responsibilities

| Module            | Responsibility                                                                 |
| ----------------- | ------------------------------------------------------------------------------ |
| `workflow.ts`     | YAML validation, environment precedence, and plan construction                 |
| `process.ts`      | Process groups, cancellation, bounded termination, and identity checks         |
| `workspace.ts`    | Workspace exclusion, private scripts, and worker recovery journals             |
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

The menu bar app lives in the Swift package `monitor/`. `MonitorCore` decodes daemon
snapshots and maps repository states to display states.

`MonitorApp` owns the SwiftUI panel, daemon client, snapshot watch, and log window.
`MonitorChecks` runs plain checks without Swift Testing macros.

The YAML package version and integrity value reside in `deno.lock`. The parser checks the
entire document before selected-job validation. An invalid unselected job can therefore
prevent execution when its YAML syntax is invalid. Unsupported semantics in an unselected
job do not prevent selected-job execution.

## Shared daemon lifecycle

One daemon serves one user through a private Unix socket. The daemon holds one FIFO queue
for each registered repository.

The daemon starts one worker per active repository. Different repositories can run at the
same time, while each repository runs one request at a time.

The submitting connection owns its request. A cancel message or connection loss cancels
only that request.

The daemon journals every accepted request before it confirms acceptance. On restart, it
records each unfinished request as INTERRUPTED and does not retry it. A durable terminal
record preserves completed work if projection or journal cleanup fails.

Registration and daemon startup recover each workspace. A held workspace lock, such as a
direct `mci run`, does not block the repository. The worker acquires the workspace before
each job, so recovery still precedes the next command.

A request that leaves the queue before it starts is not a result. Its own client receives
the terminal, and the daemon removes its journal entry and spool. It never replaces the
latest completed result or `latest.log`. This rule also covers a queued request at
shutdown. An active request at shutdown still records INTERRUPTED as the latest result.

The request journal does not record whether a request started. After a daemon crash,
restart recovery therefore records every unfinished request as INTERRUPTED. A queued
request that never started can still replace the latest result in this case.

When a repository becomes blocked, the daemon settles every queued request of that
repository with a failure result. The detail names the block. The daemon starts no queued
command for a blocked repository, and it settles a request that arrives later in the same
way.

Each snapshot carries an active request, queue count, latest completed result, and blocked
state for every repository. New work does not replace the latest completed result.

Each request writes an immutable spool under `.mci/ci/requests/`. The daemon retains the
latest completed spool and every spool held by a connected client. Pending journal entries
also retain their recovery files.

When a newer request completes, the daemon removes the older spool after its clients
disconnect. It projects the new result to `latest.json`, `status.json`, and `latest.log`.

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
with SIGKILL escalation after the configured grace period. The process module bounds the
subsequent wait for the direct child. Cleanup errors make the run fail and preserve the
original execution detail. OS scheduling and filesystem operations prevent a hard
real-time completion guarantee.

On macOS, a group signal returns EPERM when the remaining group members are all unreaped
zombies. Deno reaps the direct child and launchd reaps orphans, so such a group soon
disappears. After a group signal error, the process module polls the group with signal 0
for at most the reap period. A group that disappears counts as clean. Otherwise the
original error remains. The module sends no other signal to a reaped PID. Run cleanup and
recovery use the same rule.

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
wide `ps` output with a fixed locale and the UTC time zone. A change of the host time zone
then cannot change the recorded start text. A journal that an earlier version wrote in the
host time zone fails recovery once with a different start time. Recovery checks identity
immediately before each signal.

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

The formula installs the CLI, stores the monitor under `libexec`, and defines `mci daemon`
as a Homebrew service.

`mci setup` installs the packaged monitor and starts the service when necessary. The
daemon imports the earlier registry only when its own registry does not exist.

`mci hooks install` validates one job and rejects recursive CI calls. It adds a stable
`mci:ci` Deno task and selects the packaged hook through an absolute Homebrew path. Git
configuration applies to the current worktree.

A future worktree can inherit this hook path. Without the required task, the inherited
hook blocks commits. Hook installation rejects unsafe shared Git settings.

The managed hook is the only automatic trigger. Manual CLI commands remain available for
diagnosis and release evidence.

## Menu bar monitor

The app requests status from the daemon. It reads `snapshot.json` only when the daemon is
unavailable, and treats active data in that snapshot as stale.

The app watches the daemon state directory and refreshes on changes. A five-second timer
repairs the watch and refreshes relative times.

The app can register or unregister a repository through daemon requests. Unregistration
fails while that repository has accepted requests.

The monitor does not submit or cancel CI. It opens repositories and reads selected spool
logs without changing them.

Each row shows the active request, queued count, and latest completed result. A separate
button opens the last completed log during an active request.

The combined icon uses the most urgent repository state. The states include unavailable,
error, missing, interrupted, failure, running, queued, cancelled, pass, and no runs.

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
