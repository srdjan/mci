# Hardening audit

## Scope and method

On 2026-10-03, two read-only reviews audited the process and workspace code and the daemon
code. The first review read `process.ts`, `command.ts`, `runner.ts`, `worker.ts`, and
`workspace.ts`. The second review read `daemon.ts`, `daemon-store.ts`, `protocol.ts`,
`ipc.ts`, `client.ts`, and the worker boundary. The audit excluded limits that the project
already accepts, such as advisory locks and best-effort recovery.

Each review supplied probes that ran against temporary directories. The main session reran
every probe for a confirmed finding on Apple Silicon macOS and observed the stated output.
A plausible finding comes from a code reading only. It needs a probe or a test before a
fix.

## Ranked findings

| Rank | Label | Finding                                                               | Severity   | Status |
| ---- | ----- | --------------------------------------------------------------------- | ---------- | ------ |
| 1    | D1    | One `accept()` error stops the daemon and interrupts every job        | High       | Fixed  |
| 2    | P1    | Recovery does not escalate to SIGKILL after its own SIGTERM           | Medium     | Fixed  |
| 3    | D3    | A pending request without its spool log blocks a repository           | Medium     | Fixed  |
| 4    | D4    | Registration during a direct run blocks a repository until restart    | Medium     | Fixed  |
| 5    | D2    | A queued request behind a blocked repository waits without limit      | Medium     | Fixed  |
| 6    | D5    | A cancelled queued request replaces the latest completed result       | Medium-low | Fixed  |
| 7    | P2    | A stray `run-*` entry in `.mci` blocks every later run                | Low        | Fixed  |
| 8    | P3    | The recorded start time depends on the host time zone                 | Low        | Fixed  |
| 9    | D6    | Atomic writes rename without `fsync`                                  | Low-medium | Fixed  |
| 10   | D7    | A cancel after worker exit records a false storage failure            | Low        | Fixed  |
| 11   | P4    | A failed `ps` with empty stdout counts as an absent process           | Low        | Fixed  |
| 12   | D8    | A non-reading management client stalls later register calls           | Low        | Fixed  |
| 13   | D9    | Global routing chain, temporary-file orphans, and a wrong busy reason | Low        | Fixed  |
| 14   | T1    | One daemon test name claims more than the test proves                 | Low        | Fixed  |

Labels with D come from the daemon review. Labels with P come from the process review.

## Fix status

On 2026-10-03, the plan in `docs/hardening-fix-plan.md` fixed the eight confirmed
findings. Each fix has a test that failed before the change. The main session reran the
audit probes after the fixes, and each probe showed the corrected behavior.

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

Commit `73c3c3b` corrected the P1 late-exit test, and commit `1a75652` corrected two
design sentences.

On 2026-10-03, the plan in `docs/hardening-followup-plan.md` fixed the plausible findings
D6 to D9, P4, and the test finding T1. It also fixed the restart limit of the earlier D5
fix and the retry loop for a permanent `accept()` failure. Each code fix except D6 has a
test that failed before the change. No test can simulate the power loss that D6 describes.
D9 has three parts, so it has three rows.

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

## Confirmed findings

### D1: one `accept()` error stops the daemon

The accept loop in `src/daemon.ts` calls `close()` when `listener.accept()` fails. A
connection that sends no first frame holds one descriptor without a deadline. When the
descriptors run out, `accept()` fails with EMFILE. Then `close()` sends SIGTERM to every
worker, records each job as interrupted, removes the socket, and exits with code 0. The
daemon writes no diagnostic. launchd restarts the daemon, but all running CI is lost.

Evidence: a daemon under `ulimit -n 48` accepted 25 idle connections. The daemon then
exited with code 0, removed its socket, and wrote nothing to stderr.
`launchctl limit
maxfiles` reports a soft limit of 256 for launchd services. Whether macOS
returns a transient `accept()` error such as ECONNABORTED needs measurement.

Fix direction: log an `accept()` error, wait briefly, and continue while the listener is
open. Close a connection that sends no first frame before a deadline.

### P1: recovery does not escalate to SIGKILL

`recoverProcess` in `src/process.ts` sends SIGTERM to a confirmed group. Bash exits at
once, but a child that ignores TERM survives. The grace wait then sees an absent leader
with a live group. Recovery returns "leader is absent while its group still exists" and
sends no SIGKILL. The journal stays, so every later run of that workspace fails. The child
keeps running until the user kills it. Run cleanup escalates to SIGKILL in the same
situation.

Evidence: with a 300 ms grace period, recovery failed after 308 ms. The leader exited with
SIGTERM, and the TERM-ignoring child stayed alive. The same child under `runProcess` was
killed.

Fix direction: after recovery delivers SIGTERM to a confirmed group, escalate to SIGKILL
when the grace wait ends with a live group. Keep the refusal when recovery never confirmed
the identity.

### D3: a pending request without its spool log blocks a repository

Suppose the daemon stops with an accepted request, and the user then removes `.mci` in the
repository. On restart, `writeTerminal` cannot copy the missing spool log. The repository
becomes blocked, and the journal entry stays. Every later restart repeats the failure. The
user must edit the service journal by hand, and no message names it.

Evidence: after the first restart, a submit returned "interrupted request storage failed:
No such file or directory". After the second restart, the journal still held one entry,
and a submit still failed.

Fix direction: treat a missing spool log as an empty log, so that recovery finishes the
journal entry.

### D4: registration during a direct run blocks a repository until restart

Registration and daemon startup copy a `recoverWorkspace` error into the repository
`blocked` field. A held workspace lock produces such an error. No code path clears
`blocked`. When a direct `mci run` holds the lock during registration or startup, the
repository stays blocked after the lock is released.

Evidence: with the lock held, registration returned "blocked = another job is already
running in this workspace". After the lock was released, a submit still failed with the
same reason.

Fix direction: do not keep a busy lock as a permanent block. Retry workspace recovery
before the next submission.

### D2: a queued request behind a blocked repository waits without limit

`pump` in `src/daemon.ts` returns when a repository is blocked, and it leaves the queue in
place. A queued request then never starts and never completes. Its client, often the
pre-commit hook, waits until the user presses Ctrl-C.

Evidence: an injected retention failure blocked the repository after the first job. The
queued client still waited after 3 s, and only its own cancellation ended it.

Fix direction: when a repository becomes blocked, complete every queued request with an
"unavailable" result.

### D5: a cancelled queued request replaces the latest result

`cancelQueued` sends a request that never started through `complete`. `complete` makes the
cancelled record the latest result, copies its empty log to `latest.log`, and removes the
spool of the previous result. The monitor then shows CANCELLED with an empty log. The
previous log is lost. This conflicts with the design rule that new work does not replace
the latest completed result.

Evidence: after a PASS, a queued request was cancelled while another job ran. Then
`latest.json` held `cancelled`, `latest.log` held 0 bytes, and the PASS spool was gone.

Fix direction: a product decision comes first. If a cancelled request that never started
is not a result, record its terminal for its client only and skip the projection.

### P2: a stray `run-*` entry blocks every later run

The orphan sweep in `src/workspace.ts` treats every `.mci` entry that starts with `run-`
as a private directory. A regular file, a symlink, or a name outside the private pattern
makes the sweep fail. The same error then occurs on every run.

Evidence: `run-notes.txt`, `run-with space`, `run-`, and a `run-link` symlink each failed
twice in a row. A conforming `run-abc` directory was removed, and the run succeeded.

Fix direction: skip entries that are not real directories or that do not match the
pattern. Keep the error for a conforming directory that cannot be removed.

### P3: the recorded start time depends on the time zone

`inspectProcessIdentity` clears the environment and sets only `LC_ALL`. `ps` then prints
`lstart` in the system time zone. If the zone changes between a crash and the next run,
recovery reports a different start time and keeps the journal.

Evidence: for one process, `ps` printed 17:51:31 with the system zone, 21:51:31 with
`TZ=UTC`, and 06:51:31 on the next day with `TZ=Asia/Tokyo`. The end-to-end block was not
reproduced.

Fix direction: set `TZ=UTC` for `ps`. A journal written before the change would fail
recovery once.

### T1: a daemon test name claims more than it proves

The test "a client that does not read cannot block its worker" in `tests/daemon_test.ts`
writes worker output to the spool file, not to the socket. The unread frames are smaller
than 1 KiB, and the socket buffers hold 16 KiB, so the test cannot fail for socket
backpressure. Commit `b03729f` renamed the test to "a worker with large output finishes
while its client reads nothing".

## Plausible findings

D6: `atomicBytes` and `atomicCopy` in `src/daemon-store.ts` rename a temporary file
without `syncData`. After a power loss, a file can be empty. The daemon then refuses to
start and launchd restarts it into the same failure. A power-loss test is necessary to
confirm this.

D7: `signalWorker` ignores only `NotFound`. Deno throws `TypeError` for a reaped child, so
a cancel or disconnect after worker exit records "worker signal failed". Shutdown also
relabels a just-finished job as interrupted. The `TypeError` was observed. The full race
did not occur in two attempts.

P4: `inspectProcessIdentity` returns "absent" when `ps` exits non-zero with empty stdout,
and it discards stderr. A `ps` failure for a live process would skip the journal record.
The test "recoverProcess accepts an already-gone process" uses PID 2147483647. `ps`
rejects that PID as too large, so the test does not check a real absent process.

D8: register and unregister send the full snapshot inside the management chain without a
write deadline. A client that does not read could stall later register calls. This needs
about twenty repositories with results to exceed the 8192-byte socket buffers.

D9: one routing chain resolves the paths for all repositories, so a stalled volume can
delay every submission. `pruneRuns` does not remove `.write-*`, `.copy-*`, or `.latest-*`
files from an interrupted write. Unregister reports "busy" while a finished client keeps
its connection open.

## Areas found sound

Both reviews found these areas sound: bounded waits in every poll loop, timer and listener
cleanup, Result boundaries, abort reason mapping, and journal and lock containment. They
also found these areas sound: IPC frame limits, exact protocol validation, cancel
ownership, FIFO order, socket permissions, and bounded output draining.
