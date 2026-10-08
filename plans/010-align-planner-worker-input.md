# Plan 010: Align planner and worker input

## Authority and baseline

The user authorized the complete hardening and pruning list. This unit covers H4, planner
and worker input contracts. The baseline is local `main` at `a4a7763`.

`planWorkflow` returns unselected job keys in `otherJobs`. The worker rejects empty or
NUL-containing names. The planner accepts those keys because unselected job semantics
remain outside execution validation. The daemon can therefore reject an accepted plan.

## Contract and design

Treat `otherJobs` as display metadata. Require an array of strings in worker input,
without execution constraints on those strings. Retain strict validation of selected jobs,
steps, environment values, and transport shape. Preserve the CLI's unselected job display.

Do not validate unselected job definitions. Do not change protocol versions or remove Plan
fields. No new capability or dependency is required.

## Scope and ownership

The worker owns `src/worker.ts`, `tests/worker_test.ts`, `tests/workflow_test.ts`,
`tests/cli_test.ts`, and `tests/daemon_test.ts`. The main agent owns this plan, the index,
backlog, design documentation, verification record, review, authoritative checks, and
commit. Other agents share the checkout. Preserve their edits.

## Ordered execution and validation

1. Add a public worker regression for an accepted plan with an empty unselected name.
2. Run that regression before changing validation. Record the failure.
3. Change only display metadata validation. Add an escaped NUL name regression.
4. Compare planning, standalone execution, worker execution, and daemon execution for the
   same workflow. Preserve CLI display and malformed transport rejection.
5. Run focused checks. Measure each new test below one second.
6. Review every changed line. Run the local pre-commit gate and commit this unit alone.

Use disposable files and public APIs. Worker self-checks cover focused tests, formatting,
lint, and types. The main agent runs authoritative focused checks and the full gate.

## Completion and stop conditions

Accepted selected jobs execute through direct and daemon routes with either metadata key.
The worker still rejects invalid executable data and non-string metadata. Existing tests
pass. Update the index and backlog before one local commit. Never push.

Report unexpected contract mismatches or required scope changes before editing another
module. Request a decision before a script exceeds two minutes.
