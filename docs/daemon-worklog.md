# Shared daemon worklog

## Objective

Provide one local daemon for one user and multiple repositories. Install the CLI, service,
and native monitor through a local Homebrew tap.

Each repository uses a FIFO queue. Different repositories can run at the same time.

The native monitor observes status and manages registration. It never starts or cancels
CI.

## Completed work

The version 1 protocol defines strict requests, responses, snapshots, and terminal
records. IPC uses newline-delimited JSON with strict UTF-8 and a four MiB frame limit.

The daemon owns registration, per-repository queues, worker processes, snapshots, and
request journals. A client connection owns only its submitted request.

Client cancellation or disconnection cancels that request. Other clients and repositories
continue independently.

Daemon startup marks unfinished journal entries as INTERRUPTED. The daemon does not retry
unfinished work.

Snapshots keep the latest completed result during active and queued work. Retention keeps
the latest spool and every spool held by a connected client.

The monitor reads daemon status and uses the saved snapshot during daemon outages. It can
register or unregister repositories and open saved logs.

The package task builds the CLI, native app, archive, checksum, and local formula. The
formula defines the daemon as a Homebrew service.

`mci setup` installs the packaged monitor and starts the service when necessary. The
`mci hooks install` command adds a stable Deno task and managed pre-commit hook.

The local YAML calls Deno tasks directly. The pre-commit hook remains the only automatic
CI trigger.

## Evidence

Final `deno task verify` passes formatting, linting, type checking, 155 Deno tests, and
309 native checks. One opposite-platform test is ignored.

Layer and suppression checks also pass. Regression tests cover slow submission setup,
registration races, durable completion, failed retention, and socket disconnection.

The final archive installs through the local Homebrew tap. `brew test local/meeci/mci`
passes. The service restarts, and setup also starts a stopped service. Repeated setup
opens the signed monitor.

Two repositories pass concurrent tasks through the compiled daemon. The native socket
client reads both repositories. A failing installed hook blocks a commit; a passing hook
permits a commit.

## Accepted review fixes

Registration and unregistration use serialized mutations. Submission routing and
preparation preserve FIFO order during delayed filesystem operations.

Each completed request saves a durable terminal record before result projection. Startup
preserves completed work when journal cleanup fails.

Retention keeps recovery files for pending journal entries. Retention failures block
commands until the daemon can restore consistent storage.

The packaged hook uses an absolute Homebrew path. Installation scopes Git configuration to
the current worktree and rejects unsafe shared settings.

Setup commands drain both output streams and use bounded waits. Setup restores the
previous app after service, readiness, or launch failures.

Rollback stops only services that setup created. Homebrew service state identifies
pre-existing services before startup.

Hook tests isolate temporary Git repositories from inherited `GIT_*` values. The same
tests pass when the caller supplies this checkout's index path.

## Review follow-up

The daemon module combines queues, workers, recovery, and retention. A later refactor can
separate these responsibilities after behavior remains stable. This refactor is outside
the accepted outcome.

Git can copy hook configuration into a future worktree without copying its Deno task. The
inherited hook then blocks commits. Hook installation remains an explicit step for each
worktree.

A native probe covers the socket deadline. The client rejected an accepted socket that
sent no response after 1002.8 ms. This probe remains under gitignored `demos/`.

## Remaining evidence limits

The current app still needs a visual and VoiceOver check. The user owns these interface
checks and confirmation after the next login.

Current Intel, minimum macOS version, and Linux execution evidence remain unavailable.
These limits do not change the Apple Silicon host scope.

The completed `ce-code-review` receipt reports no actionable findings. All accepted
requirements and implementation units are met.

The review run is `20261003-144227-21a7cff4`. Eight Sol reviewers covered correctness,
reliability, Swift, security, project standards, maintenance, testing, and adversarial
analysis.

The Sol-only model constraint prevented a separate model review. The adversarial Sol
review supplied the independent challenge.

The two maintenance notes appear under Review follow-up. Manual interface and next-login
checks remain with the user. No push is authorized.
