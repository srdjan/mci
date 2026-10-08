# Implementation plans

All six findings from the 2026-10-06 audit are complete. The user then authorized the
complete 2026-10-08 backlog: eight hardening items, three pruning items, and documentation
reconciliation. Each code unit has its own local commit and complete validation.

The [hardening and pruning ledger](hardening-pruning-list.md) records current outcomes and
evidence limits. Individual plans retain their authorized baseline and execution contract.
This index owns current status and the compact worklog.

## Execution status

All listed plans are complete. Commit references identify code changes on local `main`.
The documentation unit uses its own local commit after the configured gate passes.

| Plan                                             | Scope                                                         | Status | Local commit             |
| ------------------------------------------------ | ------------------------------------------------------------- | ------ | ------------------------ |
| [001](001-preserve-recorded-results.md)          | Preserve recorded results after projection failure.           | DONE   | `ff618a8`                |
| [002](002-check-startup-rollback-ownership.md)   | Check ownership before startup rollback signals.              | DONE   | `96b7758`                |
| [003](003-resolve-receipt-path-components.md)    | Resolve receipt paths in filesystem order.                    | DONE   | `4deb5b2`                |
| [004](004-parse-deno-task-options.md)            | Parse Deno task options before task names.                    | DONE   | `0640c15`                |
| [005](005-check-existing-workflow-recursion.md)  | Reject defined recursion in existing workflows.               | DONE   | `a110a3b`                |
| [006](006-finish-hook-rollback-before-exit.md)   | Finish cancellation cleanup and drain monitor installations.  | DONE   | `2d932dd`                |
| [007](007-exact-monitor-shutdown.md)             | H1: confirm exact monitor shutdown.                           | DONE   | `c5fb75d`                |
| [008](008-preserve-configuration-permissions.md) | H2: preserve existing configuration permissions.              | DONE   | `2278de8`                |
| [009](009-detect-concurrent-codex-edits.md)      | H3: detect concurrent Codex edits.                            | DONE   | `a4a7763`                |
| [010](010-align-planner-worker-input.md)         | H4: align planner and worker input.                           | DONE   | `72c96e4`                |
| [011](011-report-submission-rollback.md)         | H5: report submission rollback failures.                      | DONE   | `3d1f46c`                |
| [012](012-report-final-snapshot-failures.md)     | H6: report final snapshot failures.                           | DONE   | `81b3368`                |
| [013](013-share-homebrew-location.md)            | H7: absolute Homebrew location; P3: shared native primitives. | DONE   | `0005b90`                |
| [014](014-return-doctor-health-status.md)        | H8: return doctor health status.                              | DONE   | `75d673e`                |
| [015](015-prune-recovered-control-files.md)      | P1: remove obsolete controls after recovery.                  | DONE   | `731c299`                |
| [016](016-remove-unused-declarations.md)         | P2: remove unused installation error and protocol export.     | DONE   | `8d60d14`                |
| [017](017-reconcile-hook-documentation.md)       | Reconcile source and packaged hook documentation.             | DONE   | This documentation unit. |

P3, shared native primitives, covers monitor control in Plan 007 and Homebrew location in
Plan 013. Plans 004, 005, and 006 shared hook code and ran sequentially.

## Objective and accepted direction

The objective covered the entire backlog, one unit at a time, with validation after each
unit. The main agent owned planning, integration, line review, checks, documentation, and
local commits. Sol workers owned scoped tests or read-only reviews. The user owns pushes
and repository backups. All work used local `main`.

The user reverted the earlier Plan 006 continuation in `4a3b433`, then authorized it
again. Commit `2d932dd` uses the existing Deno and Swift code. It adds no Bend dependency.
Normal monitor Quit waits for cooperative installation cleanup. Forced SIGTERM remains a
separate lifecycle boundary.

The hardening work preserves command budgets and installer transactions. Concurrent
configuration detection retains its inspection-to-rename gap. Unselected job names remain
display metadata. Rollback cleanup failures block repository work. Failed journal cleanup
retains recovery files. Snapshot publication failures preserve workflow results.

Startup keeps control files only for pending journal entries. Completed results retain
their terminal record and log. The unused installation error is removed; the private
inspection error `CommandError.outputLimitExceeded` remains reachable.

## Evidence and limits

The final code gate at `8d60d14` passed formatting, lint, types, 453 Deno tests, and 339
native checks. One opposite-platform test was ignored. Focused regressions failed before
their corrections. The main agent ran authoritative checks and observed each local gate.
[VERIFICATION.md](../VERIFICATION.md) records individual tests, durations, and retained
limits.

The documentation review compares both hook files, Deno tasks, and effective Git
configuration. The source hook calls `deno task ci`; the packaged hook calls
`deno task mci:ci`. Both select the same local workflow and job. This checkout selects the
packaged hook. Git has one effective pre-commit trigger.

Capacity measurement remains an unselected direction option. Visual checks, VoiceOver,
minimum macOS support, Intel execution, login startup, and power-loss durability remain
unconfirmed. Trusted commands, inherited credentials, advisory locks, and process identity
races retain their existing boundaries. No browser session opened during backlog
execution.

## Worklog and ownership

Completed: all eight hardening items, three pruning items, and documentation
reconciliation. The main agent reviewed delegated output and integrated the changes. No
numbered item or required documentation change remains open. Individual plans preserve
execution evidence; this index replaces stale intermediate status.

Next: the repository maintainer owns pushes, backups, and any additional release
acceptance checks. The main agent does not push.
