# Implementation plans

The user selected plans for all six audit findings on 2026-10-06. These plans use local
`main` at `7b74afa` as their source baseline. Implementation is complete for all six
plans. The individual plan files preserve their original instructions. This index records
completion.

The refreshed [hardening and pruning list](hardening-pruning-list.md) records proposed
work from the 2026-10-08 review. This index preserves completion of the six selected
plans.

The user selected option 1, exact monitor shutdown, for planning on 2026-10-08.
[Plan 007](007-exact-monitor-shutdown.md) records that selected work at baseline
`11e034b`. The user authorized execution on 2026-10-08. Implementation and local checks
are complete.

The user authorized the complete hardening and pruning list on 2026-10-08. Each unit
requires separate validation and a local commit.
[Plan 008](008-preserve-configuration-permissions.md) starts the remaining work with H2,
existing file permissions.

## Execution order and status

Plan numbers show the recommended execution order. Audit finding numbers preserve the six
priorities shown to the user. Effort describes scope, rather than elapsed time. Status is
`TODO` until execution starts, then `IN PROGRESS`, `DONE`, or `BLOCKED` with a reason.

| Plan                                             | Audit finding                 | Outcome                                             | Priority | Effort | Depends on                                        | Status |
| ------------------------------------------------ | ----------------------------- | --------------------------------------------------- | -------- | ------ | ------------------------------------------------- | ------ |
| [001](001-preserve-recorded-results.md)          | 1                             | Preserve recorded results after projection failure. | High     | Medium | None                                              | DONE   |
| [002](002-check-startup-rollback-ownership.md)   | 2                             | Check ownership before startup rollback signals.    | High     | Medium | None                                              | DONE   |
| [003](003-resolve-receipt-path-components.md)    | 3                             | Match receipt identity to filesystem path order.    | High     | Medium | None                                              | DONE   |
| [004](004-parse-deno-task-options.md)            | 6                             | Parse option values before Deno task names.         | Medium   | Medium | None                                              | DONE   |
| [005](005-check-existing-workflow-recursion.md)  | 4                             | Inspect defined dependencies in existing workflows. | High     | Medium | 004: task option parsing                          | DONE   |
| [006](006-finish-hook-rollback-before-exit.md)   | 5                             | Finish hook rollback before cancellation completes. | Medium   | Large  | 004: task option parsing; 005: workflow recursion | DONE   |
| [007](007-exact-monitor-shutdown.md)             | H1: exact monitor shutdown    | Confirm monitor exit before bundle mutation.        | High     | Medium | None                                              | DONE   |
| [008](008-preserve-configuration-permissions.md) | H2: existing file permissions | Retain file modes through replacement and rollback. | High     | Small  | None                                              | DONE   |
| [009](009-detect-concurrent-codex-edits.md)      | H3: concurrent Codex edits    | Refuse changed input before replacement.            | High     | Medium | 008: file permissions                             | DONE   |

| [010](010-align-planner-worker-input.md) | H4: planner and worker input | Execute
accepted plans with display metadata. | Medium | Small | None | DONE |

| [011](011-report-submission-rollback.md) | H5: submission rollback | Preserve rejection
and cleanup diagnostics. | High | Medium | None | DONE |

| [012](012-report-final-snapshot-failures.md) | H6: final snapshot diagnostics | Report
fallback publication faults without changing results. | Medium | Small | 011: diagnostic
capability | DONE |

Plans 001, 002, and 003 have independent implementation boundaries. Plans 004, 005, and
006 share `src/hooks.ts` and its tests. Execute the three hook plans sequentially.

Each executor must read the complete selected plan and compare source drift before
editing. Each completed fix needs its own local commit on `main`. The maintainer owns
pushes and repository backups. The user authorized all six fixes.

## Objective and accepted direction

The completed objective covers all six saved plans. The main agent owns integration,
documentation, verification, and local commits. Workers own disjoint source and test
files. Hook plans follow their dependency order.

The current objective covers the complete hardening and pruning list, one unit at a time.
The main agent owns planning, integration, review, checks, documentation, and local
commits. Workers own each unit's scoped source and tests. Plan 007, exact monitor
shutdown, is complete. Its capability interfaces, command budgets, and forced SIGTERM
remain accepted boundaries. Normal application Quit retains its cleanup contract.

Task parsing precedes workflow recursion because both checks need one invocation scanner.
Existing workflows continue to accept undefined optional tasks. Foreign configurations
remain trusted commands outside root task inspection.

Cancellation follows the parser and recursion changes. The CLI owns its forward deadline
and finishes restoration before exit. The monitor waits for that exit instead of forcing
termination during mutation. Cleanup has no newly estimated whole-operation deadline.

Inspection revised three effort judgments from the audit. Task parsing and
existing-workflow validation need medium effort because execution context and
compatibility require checks. Cancellation needs large effort because normal application
Quit must drain installation.

## Evidence and validation limits

The preceding audit passed formatting, linting, and type checks. Its complete test run
passed 304 Deno tests, ignored one platform test, and passed 307 native checks. These
counts describe the audit baseline, not future implementation results.

Public probes confirmed the store overwrite sequence, unchecked startup signaling,
incorrect receipt identity, accepted recursive setup, and rejected valid task options. The
startup probe used capability doubles and signaled no real process. The store probe called
the public store in the same order as daemon completion.

Plan 006 checked cancellation through controlled repository and native process fixtures.
No measured production rollback duration, queue capacity, or log capacity exists in this
planning evidence.

## Deferred and rejected areas

Trusted workflow commands, inherited credentials, detached descendants, and advisory locks
remain documented product boundaries. File size alone does not justify splitting the
daemon. Queue and log limits require measurement before a plan selects numerical bounds.

Final snapshot failures remain a separate diagnostic question. They do not justify
replacing a recorded workflow result. Snapshot durability changes are outside these plans.

Packaged monitor startup confirmation and visual or VoiceOver validation remain separate
direction options. The user selected the six defects, rather than those options. Receipt
migration and forced installer termination are explicit deferred boundaries.

## Worklog and ownership

Plan 008, existing file permissions, is committed as `2278de8`. Its gate passed 413 Deno
tests and 339 native checks. Plan 009, concurrent Codex edits, is committed as `a4a7763`.
Its gate passed 420 Deno tests and 339 native checks. Plan 010, planner and worker input,
is committed as `72c96e4`. Its gate passed 425 Deno tests and 339 native checks. Each gate
ignored one opposite-platform test. Plan 011, submission rollback diagnostics, is in
progress.

The concurrency guard compares captured bytes and identity before replacement. Separate
inspection and rename retain a concurrency gap. Unselected job names remain display
metadata.

The active objective covers all eight hardening items and all three pruning items. H1,
exact monitor shutdown, is complete at `c5fb75d`. H2, existing file permissions, is
complete. The main agent owns planning, review, validation, status, and local commits.
Workers own only each unit's assigned source and test files.

Plan 011, submission rollback diagnostics, is committed as `3d1f46c`. Its gate passed 431
Deno tests and 339 native checks, with one opposite-platform test ignored. Cleanup faults
block further repository work. Failed journal cleanup retains request files. Plan 012,
final snapshot diagnostics, passes both public fault regressions. Snapshot faults retain
workflow results and do not add a repository block.

Remaining order: Homebrew location, doctor status, recovery files, and unused
declarations. Homebrew consolidation completes the remaining part of P3, shared native
primitives. Existing process consolidation remains complete.

The maintainer authorized all numbered items. Capacity measurement remains an unselected
direction option. Existing platform, visual, and power-loss evidence limits remain
explicit. The main agent will reconcile hook documentation after the numbered units.

Plan 005, existing workflow validation, is committed locally as `a110a3b`.

The user reverted the earlier Plan 006 continuation in `4a3b433`. The user then approved
Plan 006 again. The current execution uses existing Deno and Swift code, without Bend. The
main agent owns integration, final checks, documentation, and the local commit.

The Plan 006 implementation commit directly follows `4a3b433` on local `main`. Its subject
is `fix(hooks): cancel cooperatively and drain monitor installations`.

Plan 003, receipt path resolution, is committed locally as `4deb5b2`. Its pre-commit gate
passed 348 Deno tests and 307 native checks. The checkout was clean after that commit.

Plan 002, startup ownership, is committed locally as `96b7758`. Its pre-commit gate passed
348 Deno tests and 307 native checks.

Plan 001, result preservation, is committed locally as `ff618a8`. Its pre-commit gate
passed 348 Deno tests and 307 native checks.

Plan 004, task option parsing, is committed locally as `0640c15`. Its pre-commit gate
passed 348 Deno tests and 307 native checks.

Completed: the user selected all six findings, and the main agent reconstructed their
callers, compatibility rules, and test seams. The main agent wrote and reviewed the six
plans. The plans preserve that accepted scope.

Completed: result preservation, startup ownership, receipt paths, and task option parsing
are committed locally. The checkout started clean at `0330b74`.

The main agent reviewed each changed line and corrected two gaps. Projection failure now
preserves the recorded terminal in memory. Unknown child status now preserves recovery
evidence without signaling. The gate passed 348 Deno tests and 307 native checks.

The simplification pass removed repeated stable identity comparisons and repeated task
scanning. The main agent kept cleanup state and status observation explicit. Fixture
consolidation did not justify changing existing tests.

Completed: existing workflow validation passes 117 focused tests and the complete gate.
The gate passed 372 Deno tests and 307 native checks, with one platform test ignored. The
main agent reviewed the changed lines and corrected root directory and option coverage.

Completed: Plan 006 finishes active bounded helpers and restoration before cancellation
returns. The monitor retains installations and diagnostics while cleanup finishes. Normal
Quit waits for installation completion. Rapid re-registration preserves automatic setup.

The main agent reviewed every changed line and corrected all four confirmed review
findings. The final gate passed 395 Deno tests and 339 native checks, with one platform
test ignored. Public model probes and an AppKit process checked normal termination.

Completed: Plan 007 records exact monitor shutdown and guarded packaged rollback. The
focused baseline passed 67 tests in 324 ms. The source drift check passed at `aee089f`.

Completed: Plan 007 shares exact monitor matching and confirmed shutdown. Packaged
rollback retains recovery bundles after uncertain shutdown. The main agent reviewed each
changed line and corrected the disposable fixture signature and cleanup sequence.

The focused run passed 78 tests in 423 ms. Complete validation passed 410 Deno tests and
339 native checks, with one platform test ignored. The native fixture passed in 60 ms.
Source capability signatures, command budgets, and forced SIGTERM remain accepted
boundaries.

Completed: Plan 008 preserves configuration permissions. The focused suites passed 134
tests. Type, lint, layer, and suppression checks pass. The review found no defects.

Next: the main agent owns H7, absolute Homebrew location. The maintainer owns repository
backups.
