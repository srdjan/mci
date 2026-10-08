# Minimal design implementation worklog

## Objective and authorization

The user authorized the recommended cleanup on 2026-10-08: "go ahead in order you prefer".
The accepted scope is the six bounded findings in [the audit](minimal-design-audit.md).
Findings 7-8 require compatibility decisions and remain outside this execution. Findings
9-11 remain retained boundaries, as the audit recommends.

I will apply findings 1-6 in numerical order. I will preserve public behavior,
diagnostics, persisted formats, task choices, cancellation, recovery, and rollback. I will
work on local `main` and commit each complete unit. The user owns pushes.

## Plan and status

| Finding | Change                                                                 | Acceptance evidence                                                                | Status  |
| ------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------- |
| 1       | Replace reader counts and the `Owner` wrapper with single-owner state. | Connected logs, disconnect, cancellation, failed acceptance, retention failure.    | Done    |
| 2       | Share repository state loading.                                        | Startup and registration, busy locks, latest results, first-error precedence.      | Pending |
| 3       | Recover workspaces without fresh run allocation.                       | Recovery, exclusion, journal retention, no fresh run state, lock release.          | Pending |
| 4       | Share CLI workflow preparation.                                        | Exit codes, diagnostics, receipts, validation order, parent and signal behavior.   | Pending |
| 5       | Share complete-write handling.                                         | Short writes, zero writes, exceptions, exact diagnostics, file and socket callers. | Pending |
| 6       | Share hook preflight rules without stale snapshots.                    | Concurrent edits, permissions, recursion, worktrees, cancellation, rollback.       | Pending |

Each unit starts with current source and caller checks. I will add a characterization
check when existing public tests do not cover the changed behavior. I will review each
diff and run the focused checks myself. Each commit must pass the configured local gate.

## Baseline and measurement

Baseline commit: `f2ed1b8`. The worktree was clean at execution start. Its local gate
passed formatting, lint, types, 453 Deno tests, and 339 native checks. One
opposite-platform test was ignored. The audit also passed 77 focused Deno tests.

Production line counts will use formatted TypeScript files from the accepted scope.
Baseline files: `daemon.ts` 1314, `workspace.ts` 257, `cli.ts` 527, `ipc.ts` 70,
`worker.ts` 193, `client.ts` 228, and `hooks.ts` 1587. Total: 4176 lines. New shared
production files will count in the final total. Tests and documentation will have separate
counts. Line reduction alone does not establish behavior preservation.

## Decisions and evidence limits

Reader counts have one admission call and exclusive release routes. The count above one is
unreachable under the current protocol. Connected-client retention remains required.

Workspace recovery must hold the same permanent file lock. Recovery can remove obsolete
state, but must preserve uncertain journals and unrelated files.

CLI preparation currently uses different read order for daemon submission and direct
commands. I will preserve that order and each diagnostic context.

Hook setup mutates generated files before installation rechecks resources. I will share
validation code while retaining resource checks at the same transaction boundaries.

No tests will be deleted to improve a metric. No benchmark supports a latency claim.
Public APIs and persisted formats will retain their current contracts.

## Next action and ownership

Finding 1 passed 76 daemon and race tests. Its diff adds 22 production lines and removes
35. `daemon.ts` decreased from 1314 to 1301 lines. No tests changed.

Current: commit finding 1, then share repository state loading. The main agent owns
review, verification, integration, and commits. Read-only delegates can prepare later
findings without changing their source files before the preceding unit passes.
