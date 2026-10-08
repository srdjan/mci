# Hardening and pruning list

## Scope and result

This review identifies eight hardening items and three pruning items on local `main` at
`c1215f2`, dated 2026-10-08. The user authorized the complete list. All eight hardening
items, all three pruning items, and documentation reconciliation are complete. The review
covers Deno execution, daemon storage, hook installation, service control, packaging, and
the native monitor.

The earlier list had no open items. Its six hardening units and two pruning units remain
complete. The six plans in [README.md](README.md) also remain complete. The labels below
apply to this review; earlier labels retain their meanings in `VERIFICATION.md`.

Effort describes scope, not elapsed time. Small means one boundary with focused checks.
Medium means coordinated changes across boundaries. Risk describes behavior that a change
can break. High confidence means current code establishes the condition and effect.
Runtime checks remain required where the evidence says source inspection only.

## Ordered hardening list

| Item | Category                | Outcome                                               | Impact                                                         | Effort | Risk   | Confidence |
| ---- | ----------------------- | ----------------------------------------------------- | -------------------------------------------------------------- | ------ | ------ | ---------- |
| H1   | Process lifecycle       | Match the exact monitor executable and wait for exit. | Avoid unrelated signals and replacement during shutdown.       | Medium | Medium | High       |
| H2   | Configuration privacy   | Preserve existing file permissions.                   | Avoid widening access during installation or rollback.         | Small  | Low    | High       |
| H3   | Configuration integrity | Detect concurrent Codex configuration edits.          | Avoid losing foreign handlers and settings.                    | Medium | Medium | High       |
| H4   | Validation              | Align planner and worker input contracts.             | Avoid accepting a plan that the worker cannot execute.         | Small  | Low    | High       |
| H5   | Storage recovery        | Report submission rollback failures.                  | Keep cleanup failures and recovery state visible.              | Small  | Medium | High       |
| H6   | Storage diagnostics     | Surface final snapshot publication failures.          | Expose stale fallback state without changing workflow results. | Medium | Medium | High       |
| H7   | Service control         | Resolve Homebrew through supported absolute paths.    | Permit source service shutdown with a restricted PATH.         | Small  | Low    | High       |
| H8   | Diagnostics             | Return failure for failed doctor checks.              | Permit scripts to detect an unhealthy installation.            | Small  | Low    | High       |

### H1: Match the exact monitor executable and wait for exit

The user selected this item and authorized execution on 2026-10-08.
[Plan 007](007-exact-monitor-shutdown.md) records the execution scope. Implementation and
local checks are complete.

The baseline used prefix-only matching and treated signal delivery as packaged shutdown.
Packaged rollback removed the replacement without confirming exit. A public regression
failed on that baseline.

[src/monitor-process.ts](../src/monitor-process.ts) now shares exact path matching and
confirmed shutdown. Both installers retain their command budgets. Packaged rollback
retains the replacement and any backup when shutdown fails. Public checks cover delayed
exit, timeout, command errors, initial replacement, and rollback. The native macOS fixture
confirms SIGTERM exit and sibling survival. The focused run passed 78 tests; complete
validation passed 410 Deno tests and 339 native checks, with one platform test ignored.

SIGTERM remains forced termination and can interrupt hook restoration. Normal Quit retains
its cleanup contract. Argument matching does not authenticate executable identity or make
inspection and signaling atomic. Delayed exit uses a controlled clock; production shutdown
capacity remains unmeasured.

### H2: Preserve existing file permissions

The user authorized this unit with the full list.
[Plan 008](008-preserve-configuration-permissions.md) records the scope. Public
regressions reproduce permission widening in both installers.

The completed fix retains the `07777` mode mask through replacement and restoration. The
baseline widened restrictive modes during Codex installation and Deno task setup. Both
writers now write private temporary files and apply the saved mode before replacement.
Public checks cover `0600`, `0400`, `01600`, repeated installation, rejection, and
rollback. The focused installer suites passed 134 tests. New Codex configuration keeps
`0644`.

Owners, ACLs, extended attributes, and hosts without POSIX modes remain outside this
evidence.

### H3: Detect concurrent Codex configuration edits

[Plan 009](009-detect-concurrent-codex-edits.md) records the completed fix. The public
baseline regression overwrote an injected foreign handler edit. Installation now captures
raw bytes and available identity metadata. The guarded writer refuses changed input before
rename and removes its staged file.

The focused suite passed 20 tests. Checks cover changed bytes, creation, removal,
identity, mode, failed inspection, and symbolic links. Existing merging, permission, and
repeated installation checks pass. The independent review found no defects.

Inspection and rename remain separate operations. Another writer can change the file after
the comparison. Unavailable host identity metadata and parent directory replacement retain
their documented limits.

### H4: Align planner and worker input contracts

[Plan 010](010-align-planner-worker-input.md) records the completed fix. The public
baseline worker regression returned `invalid worker input` for an accepted plan. The
worker now accepts string names as display metadata, including empty and NUL-containing
names. Executable fields retain their existing validation.

The focused suites passed 78 tests, with one platform test ignored. Public checks compare
planning, standalone execution, worker execution, and daemon execution. The CLI retains
its unselected job display. Non-string metadata and invalid executable fields remain
rejected. Every new test finished below one second.

### H5: Report submission rollback failures

[Plan 011](011-report-submission-rollback.md) records the completed fix. Public baseline
checks reproduce lost cleanup diagnostics and premature execution of rejected requests.
The rollback helper retains the primary rejection and each attempted cleanup failure.
Journal cleanup precedes request removal. Failed journal cleanup retains recovery files.
Any cleanup failure blocks repository work and reaches daemon diagnostics.

Candidates stay outside the executable queue until snapshot publication succeeds. Six
final public regressions passed. Checks cover both rejection routes, cleanup ordering,
retained files, later admission after successful cleanup, both shutdown boundaries, and
active completion during candidate publication. Every new test finished below one second.

Recovery uses the existing journal and retention rules. The fix adds no retry or new
protocol field. Power-loss durability remains outside this evidence.

### H6: Surface final snapshot publication failures

[Plan 012](012-report-final-snapshot-failures.md) records the completed fix. Both
settlement routes now report failed final publication through daemon diagnostics. The
message identifies the request and failed operation. Recorded results, client results,
live latest state, and existing blocks remain unchanged.

Both public fault regressions passed. They compare live status with stale fallback state
and confirm repair after later publication. Snapshot failure alone does not block
execution. Service startup saves diagnostics in `daemon.log`. Power-loss durability
remains unmeasured.

### H7: Resolve Homebrew through supported absolute paths

[Plan 013](013-share-homebrew-location.md) records the completed fix and Homebrew
consolidation. Hook installation, packaged installation, and source service control share
one supported absolute locator. Source stop uses the selected executable and keeps its
existing command budget.

The public baseline service regression failed because bare `brew` was outside `PATH`. The
focused suites passed 38 tests. Checks cover both supported paths, precedence, nonregular
files, inspection errors, absence, command failure, and no launch after absence. A native
child probe confirms location with restricted `PATH`. It inspects files only. The checks
stop no user service. Every new test finished below one second.

### H8: Return failure for failed doctor checks

[Plan 014](014-return-doctor-health-status.md) records the completed source change. Doctor
returns structured outcomes and aggregate health. The CLI preserves every report and
returns one if any check fails. Healthy reports return zero. README documents this
exit-status change for callers.

The public baseline command returned zero for an unavailable daemon. Six focused tests
pass after correction. They cover healthy, unavailable, blocked, and invalid repository
states, printed reports, and native CLI failure with an isolated daemon directory. Every
new test finished below one second. Native operations retain their existing bounds.

## Ordered pruning list

| Item | Outcome                                                          | Impact                                                             | Effort | Risk   | Confidence | Dependency                       |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------ | ------ | ---------- | -------------------------------- |
| P1   | Remove obsolete worker control files after recovery.             | Avoid retaining terminal control data until another run completes. | Small  | Medium | High       | Preserve pending recovery files. |
| P2   | Remove unreachable installation error and unused version export. | Align declared interfaces with runtime behavior.                   | Small  | Low    | High       | Caller checks.                   |
| P3   | Consolidate monitor process control and Homebrew location code.  | Remove duplicated lifecycle policies that already differ.          | Medium | Medium | High       | H1 and H7.                       |

### P1: Remove obsolete worker control files after recovery

[Plan 015](015-prune-recovered-control-files.md) records the corrected retention rule.
Startup retains control files only for pending journal entries. The latest result keeps
its terminal record and log. Successful recovery removes obsolete control files.

The public baseline regression retained a recovered latest control. Four recovery tests
pass after correction. They cover recorded completion, interruption, failed normal
deletion, pending cleanup failure, and repeated restart. An existing connected-reader test
also passes. Every new test finished below one second. Pruning retains existing
regular-file checks and repository blocking after cleanup failures.

### P2: Remove unreachable installation error and unused version export

[Plan 016](016-remove-unused-declarations.md) records the bounded deletion. Source
searches found no protocol export caller and no installation path returning the error
case. Both declarations and the unused installation message branch are removed.

The separate inspection error remains reachable and unchanged. Bounded inspection and
cooperative cleanup retain their existing code. Six public protocol and IPC tests pass.
Type, lint, layer, and suppression checks pass. Existing native checks cover inspection
output limits, installation output, cancellation, and restoration.

### P3: Consolidate monitor process control and Homebrew location code

Consolidation is complete through Plans 007 and 013. Monitor control shares exact matching
and confirmed shutdown. Homebrew location uses one supported locator across hook
installation, packaged installation, and source service control.

The installers retain their command budgets, installation transactions, and rollback
policies. Focused checks preserve both callers' behavior. The supported source installer
remains available.

## Measurement and documentation follow-ups

Capacity measurement remains a direction option, not a confirmed capacity defect. Queue
growth, connections, workflow logs, installer output files, and packaging capture need
measurement before numerical limits are selected. Packaging buffers tool output at
[scripts/package.ts:81](../scripts/package.ts#L81). The monitor retains installer output
on disk at
[monitor/Sources/MonitorCore/HookInstaller.swift:155](../monitor/Sources/MonitorCore/HookInstaller.swift#L155).
Any output policy must preserve cooperative restoration instead of terminating the
installer during cleanup. No safe maximum or failure threshold was measured in this
review.

Documentation reconciliation is complete through
[Plan 017](017-reconcile-hook-documentation.md). README, design, and repository
instructions distinguish the supported source hook from the packaged hook. Git selects one
effective pre-commit hook. The source hook calls `deno task ci`; the packaged hook calls
`deno task mci:ci`. Both submit the same local workflow and job. Effective Git
configuration currently selects the packaged hook for this checkout.

Visual checks, VoiceOver checks, minimum macOS support, Intel execution, and startup at
the next login remain existing evidence gaps.

## Validation and retained boundaries

The final code gate at `8d60d14` passed formatting, lint, types, 453 Deno tests, and 339
native checks. One opposite-platform test was ignored. Each isolated unit has its own
local commit and validation. [README.md](README.md) maps plans to commits, and
[VERIFICATION.md](../VERIFICATION.md) records detailed evidence.

Formatting, lint, and type checks passed before the advisory edit. A focused run passed 27
tests across workflow validation, command capture, protocol decoding, and IPC framing.
Public probes confirmed the planner-worker mismatch and the doctor's zero exit status
after failed checks. A pure pattern probe confirmed the monitor matcher accepts a sibling
executable prefix. The review opened no browser and signaled no user process. The document
commit uses the configured local pre-commit gate; its saved result remains under
`.mci/ci/`.

Existing checks cover queue order, cancellation ownership, strict decoding, durable
terminal writes, result preservation, and cooperative hook rollback. The review found no
basis to delete those checks, legacy imports, `status.json`, `latest.log`, or the
supported source installer. Trusted commands, inherited credentials, advisory locks, and
documented process recovery limits remain accepted boundaries. File size alone does not
justify splitting the daemon or hook modules. This list proposes no hosted CI, new
automatic trigger, dependency upgrade, or arbitrary numerical limit.

Legacy import still accepts file replacement between the log check and copy by a process
that runs as the same user. That process already has access to the user's files.
Concurrent legacy execution remains a supported migration boundary. The installers retain
their different cleanup policies after a failed fresh installation.

Power-loss durability remains unmeasured. The earlier manual checks did not establish
exact update latency, interrupted-state latency, deleted-watch recovery, or picker
cancellation. Transient macOS accept errors still need measurement. A retained external
abort listener affects repeated manual daemon closure with a reused signal. That test
boundary has lower priority than the listed application failures.

## Next action and ownership

Completed: all eight hardening items, all three pruning items, and documentation
reconciliation. No numbered item remains open. Capacity and additional platform checks
remain unselected directions with their stated evidence limits.

Next: the repository maintainer owns pushes, repository backups, and any additional
release acceptance checks. The main agent does not push.
