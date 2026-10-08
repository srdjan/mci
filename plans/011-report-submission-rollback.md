# Plan 011: Report submission rollback failures

## Authority and evidence

The user authorized the complete backlog. This unit covers H5, submission rollback
failures. The baseline is local `main` at `72c96e4`.

`prepareSubmission` discards journal and request removal results after journal acceptance,
shutdown, and snapshot acceptance failure. Cleanup faults therefore disappear from the
response. The queue also contains an unaccepted request during snapshot publication. An
active completion can pump that request before publication returns failure.

## Contract and design

Preserve the primary rejection and every attempted cleanup failure. Always finish the
journal before removing request files, including ambiguous acceptance failure. If journal
cleanup fails, retain request files for recovery. If either cleanup fails, block further
work for that repository. Preserve existing blocks and recorded workflow results.

Expose cleanup failures in the rejection response and daemon diagnostics. Shutdown can
close the connection first, so diagnostics must also reach the daemon log. Add a narrow
`reportDiagnostic` capability to `startDaemon`, with stderr as the native default. Include
request identity and operation context. Do not print workflow or environment contents.

Publish the candidate queue count without placing unaccepted work in the executable queue.
After publication succeeds, append the job and retain existing accepted-frame cancellation
behavior. Preserve FIFO, unregister exclusion, and cross-repository concurrency.

Do not add retries, protocol fields, dependencies, or remote checks. Cleanup success
allows later work. Restart uses existing journal recovery and retention rules.

## Scope and ownership

The worker owns `src/daemon.ts` and `tests/daemon_race_test.ts`. The main agent owns this
plan, index, backlog, design documentation, verification record, review, checks, and
commit. Other agents share the checkout. Preserve their edits. Work on local `main`; never
push.

## Ordered execution

1. Add a public socket regression for acceptance failure plus request removal failure.
2. Observe the missing cleanup diagnostic before changing source.
3. Add one rollback helper with ordered journal cleanup and conditional request removal.
4. Use the helper in acceptance, shutdown, and snapshot rejection paths.
5. Keep unaccepted work outside the queue until its snapshot succeeds.
6. Inject journal cleanup failure, request removal failure, and both primary rejection
   routes. Confirm retained recovery files, repository blocking, and no rejected
   execution.
7. Exercise shutdown during acceptance with a controlled capability gate. Capture
   diagnostics.
8. Exercise an active completion while candidate publication waits and then fails.
9. Review every changed line. Run focused tests and the configured local gate.

## Validation and completion

Use public daemon APIs, disposable files, and native store wrappers. Do not patch global
filesystem methods. Each new test must finish below one second. Worker checks cover new
focused tests, types, lint, and formatting. The main agent owns authoritative focused
tests and the complete gate. No scripts may exceed two minutes without a decision.

Completion requires primary and cleanup diagnostics, preserved recovery evidence, blocked
admission after cleanup faults, no rejected execution, FIFO compatibility, and one local
commit. Update the index and backlog before commit.

Report required edits outside scope or a recovery policy conflict before expanding source.
Report a correction that fails twice. Do not repeat a full suite that the main agent owns.
