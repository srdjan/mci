# Hardening follow-up plan

## Scope

This plan fixes the items that `docs/hardening-fix-plan.md` left open. These items are the
plausible findings D6 to D9 and P4, the test finding T1, the restart limit of Decision 5
A, and the retry loop for a permanent `accept()` failure. `docs/hardening-audit.md`
describes each finding.

Each code fix starts with a test that fails on the current code, when a test can show the
defect. Each fix is one commit on local main. The pre-commit hook runs `deno task ci`. No
commit is pushed.

## Measurements on this host

On 2026-10-03, these probes ran on Apple Silicon macOS with the project Deno:

- `env -i LC_ALL=C TZ=UTC /bin/ps -ww -o pid=,pgid=,lstart=,command= -p <pid>` exits 1
  with empty stdout and empty stderr for an absent PID such as 99999 or 0. It exits 1 with
  a stderr message for 2147483647 ("process id too large"), -1, and `abc`.
- `child.kill("SIGTERM")` after `await child.status` throws
  `TypeError: Child process has
  already terminated`. The error is not
  `Deno.errors.NotFound`.
- `Deno.open(directory, { read: true })` followed by `sync()` succeeds on a directory.
- A 2 KB atomic write took 0.23 ms without sync. With `syncData` on the file and `sync` on
  the directory, it took 8.58 ms. Each value is the mean of 50 writes.
- The Homebrew service uses `keep_alive true`, so launchd restarts the daemon after any
  exit.

## Validation

On 2026-10-03, a Fable subagent validated this plan against the code. It reported 12
findings, and this plan includes the corrections for all of them. The main correction is
the U5 test step: perl must leave the step group before Bash exits.

## Order

U1 P4, U2 D6, U3 D9 temporary files, U4 restart limit, U5 D7, U6 D8, U7 D9 routing, U8 D9
busy unregister, U9 accept failure limit, U10 T1, U11 documentation.

## U1: P4, classify a `ps` failure exactly

`inspectProcessIdentity` in `src/process.ts` returns `ok(null)` when `ps` exits non-zero
with empty stdout. Change the rule. Return `ok(null)` only when the exit code is 1, stdout
is empty after trim, and stderr is empty after trim. Otherwise return an error that names
the exit code and includes the trimmed stderr text.

Tests in `tests/process_test.ts`:

- `inspectProcessIdentity(2_147_483_647)` returns an error that contains "too large". This
  test fails before the fix.
- Replace the PID in "recoverProcess accepts an already-gone process" with a real absent
  PID. Spawn `/usr/bin/true`, await its status, and use its PID. Keep the expected
  `ok(undefined)`.

## U2: D6, sync atomic writes

`atomicBytes` and `atomicCopy` in `src/daemon-store.ts`, and the `latest.log` projection
in `writeTerminal`, rename a temporary file without a sync. Add a `durable` flag. For a
durable write, call `syncData()` on the temporary file before close and rename. After the
rename, open the parent directory with `{ read: true }`, call `sync()`, and close it. A
sync failure is a write failure, and the existing cleanup removes the temporary file.

Also call `syncData()` on the spool log in `drainWorkerOutput` in `src/daemon.ts` before
its close. Otherwise `latest.log` can hold more than the spool after a power loss.

Use durable writes for the registry, the journal, terminal records, `latest.json`,
`status.json`, `latest.log`, and the legacy log copy. Do not sync the snapshot. The daemon
never reads `snapshot.json`, it rewrites the snapshot at every step change, and a sync
costs about 8.6 ms on this host.

Test: no test can simulate a power loss. The existing store and daemon tests must still
pass. Report the `deno task test` wall time after the change. The baseline is 10.80 s for
170 passed tests and 1 ignored test.

Limit: nobody verified whether Deno `syncData` on macOS flushes the drive cache
(`F_FULLFSYNC`) or only the kernel buffers. The 8.58 ms cost suggests a real flush, but it
is not proof.

## U3: D9 part 1, remove interrupted temporary files at startup

An interrupted atomic write leaves `.write-*`, `.copy-*`, or `.latest-*` files. Nothing
removes them. Only the daemon that holds `daemon.lock` writes these prefixes, and startup
runs before the listener opens. Startup cleanup therefore cannot remove a file that a
write still uses.

Change `openDaemonStore`: after `realDirectory(paths.directory)`, remove each regular,
non-symlink file in the service directory whose name starts with `.write-`. Change
`pruneRuns`: remove each regular, non-symlink file in the request directory that starts
with `.write-` or `.copy-`. Also remove each such file in `<repository>/.mci/ci` that
starts with `.write-` or `.latest-`. Do not remove other names, such as `.status-*` from
`src/ci.ts`. A removal failure returns an error, as other prune failures do.

Test in `tests/daemon_test.ts`: create `.write-a` in the service directory, `.write-b` and
`.copy-c` in `.mci/ci/requests`, `.write-d`, `.latest-e`, and `.status-f` in `.mci/ci` of
a registered repository. Start the daemon. Expect the first five files to be gone and
`.status-f` to remain. `pruneRuns` runs only at startup, so register the repository before
the daemon starts. Use `prepareRecovery` in `tests/daemon_race_test.ts` or a prior daemon
run. `pruneRuns` returns early when the request directory is missing. The `.mci/ci`
cleanup must still run in that case, and a missing `.mci/ci` counts as empty.

## U4: restart limit, do not record a request that never started

The journal does not record whether a request started. After a crash, restart recovery
records every unfinished request as INTERRUPTED. A queued request that never started can
then replace the latest result. This conflicts with Decision 5 A: a request that never
started is not a result.

Change `PendingRequest` in `src/daemon-store.ts` to add `begun: boolean`. `accept` stores
`begun: false`. `begin` stores `begun: true` with the new `started` value. `decodePending`
accepts the 8-key entry only when `typeof begun === "boolean"`. It also accepts the old
7-key entry and decodes it as `begun: true`, so a journal from an older daemon keeps the
old behavior.

Change `prepareRuntime` in `src/daemon.ts`. Keep the saved-terminal check first. When no
saved terminal exists and `pending.begun` is false, call `store.finish(pending.id)` and
continue. Do not write a terminal and do not change `state.latest`. On a finish failure,
set `state.blocked ??=` the existing "request journal cleanup failed" text. The prune loop
that follows removes the spool files, because the request is no longer pending.

`begin` writes the journal before the worker spawns. A crash between the two records an
INTERRUPTED result for a worker that never ran. This order keeps the safe direction.

Tests in `tests/daemon_test.ts`, darwin only, with a daemon subprocess as in "daemon
restart marks an accepted request interrupted without retry":

- Submit request A with `touch started; sleep 30`. Wait for `started`. Submit request B to
  the same repository, and wait until the snapshot shows `queued: 1`. Read A's ID from the
  snapshot `active.id` and B's ID from the journal file. SIGKILL the daemon, and wait
  until `.mci/run.json` is gone. Restart with `startDaemon`. Expect `latest.id` to be A's
  ID with kind `interrupted`, an empty journal, and no `.mci/ci/requests/<B>.*` files.
  This test fails before the fix, because B becomes the latest result.
- `prepareRecovery.save` in `tests/daemon_race_test.ts` calls `store.accept` with 7 keys.
  Add `begun: true` there, so the existing recovery tests keep their INTERRUPTED
  expectation.
- Add a test that writes a 7-key `requests.json` entry by hand, starts the daemon, and
  expects an INTERRUPTED latest result. The existing tests write through `accept`, so they
  do not cover the legacy decode.

## U5: D7, a signal to an exited worker is not a failure

`signalWorker` ignores only `NotFound`. After Deno reaps the worker, `kill` throws
`TypeError`, so a cancel after worker exit records "worker signal failed". Also,
`complete` relabels every terminal as INTERRUPTED during shutdown. A worker that already
returned its final result then loses that result.

Change `Job` to add `exited: boolean`, initially false. In `runWorkerProcess`, right after
the spawn, register `child.status.then(() => job.exited = true, () => job.exited = true)`.
In `signalWorker`, skip `kill` when `job.exited` is true. In the catch block, also ignore
`TypeError`. Add one comment: for the fixed signal names, Deno throws `TypeError` only for
a terminated child.

Add a helper `shutdownTerminal(runtime, terminal)`. It returns the INTERRUPTED form only
when `runtime.closed` is true and `terminal.kind` is `"cancelled"`. Otherwise it returns
the terminal unchanged. Use the helper in `complete` and in `settleUnstarted`. A worker
cancelled by shutdown still reports `cancelled`, so the existing shutdown tests keep
INTERRUPTED.

Tests in `tests/daemon_race_test.ts`, darwin only. Both tests need a window after the
worker exits and before `complete` runs. A step can open this window with a detached
process that holds the worker stdout. Bash must wait until perl has left the group,
because `cleanProcess` sends SIGTERM to the group as soon as Bash exits. Use this step:
`perl -MPOSIX -e 'POSIX::setsid(); open(my $f, ">", "detached"); close $f; sleep 1' &
while [ ! -f detached ]; do sleep 0.01; done; touch done`.
The validation probe kept the pipe open for about 1000 ms after Bash exit in 5 of 5 runs.

- Wait for `done`, then wait 300 ms. Send `cancel` with `SIGINT` on the submit connection.
  Expect the result kind `success`. Before the fix, the kind is `cancelled` with detail
  "worker signal failed".
- Wait for `done`, then wait 300 ms. Close the daemon. Expect `latest.json` kind
  `success`. Before the fix, the kind is `interrupted`.

During shutdown, a queued request that `settleBlocked` settles keeps the kind `failure`
instead of `interrupted`. This change is accepted.

The 300 ms wait is a test margin, not a measurement. If either test does not fail before
the fix, report the observed result and stop. Do not change the fix to suit the test.

## U6: D8, send management responses outside the management chain

`handleRequest` runs register and unregister inside `runtime.management`, and
`handleOperation` sends the snapshot inside that chain. A client that does not read can
stall the chain when the snapshot exceeds the socket buffers.

Change register and unregister so that the chain step computes the response, including
`snapshot(runtime)`, and the send and close happen after the chain step ends. The chain
must not wait for `sendJson`. Keep the order of the state changes. Keep the
`runtime.closed` check.

Test in `tests/daemon_test.ts`: register enough repositories to make the snapshot larger
than 24 KiB. `sysctl` reports `net.local.stream.sendspace` and `recvspace` as 8192 each,
so a snapshot above 16 KiB stalls the write. Use long directory names to keep the count
low. Open a raw connection, send a register request for one more repository, and do not
read. Then `rpc` a register for another repository. Race the second register against a
2000 ms timer, and expect the register to win. The client's own 5000 ms timeout in
`src/client.ts` must not decide the result. This test fails before the fix. Report the
test duration.

## U7: D9 part 2, route each request path separately

`submitRequest` puts every path resolution in one `runtime.routing` chain. A stalled
volume then delays every submission. The chain exists to keep the arrival order of
requests for the same path.

Replace `routing: Promise<void>` with `routing: Map<string, Promise<void>>`, keyed by the
request path text. Chain each resolution behind the previous one for the same key. When a
chain step settles and the map still holds that step, delete the key.

Test in `tests/daemon_test.ts`: start the daemon with a `resolvePath` option. For path A,
it returns a promise that the test resolves later. For other paths, it calls
`Deno.realPath`. Register repositories A and B before the stall starts. Submit to A, then
submit to B. Race B's result against a 3000 ms timer, and expect B to win before A is
released. Without the race, the test hangs before the fix. Registration uses
`Deno.realPath` in the store, not `resolvePath`, so registration order does not matter.
This test fails before the fix.

## U8: D9 part 3, unregister after a finished client

`repository.accepting` counts a submission until `watchSubmission` returns.
`watchSubmission` waits for the client to close its connection. A finished client that
keeps its connection open therefore makes unregister report `busy`.

Change `submitRequest`. Decrement `accepting` directly when `prepareSubmission` returns
`null` or throws. For a non-null job, attach `job.result.then(decrement)` in
`submitRequest` before `watchSubmission` starts. Do not attach the callback at job
creation: the `!sent.ok` path in `prepareSubmission` resolves `job.result` and then
returns `null`, which would decrement twice. Because the callback attaches before
`watchSubmission`, the `result` frame implies the decrement. From the queue push until the
result, `queue` or `active` already blocks unregister.

Test in `tests/daemon_test.ts`: submit a short job on a raw connection. Read the
`accepted` and `result` frames, and keep the connection open. Unregister the repository.
Expect `ok`. This test fails before the fix with `busy`.

## U9: stop the daemon after a long `accept()` failure

The accept loop retries forever with a backoff of at most 1000 ms. A permanent failure
would leave a daemon that serves nothing.

Add the option `acceptFailureLimitMs` to `startDaemon`, with the default 60000 ms. This
value is a policy, not a measured capacity. Record the time of the first failure in a
streak, and clear it after a successful accept. When a failure occurs and the streak has
lasted at least the limit, log `mci daemon: accept failed for <n> ms; stopping`, record
the failure, and leave the loop. After the loop ends, call `void close()`. Do not await
`close()` inside the loop, because `close()` awaits the loop.

Change `closed` to `Promise<Result<void>>`. It resolves to an error after an accept
failure stop, and to `ok(undefined)` otherwise. `runDaemon` prints the error and returns

1. launchd restarts the daemon in both cases. Update the `withTestDaemon` parameter type
   in `tests/daemon_test.ts` and every other caller that types `closed`. The stop
   interrupts running jobs, as any shutdown does.

Test in `tests/daemon_test.ts`: use `failingListener` with a failure count that never ends
and `acceptFailureLimitMs: 200`. Expect `closed` to resolve to an error within 3000 ms and
the socket to be gone. With this limit, the failures occur at about 0, 50, 150, and 350
ms, so the stop occurs at about 350 ms. Before the fix, this test fails as a type error on
the unknown option. The existing transient-failure test must still pass.

## U10: T1, rename the slow-client test

The test "a client that does not read cannot block its worker" proves that a worker with
256 KiB of output finishes while its client reads nothing. Worker output goes to the spool
file, so the socket carries only the `accepted` and `result` frames. Rename the test to "a
worker with large output finishes while its client reads nothing". Add that sentence about
the spool file as one comment.

## U11: documentation

Update `docs/design.md`: replace the restart-limit paragraph, and describe the durable
writes, the startup temporary-file cleanup, the accept failure limit, and the D7, D8, and
D9 behavior. Update `docs/hardening-audit.md`: add each commit to the fix status table,
and state that no power-loss test confirms D6. Remove the sentence that no test covers D1
to D4.

Also record three limits in `docs/design.md`. First, per-path routing keeps the arrival
order only for one path text, so two texts for one repository can reorder. The CLI sends
the real path, so the effect is small. Second, an older daemon refuses an 8-key journal,
so a downgrade with pending requests fails to start. Third, the accept failure stop
interrupts running jobs.
