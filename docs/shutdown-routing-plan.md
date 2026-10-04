# Shutdown during path resolution

## Objective and scope

This unit addresses H2 (bound shutdown during stalled path resolution) in
`plans/hardening-pruning-list.md`. Shutdown must release the socket and service lock
without waiting for a submission path resolver.

The unit changes `src/daemon.ts` and `tests/daemon_test.ts`. The main agent updates
`docs/design.md` and `VERIFICATION.md`. Other backlog items remain separate units.

## Approach

The daemon runtime owns a controller for shutdown cancellation. Shutdown signals the
controller immediately after it marks the runtime closed.

Each submission races path resolution against shutdown cancellation. The submission
removes its abort listener when either branch finishes. The existing Result type carries
the shutdown error. No timer or timeout policy is added.

Routing checks the closed flag before starting resolution and after the race. These checks
prevent queued routing callbacks or late resolution from accepting work.

The filesystem resolver can remain pending. Its later result must not allocate a spool,
change a request journal, start a worker, or publish state after shutdown.

The change preserves request order for each path and concurrency across repositories.
Ordinary acceptance, worker cancellation, and result delivery keep their current paths.

## Verification

The worker adds the regression before changing production code. A registered repository
receives a submission whose resolver waits on a controlled promise.

The test confirms resolver entry before shutdown. Shutdown must finish within a short test
observation window while that resolver remains pending. Client EOF, socket removal, and
successor startup establish release of the service resources.

The test releases the old resolver after shutdown. No forbidden command may run, and no
request spool or journal entry may appear. A later daemon startup must retain the
registered repository without a new terminal result.

The test releases all gates before cleanup, including when the old code fails. The focused
regression must fail for stalled shutdown before the production change.

Existing tests retain path ordering, concurrency across repositories, shutdown of active
workers, restart behavior, and acceptance failure handling.

## Completion and ownership

The worker owns implementation and focused checks through `ce-work` in return-to-caller
mode. The main agent owns the final review, integrated verification, documentation,
staging, and local commit on `main`.

Completion requires the regression and relevant existing checks to pass. The local Git
hook runs the full verification before the commit. No commit is pushed, and no installed
binary is replaced.
