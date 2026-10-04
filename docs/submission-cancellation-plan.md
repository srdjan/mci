# Submission cancellation plan

## Objective and scope

The client must stop waiting when the daemon gives no acceptance or cancellation reply.
This unit addresses H1 (bound submission cancellation) in
`plans/hardening-pruning-list.md`.

The unit changes `src/client.ts`, adds `tests/client_test.ts`, and updates current
documentation. The unit preserves the daemon protocol and ordinary job deadlines. The unit
does not change daemon shutdown, output capture, or terminal output writes.

## Policies

Acceptance has a 5000 ms deadline after connection. This matches the existing management
client policy. Cancellation has a separate 10000 ms deadline from the first abort. The
cancellation policy permits additional process cleanup time. These values are policies,
not measured capacity or guaranteed filesystem deadlines.

The public `submit` function accepts optional timing policy overrides after its existing
arguments. Existing callers keep their current arguments. Focused tests use shorter
policies and real temporary sockets.

## Behavior

The client installs cancellation handling before it writes the submission. An abort during
a blocked write must eventually close the socket. Cancellation frames must follow the
complete submission frame; concurrent writes must not mix their bytes.

The acceptance timer covers the initial request write and the first acceptance reply.
Acceptance clears that timer. An accepted job has no client deadline for ordinary
execution or queue waiting.

The first abort starts the cancellation timer and clears the acceptance timer. Repeated
aborts cannot extend cancellation. If the request write finishes, the client sends one
cancellation frame. If that write remains blocked, the cancellation timer closes the
socket.

A cancellation timeout closes the socket and returns an error. The error states that
completion is unknown and that the request will not resume automatically. An acceptance
timeout must also disclose uncertainty because the daemon can accept before replying.

A terminal reply clears both timers before log draining. A normal terminal reply remains
the result, including a success that wins a cancellation race. Every return clears timers,
removes the abort listener, closes the socket, and finishes the existing tail.

## Verification

Regression checks start before production edits. A temporary server reads the submission
and cancellation but sends no reply. Cancellation must return within a short test limit.
The current client must fail this check before the fix.

Checks also cover a silent acceptance, cancellation after acceptance, and an initial write
blocked by a server that reads nothing. A large valid frame exercises the blocked write
without exhausting memory.

An accepted request remains pending beyond its acceptance timeout and then returns its
terminal. A server that answers cancellation receives one complete cancellation frame and
can return the confirmed terminal. No test runs a full workflow to check socket timeouts.

The main agent reviews each changed line and runs focused checks. The local pre-commit
hook runs `deno task ci` before the unit commit on `main`. No commit is pushed.

## Completion and remaining work

Completion requires passing socket regression checks and existing CLI and daemon checks.
Current operation documentation must describe the two policies and uncertain completion.
The main agent owns review, verification, and the local commit.

The remaining hardening and pruning units stay in the backlog. Daemon shutdown during
stalled path resolution remains the next recommended unit.
