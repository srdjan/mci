# CI failure communication in Codex

## Objective and accepted direction

When mci CI fails, Codex must show the failure in the session. Codex must direct the agent
to fix the issue before continuing other work. The user accepted this approach on
2026-10-04.

## Constraints

The pre-commit hook remains the only automatic CI trigger. Session hooks read receipts and
never start CI themselves. The monitor and daemon protocol remain unchanged. Work stays on
local main. Each complete unit receives a local commit.

The repository maintainer owns pushes. Workers use gpt-5.6-sol with high effort and do not
commit.

## Receipt contract

The CLI records each valid `ci` or `run` invocation in the current Codex session. The CLI
reads `MCI_SESSION_ID`, then `CODEX_SESSION_ID`, then `CODEX_THREAD_ID`. Invocations
outside a session retain existing behavior and need no session receipt. Receipts live
under the mci service directory, separate from daemon records. Each receipt identifies its
session, workspace, workflow, job, command, and invocation.

Each receipt records its start time and final outcome. The CLI writes a pending receipt
before validation or execution. Validation failures, daemon errors, cancellation, and
unknown completion remain visible. Completed daemon requests include their request
identifier and saved log path. Atomic writes prevent readers from seeing partial JSON.
Receipts contain no inherited environment or transcript content.

## Session adapter

A public `mci codex hook` command reads the Codex event from standard input. The adapter
handles `PostToolUse`, `SessionStart`, `UserPromptSubmit`, and `Stop`. The adapter reads
receipts for an explicit `MCI_SESSION_ID` override or the event's session identifier. An
override must exist before Codex starts so tools and hooks receive the same value. The
adapter ignores inherited Codex identifiers. A runtime probe confirmed that hook processes
retain parent identifiers while tools receive the current session identifiers. Failures
remain pending until a later passing invocation covers the same workspace, workflow, and
job. A success that began before the failure finished cannot clear that failure. The
adapter does not use command matching or a result age limit.

The adapter sends `systemMessage` for the user and `additionalContext` for the agent. The
adapter deduplicates routine warnings by receipt identifier.

A `Stop` event requires repair continuation when unresolved receipts remain. If
`stop_hook_active` is true, the adapter reports the unresolved state without creating
another continuation. This bound lets the agent report a genuine blocker without an
endless loop. Failure state remains pending for the next turn.

## Installation

A public `mci codex install <repository>` command installs the adapter configuration.
Installation preserves foreign hooks and replaces only recognized mci handlers.
Installation replaces the earlier local `ci-summary.sh` handler in this checkout.

Source installation uses the source CLI. Packaged installation uses the stable Homebrew
binary. The installer reports Codex's review and trust requirement. The adapter and
installer ship inside the compiled CLI. No ignored `.codex` implementation becomes a
required package asset.

## Work units

The receipt unit owns `src/ci-receipt.ts`, CLI outcome reporting, and their public tests.
The adapter unit owns the Codex event handler, installer, command routing, and their
public tests. The documentation unit records installation, recovery behavior, and evidence
limits. The root agent reviews every changed line and runs authoritative checks.

## Verification and completion

First, a failing fixture must show the intended test failure before production changes.
Focused checks must complete in less than one minute before the full gate runs. Tests
cover failure, timeout, cancellation, validation errors, and missing daemon results. Tests
cover session isolation, unrelated success, relevant success, and overlapping invocations.
Tests cover warning delivery, model context, bounded continuation, and installer
idempotence.

A disposable Codex session must demonstrate hook delivery for an intentionally failing
job. The root agent runs formatting, linting, type checks, Deno tests, and native monitor
checks. The root agent runs simplification and independent code review before final
delivery. The root agent installs the source adapter in this checkout after checks pass.
Codex hook trust remains an explicit runtime requirement.

## Next action and ownership

The root agent owns implementation, verification, local commits, and the final report. The
user owns trust review in Codex and repository backups.
