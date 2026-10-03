# CI output drain plan

## Problem

`runLoggedCi` in `src/ci.ts` waits for stdout and stderr to close without a deadline. A
step can start a process that leaves its process group, for example through `setsid`. That
process keeps the pipe open after the CLI child exits. The adapter then stays in the
running state, holds the CI lock, and blocks the commit until the holder exits.

A reproduction used a step that ran
`perl -e 'use POSIX; exit if fork; POSIX::setsid(); sleep 6'`. The CLI child finished in
0.03 s. The adapter returned after 6 s. A SIGINT at 2 s did not stop the adapter, because
`cancel` returns early after the child settles. The final status recorded pass.

## Measurement

A probe spawned `/bin/sh` with piped output and drained both streams into a file and
`/dev/null`. Over 80 runs, 40 of which wrote a 4.4 MB burst, both streams reached EOF no
later than 0.09 ms after the child status resolved. The child cannot exit before the
reader takes all but one pipe buffer of data. A second probe held the pipe with a detached
process. `reader.cancel()` 100 ms after child exit ended the drain at 110 ms. The Deno
process then exited without waiting for the holder.

The output grace period is therefore 2000 ms. That value matches the process grace in
`src/process.ts` and exceeds the measured normal delay by more than four orders of
magnitude.

## Behavior

After the child status resolves, the adapter waits at most the output grace period for
both streams to close. A stream that remains open is cut: the adapter cancels its reader,
which closes the read end of the pipe. The adapter records the diagnostic
`<stream> stayed open <ms> ms after the command exited; a detached process probably holds it`.
A diagnostic converts a zero child exit to exit 1 and state fail. A nonzero child exit
keeps its code.

Cancellation through the abort signal after the child settles cuts open streams
immediately. The adapter marks the run cancelled, so a zero child exit becomes 130 for
SIGINT or 143 for SIGTERM. Each cut stream records
`<stream> closed by cancellation after the command exited`. Cancellation before the child
settles keeps the current behavior: the adapter signals the child, and the grace period
starts when the child exits.

A cut does not interrupt a sink write in progress. The drain returns after that write
resolves. A blocked terminal therefore remains outside this bound.

The adapter never signals the detached holder. The holder is outside the process group and
outside the runner's cleanup scope. It receives EPIPE or SIGPIPE on its next write.

## Changes

`src/ci.ts`:

- Add `readonly outputGraceMs?: number` to `RunLoggedCiOptions`. The default constant is
  `outputGraceMs = 2000`.
- Give `drain` a cut signal. On abort, it cancels its reader through `attempt` and returns
  whether the stream was cut. Store the cancel promise in an object field, not a narrowed
  `let`, and await it in `finally`. Remove the listener in `finally`.
- In the `statusPromise` callback, set `settled` and start the grace timer together, so no
  abort can land between them. The timer calls `cut.abort("grace")`.
- Clear the timer after `await Promise.all([statusPromise, drain, drain])`. Both streams
  usually reach EOF before the status resolves, so a clear tied to drain completion would
  run before the timer starts.
- In `cancel`, set `cancelled` and return when it is already set. When the child has
  settled, call `cut.abort("cancel")` instead of signaling the child.
- After the drains return, choose each cut stream's diagnostic from `cut.signal.reason`,
  not from `cancelled`. A cancellation before settle followed by a grace cut is a grace
  cut. Leave the exit-code and status logic unchanged; it already converts diagnostics and
  cancellation.

`tests/ci_test.ts`, through `runLoggedCi` with
`/bin/sh -c 'echo $$ > child.pid; sleep 5 &
echo $! > holder.pid'`. The background `sleep`
inherits both pipes and holds them after the shell exits. The adapter signals only the
child PID, so the unit tests need no `setsid`; the manual reproduction keeps the Perl
holder for the runner path. Each test kills the holder in `finally`. The holder holds both
streams, so both produce a diagnostic; assertions use `some(...)`.

- Held output: `outputGraceMs: 100`. The run returns in under 1500 ms with code 1, a
  `stdout stayed open` diagnostic, status fail with code 1, and the diagnostic and
  `[mci] exit 1` in the log. A following `runShell(workspace, "true")` returns code 0,
  which shows lock release.
- Cancellation after exit: `outputGraceMs: 10000`. The test waits until the shell PID is
  gone, then waits 100 ms more. On macOS the PID disappears about 2 ms (measured maximum
  2.84 ms) before `child.status` resolves in JavaScript. The test then aborts with SIGINT.
  The run returns in under 2000 ms with code 130, status cancelled with code 130, and a
  `closed by cancellation after the command exited` diagnostic. That diagnostic proves the
  after-settle path. The `finally` block aborts and awaits the run before it kills the
  holder.

Documents: `docs/design.md` (saved CI results section), `README.md` (saved output
paragraph), `VERIFICATION.md` (82 tests instead of 80, fifteen adapter tests instead of
thirteen, and the new coverage).

## Verification

`deno task verify` passes. Both new tests fail against the current `src/ci.ts`: the first
by its elapsed-time or code assertion, the second by elapsed time. The reproduction above
returns within about 2 s with exit 1 and status fail, and SIGINT during the wait returns
130.
