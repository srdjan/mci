# Hardening fix plan

## Scope

This plan fixes eight confirmed findings from `docs/hardening-audit.md`. The user chose
Decision 4 A and Decision 5 A on 2026-10-03. Decision 5 A states that a request that never
started is not a result. The plan excludes the plausible findings D6 to D9, P4, and the
test-name finding T1.

Each fix starts with a test that fails on the current code. Each fix is one commit on
local main. The pre-commit hook runs `deno task ci`. No commit is pushed.

## Order

The fixes run in this order: P3, P2, P1, D4, D5, D2, D3, D1. P1, P2, and P3 change the
process and workspace modules. D4 changes `recoverWorkspace` after P2 changes the same
file. D5 adds the helper that D2 uses. D1 changes the daemon start and accept loop last.

## P3: run `ps` in UTC

`inspectProcessIdentity` in `src/process.ts` passes `env: { LC_ALL: "C" }` with
`clearEnv: true`. `ps` then prints `lstart` in the system time zone. Change the
environment to `{ LC_ALL: "C", TZ: "UTC" }`.

Test in `tests/process_test.ts`: inspect `Deno.pid` and compare the `started` text with
the trimmed output of `/bin/ps -o lstart= -p <pid>` under `env -i LC_ALL=C TZ=UTC`. The
test fails before the fix on a host whose zone is not UTC. This host uses a zone 4 hours
behind UTC.

A journal written before this change and retained after a crash fails recovery once with
"different start time". Record this one-time effect in `docs/design.md`.

## P2: skip stray `run-*` entries

The orphan sweep in `recoverState` in `src/workspace.ts` passes every entry that starts
with `run-` to `removePrivateDirectory`. A regular file, a symlink, or a name outside
`^run-[A-Za-z0-9._-]+$` returns an error, and `acquireWorkspace` fails on every run.

Change the sweep. Remove an entry only when `entry.isDirectory`, not `entry.isSymlink`,
and `privateDirectory(state, path)` are all true. Skip every other `run-*` entry without
an error. Keep the error for a conforming directory that cannot be removed. Do not change
`removePrivateDirectory` or journal handling.

Test in `tests/workspace_test.ts`: create `.mci/run-notes.txt`, `.mci/run-with space/`,
`.mci/run-`, and a symlink `.mci/run-link` to a temporary directory. Then call
`acquireWorkspace`. Expect success, and expect all four entries and the symlink target to
remain. Close the lease.

## P1: escalate recovery to SIGKILL after its own SIGTERM

`recoverProcess` in `src/process.ts` confirms the identity and sends SIGTERM to the group.
When the grace wait ends with the state "orphaned", recovery returns "leader is absent
while its group still exists" and sends no SIGKILL. Run cleanup escalates in the same
situation.

Change the code after the grace wait. `waitForRecovery` returns the state from its last
identity check. When that state is "gone", return success. When the state is "matched" or
"orphaned", send SIGKILL with
`signalSettledGroup(record.pid, "SIGKILL", capabilities,
policy)`. Do not recheck the
identity through `signalRecoveryGroup` first. That recheck refuses an orphaned group, so a
leader that exits between the last grace check and the recheck would still block recovery.
When the SIGKILL group signal returns an error, return that error. When it returns
`ok(false)`, return `ok(undefined)`. Otherwise wait with `waitForRecovery` for
`policy.reapMs`. Return success for "gone", and return the existing "cleanup remains
uncertain after SIGKILL" error otherwise.

Keep the refusal when the first `recoveryState` call, before any signal, reports
"orphaned". Recovery then never confirmed the identity. The existing test "recoverProcess
rejects an orphaned group without a kill signal" must still pass.

Safety: recovery confirmed the leader identity before SIGTERM, and the last grace check
saw the group. A reused group ID needs these events between two polls: the group fully
vanishes, the PID becomes a new group leader, and that leader exits. This window is the
same class as the existing cleanup race in `cleanProcess`. The claim that macOS keeps a
group ID reserved while any member exists is an inference from the XNU fork code. Nobody
measured it.

Test in `tests/process_test.ts` with a hand-written `ProcessCapabilities` record, as in
"recoverProcess waits for group disappearance after SIGKILL". `inspect` returns the
matching identity until SIGTERM, and `ok(null)` after it. `signalGroup(pid, 0)` returns
`ok(true)` until SIGKILL, and `ok(false)` after it. Expect `ok(undefined)` and the group
signals SIGTERM, then signal 0 probes, then SIGKILL.

Add a second test for the late exit. `inspect` returns the matching identity for the
SIGTERM check and every grace poll, and `ok(null)` after the grace period.
`signalGroup(pid,
0)` returns `ok(true)` until SIGKILL, and `ok(false)` after it. Expect
`ok(undefined)` and a SIGKILL. On the current code, this case returns "leader is absent
while its group still exists".

## D4: a busy workspace lock does not block a repository

Registration and daemon startup call `recoverWorkspace` and copy any error into
`state.blocked`. A held workspace lock returns "another job is already running in this
workspace". No code clears `blocked`, so the repository stays blocked after the lock is
released.

In `src/workspace.ts`, move the body of `acquireWorkspace` into an internal function that
returns `Result<RunLease | "busy">`. It returns `"busy"` when `tryLock` returns false.
Before it returns `"busy"`, it closes the lock file, and it returns an error when that
close fails. `acquireWorkspace` keeps its signature and maps `"busy"` to the existing
error text. Change `recoverWorkspace` to return `Result<"recovered" | "busy">`, and map
`"busy"` to `ok("busy")` without a lease.

In `src/daemon.ts`, registration and `prepareRuntime` set `blocked` only for an error. For
`ok("busy")`, they leave the repository unblocked. The worker runs its own
`acquireWorkspace` before each job, so recovery still happens before the next command. Use
a `switch` or an explicit comparison on the returned value. `mci doctor` reads `blocked`,
so it reports a busy repository as ready after this change.

Test in `tests/daemon_test.ts`: start a daemon without registration. Create `.mci`, open
`.mci/lock`, and hold it with `tryLock(true)`. Register the workspace and expect
`blocked === null`. Release the lock, submit a job, and expect success.

## D5: a request that never started is not a result

`cancelQueued` sends a queued request through `complete`. `complete` writes the cancelled
terminal as the latest result, projects an empty `latest.log`, and retires the spool of
the previous result.

Add a function `settleUnstarted(runtime, repository, job, terminal)` in `src/daemon.ts`
for a job that left the queue before it started. The caller removes the job from the queue
first. The function does these steps in this order:

1. When `runtime.closed` is true, change the terminal to kind "interrupted", code 143, and
   detail "The daemon stopped before completion.", as `complete` does.
2. Call `runtime.store.finish(job.id)`. On failure, set `repository.blocked` to
   `request journal cleanup failed: ...` with `??=`.
3. Call `retire(runtime, repository.repository.path, terminal)`. This removes the spool
   files, or marks them obsolete while the client holds them.
4. Set `job.child = null`, call `job.resolve(terminal)`, and call `publish(runtime)`.

The function must not call `writeTerminal` and must not change `repository.latest`. It
must not throw. Use `attempt` for any direct OS call.

Change `cancelQueued` to call `settleUnstarted` for a job that it removes from the queue.
The `close()` path calls `cancelQueued`, so a queued job at shutdown also leaves the
latest result unchanged. An active job at shutdown still records "interrupted" as the
latest result. The test "daemon shutdown closes idle clients and interrupts unfinished
requests" covers the active case and must still pass.

Known limit: the request journal does not record whether a request started. After a daemon
crash, restart recovery projects every pending request without a terminal as the
"interrupted" latest result. A queued request that never started therefore still replaces
the latest result after a crash. Record this limit in `docs/design.md`.

Test in `tests/daemon_test.ts`: submit a job that prints known output and succeeds. Start
a second job that waits for a release file. Queue a third job and cancel it with SIGINT.
Expect the third result kind "cancelled". While the second job still runs, expect
`latest.id` to equal the first id, `latest.json` to hold the first id, `latest.log` to
contain the known output, and the first spool log to exist. Release the second job in a
`finally` block, so that a failed assertion reports itself instead of a cleanup error.

## D2: settle queued requests when a repository becomes blocked

`pump` returns when `repository.blocked !== null` and leaves the queue in place. A queued
request then never completes.

Change `pump`. When the daemon is open, no job is active, and the repository is blocked,
remove every queued job and settle it with `settleUnstarted`. Use a failed terminal with
kind "failure", code 1, and detail `repository is blocked: <blocked text>`. Settle the
jobs one at a time in an async helper that `pump` starts with `void`. The helper calls
`queue.shift()` in each iteration and does not copy the queue. The helper must not throw.

A block can occur in `complete`, `retire`, and `release` through `blockRetention`.
`complete` already calls `pump`. Change `blockRetention` to return the repository that it
blocked. Then `release` calls `pump` for that repository after it publishes the snapshot.

Test in `tests/daemon_race_test.ts` with `withRaceDaemon`, as in "retention failure blocks
later submissions without launching commands". The injected store fails `removeRun`.
Submit a first job and let it finish, so that the latest result is set. Start a second job
that waits for a release file, and queue a third job that would create a forbidden file.
Release the second job. Its completion retires the first spool, the injected failure
blocks the repository, and `pump` settles the third job. Race the third result against a 2
s timer, so that the test fails instead of hanging on the current code. Expect kind
"failure" and a detail that names the block. Expect no forbidden file. Release the second
job in a `finally` block.

## D3: a missing spool log does not block a repository

On restart, `prepareRuntime` projects an interrupted terminal for a pending request.
`writeTerminal` in `src/daemon-store.ts` copies `terminal.log` to `latest.log`. If the
user removed `.mci`, the copy fails, the repository becomes blocked, and the journal entry
stays for every later restart.

Change `writeTerminal`. After `prepareRequestDirectory`, check `terminal.log` with
`metadata`. When the file is absent and `terminal.log` equals
`${directory}/${terminal.id}.log`, create it with `createPrivateFile`, and then copy as
usual. When the file is absent and the path differs, keep the current failure. Do not
create a file outside the request directory.

Test in `tests/daemon_race_test.ts` with `prepareRecovery`: accept a pending request
without a durable terminal. Remove the workspace `.mci` directory. Start the daemon.
Expect `blocked === null`, `latest.kind === "interrupted"`, an empty journal, and an empty
`latest.log`. Then expect a submitted job to succeed.

## D1: survive `accept()` errors and bound the first request

The accept loop in `startDaemon` calls `close()` on any `accept()` error. A connection
that sends no first frame holds a descriptor without a deadline.

Add two `startDaemon` options for tests:

- `listen?: (path: string) => DaemonListener`, where `DaemonListener` is an exported type
  with `accept(): Promise<Deno.UnixConn>` and `close(): void`. The default calls
  `Deno.listen({ transport: "unix", path })`.
- `requestDeadlineMs?: number`, default 5000. This value is a policy, not a measured
  capacity.

Change the accept loop. On an error while the daemon is open, write
`mci daemon: accept failed: <error>` to stderr. Then wait, and continue the loop. The wait
starts at 50 ms, doubles after each consecutive error, stops at 1000 ms, and resets after
a successful accept. When the daemon is closed, break as now. `close()` must end the wait
at once: keep the timer handle and clear it in `close()`, or race the wait against a close
signal. Keep the accept loop promise, and make `close()` await it before `closeResolve()`.
Then no timer stays pending after `closed` resolves.

Change `handleConnection`. Race the first `messages.next()` against a timer of
`requestDeadlineMs`. When the timer wins, close the connection and return. Clear the timer
in every case. Pass the deadline through `DaemonRuntime` or a function parameter.

Tests in `tests/daemon_test.ts`:

- Wrap the real listener so that the first `accept()` rejects. Expect a submitted job to
  succeed, the socket to exist, and `closed` to stay unresolved.
- Wrap the real listener so that every `accept()` rejects, and close the daemon at once.
  Expect the test to end without a pending timer.
- Use `requestDeadlineMs: 100`. Open a raw connection and send nothing. Expect `read` to
  return `null` within 2 s. Then expect a `status` request to succeed.

## Documentation

Update `docs/design.md` for each behavior change: accept errors, the first-request
deadline, the busy lock at registration, settlement of requests that never started, a
missing spool log, recovery escalation, stray `run-*` entries, and `ps` in UTC. Mark the
eight findings as fixed in `docs/hardening-audit.md` with their commit hashes. Add the new
test evidence to `VERIFICATION.md`.

## Out of scope

`complete` resolves a job before it publishes the snapshot, and `close()` does not wait
for that publish. A test cleanup can then fail with "Directory not empty". This plan does
not fix that race.

## Verification

After each fix, run the new test and the test file of the changed module. Before each
commit, the hook runs `deno task ci`. After the last fix, rerun the audit probes for D1,
D2, D3, D4, D5, P1, and P2. Record each result.
