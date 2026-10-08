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

| Finding | Change                                                                 | Acceptance evidence                                                                | Status |
| ------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| 1       | Replace reader counts and the `Owner` wrapper with single-owner state. | Connected logs, disconnect, cancellation, failed acceptance, retention failure.    | Done   |
| 2       | Share repository state loading.                                        | Startup and registration, busy locks, latest results, first-error precedence.      | Done   |
| 3       | Recover workspaces without fresh run allocation.                       | Recovery, exclusion, journal retention, no fresh run state, lock release.          | Done   |
| 4       | Share CLI workflow preparation.                                        | Exit codes, diagnostics, receipts, validation order, parent and signal behavior.   | Done   |
| 5       | Share complete-write handling.                                         | Short writes, zero writes, exceptions, exact diagnostics, file and socket callers. | Done   |
| 6       | Share hook preflight rules without stale snapshots.                    | Concurrent edits, permissions, recursion, worktrees, cancellation, rollback.       | Done   |

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

Finding 1 committed as `84952f9` after 453 Deno tests and 339 native checks passed.
Finding 2 passed 34 focused loading tests. Its diff adds 25 production lines and removes
31. `daemon.ts` decreased from 1301 to 1295 lines. No tests changed.

Finding 2 committed as `532d79c` after 453 Deno tests and 339 native checks passed.
Finding 3's public characterization failed before the code change: idle recovery attempted
temporary allocation in a directory without write permission. The test also checks
repeated recovery and the permanent lock inode.

Finding 3 passed 27 workspace, runner, and worker tests. Its diff adds 40 production lines
and removes 17. `workspace.ts` increased from 257 to 280 lines. The explicit lock boundary
removes recovery allocation and preserves cleanup ownership. Two public tests were added;
the invalid-journal test now also checks the recovery API.

Finding 3 committed as `fff2d10` after 455 Deno tests and 339 native checks passed.
Finding 4 passed 29 CLI tests, with one opposite-platform test ignored. Its diff adds 61
production lines and removes 63. `cli.ts` decreased from 527 to 525 lines. Two public
tests characterize command-specific read precedence and Bash failure receipts.

Finding 4 committed as `ad372bf` after 457 Deno tests and 339 native checks passed.
Finding 5 passed 91 IPC, worker, client, daemon, and race tests. Three IPC checks also
passed against the previous source in an isolated temporary directory. Two new helper
tests cover empty input and exact failure diagnostics. No existing test was removed.

Finding 5 adds 28 production lines and removes 45. `daemon.ts` now has 1286 lines;
`ipc.ts` has 78, `worker.ts` has 184, and `client.ts` has 221. The shared writer retains
framing, budgets, caller diagnostics, and caller synchronization.

Finding 5 committed as `f62cebf` after 460 Deno tests and 339 native checks passed.
Finding 6's two characterization tests passed before production changes. Setup root
failure stops before configuration or Homebrew reads. Installation preserves unsafe
shared-worktree diagnostics before a deferred root mismatch.

Finding 6 passed 152 hook and CLI tests, with one opposite-platform test ignored. Four
shared functions now own configuration, root inspection, workflow planning, and packaged
hook validation. Setup and installation keep their different root and read diagnostics.
Installation still rechecks resources after setup mutations.

Finding 6 adds 183 production lines and removes 150. `hooks.ts` increased from 1587 to
1620 lines. Explicit types preserve the distinct policies while eliminating duplicate rule
owners. Review removed an unnecessary helper around the existing file-check API. Two
public characterization tests add 60 lines. No existing test was removed.

Current: commit finding 6, then reconcile final documentation. The main agent owns review,
verification, integration, and commits. The user owns repository backups.
