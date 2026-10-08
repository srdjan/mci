# Plan 015: Prune recovered control files

## Authority and baseline

The user authorized the complete backlog. This unit covers P1, obsolete worker control
files. The baseline is local `main` at `75d673e`. Latest request identifiers currently
preserve control files after successful recovery.

## Contract and design

Startup retains logs and terminal records for pending requests and the latest result.
Startup retains control files only for pending journal entries. Failed recovery must
retain its control evidence. Successful recovery removes obsolete controls, including
controls left after normal deletion fails. Repeated restart must retain this behavior.

Add a required pending-control list to the store's pruning capability. Compute pending
identifiers separately from the latest result. Preserve existing regular-file checks,
temporary cleanup, retention errors, connected-reader handling, and workflow results.
Change no protocol, dependency, automatic trigger, or live cleanup policy.

## Ownership and execution

The main agent owns source, documentation, review, checks, and commit. The test worker
owns additions to `tests/daemon_race_test.ts`. Agents share the checkout and preserve
other edits. Work directly on local `main`; never push.

First reproduce retention of a recovered latest control through the public daemon. Then
correct pruning. Check recorded completion, interruption, failed normal deletion, pending
recovery failure, and repeated restart. Existing connected-reader tests establish live
retention. Every new test must finish below one second. The main agent reviews every
changed line and runs focused checks and the complete local gate.

## Completion and limits

Record the observed regression and final evidence. Commit this isolated unit locally.
Filesystem checks establish the tested host only. Power-loss durability remains outside
this evidence. The main agent owns the next unit, unused declarations.
