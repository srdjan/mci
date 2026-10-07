# Implementation plans

The user selected plans for all six audit findings on 2026-10-06. These plans use local
`main` at `7b74afa` as their source baseline. The active goal now authorizes
implementation.

The earlier [hardening and pruning list](hardening-pruning-list.md) records completed
work. This index records the new selected work without reopening those completed units.

## Execution order and status

Plan numbers show the recommended execution order. Audit finding numbers preserve the six
priorities shown to the user. Effort describes scope, rather than elapsed time. Status is
`TODO` until execution starts, then `IN PROGRESS`, `DONE`, or `BLOCKED` with a reason.

| Plan                                            | Audit finding | Outcome                                             | Priority | Effort | Depends on                                        | Status |
| ----------------------------------------------- | ------------- | --------------------------------------------------- | -------- | ------ | ------------------------------------------------- | ------ |
| [001](001-preserve-recorded-results.md)         | 1             | Preserve recorded results after projection failure. | High     | Medium | None                                              | DONE   |
| [002](002-check-startup-rollback-ownership.md)  | 2             | Check ownership before startup rollback signals.    | High     | Medium | None                                              | TODO   |
| [003](003-resolve-receipt-path-components.md)   | 3             | Match receipt identity to filesystem path order.    | High     | Medium | None                                              | TODO   |
| [004](004-parse-deno-task-options.md)           | 6             | Parse option values before Deno task names.         | Medium   | Medium | None                                              | DONE   |
| [005](005-check-existing-workflow-recursion.md) | 4             | Inspect defined dependencies in existing workflows. | High     | Medium | 004: task option parsing                          | TODO   |
| [006](006-finish-hook-rollback-before-exit.md)  | 5             | Finish hook rollback before cancellation completes. | Medium   | Large  | 004: task option parsing; 005: workflow recursion | TODO   |

Plans 001, 002, and 003 have independent implementation boundaries. Plans 004, 005, and
006 share `src/hooks.ts` and its tests. Execute the three hook plans sequentially.

Each executor must read the complete selected plan and compare source drift before
editing. Each completed fix needs its own local commit on `main`. The maintainer owns
pushes and repository backups. The active goal authorizes all six fixes.

## Objective and accepted direction

The current objective is implementation of all six saved plans. The main agent owns
integration, documentation, verification, and local commits. Workers own disjoint source
and test files. Hook plans follow their dependency order.

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

Cancellation during repository mutation remains source-confirmed and needs reproduction in
Plan 006. No measured PID-reuse rate, rollback duration, queue capacity, or log capacity
exists in this planning evidence.

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

Plan 004, task option parsing, is committed locally as `0640c15`. Its pre-commit gate
passed 348 Deno tests and 307 native checks.

Completed: the user selected all six findings, and the main agent reconstructed their
callers, compatibility rules, and test seams. The main agent wrote and reviewed the six
plans. The plans preserve that accepted scope.

Current: source changes for result preservation, startup ownership, receipt paths, and
task option parsing pass the complete gate. The checkout started clean at `0330b74`.

The main agent reviewed each changed line and corrected two gaps. Projection failure now
preserves the recorded terminal in memory. Unknown child status now preserves recovery
evidence without signaling. The gate passed 348 Deno tests and 307 native checks.

The simplification pass removed repeated stable identity comparisons and repeated task
scanning. The main agent kept cleanup state and status observation explicit. Fixture
consolidation did not justify changing existing tests.

Next: the main agent reviews each change, runs checks, and commits each complete fix.
Existing workflow validation and cooperative cancellation follow task option parsing.

No user decision remains necessary to start implementation. A stop condition during
execution must name the failed assumption and the additional scope needed.
