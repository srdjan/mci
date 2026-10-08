# Hardening and pruning list

## Scope and result

This review identifies eight hardening items and three pruning items on local `main` at
`c1215f2`, dated 2026-10-08. The user authorized the complete list. H1, exact monitor
shutdown, H2, existing file permissions, H3, concurrent Codex edits, and H4, planner and
worker input, and H5, submission rollback diagnostics, are complete. Three hardening items
and three pruning items remain open. The review covers Deno execution, daemon storage,
hook installation, service control, packaging, and the native monitor.

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

Evidence: [src/daemon.ts:481](../src/daemon.ts#L481) clears active state, then discards
the final snapshot write result. The unstarted request path also discards publication
failure at [src/daemon.ts:503](../src/daemon.ts#L503). The store returns those failures at
[src/daemon-store.ts:649](../src/daemon-store.ts#L649). If the final write fails,
`snapshot.json` can retain active or queued state until another publication succeeds. The
monitor uses that file when the daemon becomes unavailable, as documented in
[docs/design.md:485](../docs/design.md#L485).

The proposed change exposes snapshot failure through an explicit daemon diagnostic policy.
It must preserve the recorded workflow result and existing terminal projection rules.
Checks must inject final snapshot failure, read live status, and inspect the fallback
snapshot. The executor must distinguish diagnostic failure from workflow failure. This
item resolves the separate question deferred in [README.md:73](README.md#L73); the runtime
fault remains untested here.

### H7: Resolve Homebrew through supported absolute paths

Evidence: [scripts/service.ts:827](../scripts/service.ts#L827) finds loaded Homebrew
services through absolute system commands. The subsequent stop invokes bare `brew` at
[scripts/service.ts:848](../scripts/service.ts#L848). If `PATH` excludes the Homebrew
directory, source start or stop cannot disable the loaded service. The failure prevents
reliable shutdown or replacement of that service. The packaged installer already resolves
supported absolute paths at [src/install.ts:55](../src/install.ts#L55).

The proposed change uses the same supported locator for source service control. Checks
must cover restricted `PATH`, both supported installation locations, and an absent
Homebrew executable. This review inspected command selection; it did not stop the user's
service.

### H8: Return failure for failed doctor checks

Evidence: [src/hooks.ts:1522](../src/hooks.ts#L1522) returns success after collecting
failed checks. The CLI returns zero for that result at
[src/cli.ts:324](../src/cli.ts#L324). A public diagnostic against a missing repository
printed failed registration and path checks, then exited zero. The probe ran outside the
sandbox and reached the current local daemon. Scripts that inspect only the exit status
cannot detect those failures.

The proposed change returns structured check outcomes and an aggregate health status. The
CLI continues to print every report and returns a nonzero status when a required check
fails. Checks must cover healthy, unavailable, and invalid-repository cases. The executor
must document this exit-status change for existing callers.

## Ordered pruning list

| Item | Outcome                                                          | Impact                                                             | Effort | Risk   | Confidence | Dependency                       |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------ | ------ | ---------- | -------------------------------- |
| P1   | Remove obsolete worker control files after recovery.             | Avoid retaining terminal control data until another run completes. | Small  | Medium | High       | Preserve pending recovery files. |
| P2   | Remove unreachable installation error and unused version export. | Align declared interfaces with runtime behavior.                   | Small  | Low    | High       | Caller checks.                   |
| P3   | Consolidate monitor process control and Homebrew location code.  | Remove duplicated lifecycle policies that already differ.          | Medium | Medium | High       | H1 and H7.                       |

### P1: Remove obsolete worker control files after recovery

Evidence: [src/daemon.ts:970](../src/daemon.ts#L970) finishes recovery of a recorded
terminal without removing its worker control file. Interrupted recovery also retains that
file at [src/daemon.ts:1009](../src/daemon.ts#L1009). The daemon keeps the latest request
identifier at [src/daemon.ts:1025](../src/daemon.ts#L1025). The store preserves every
matching `.log`, `.json`, and `.jsonl` file at
[src/daemon-store.ts:670](../src/daemon-store.ts#L670). The latest request can therefore
retain obsolete `.jsonl` data through repeated restarts.

The proposed change retains files by purpose, rather than identifier alone. Pending
requests keep recovery files; completed requests keep their terminal record and log.
Checks must cover recorded completion, interruption, failed normal deletion, pending
recovery, and connected log readers. This review establishes retention through source
inspection; it ran no recovery probe for this item.

### P2: Remove unreachable installation error and unused version export

Evidence:
[monitor/Sources/MonitorCore/HookInstaller.swift:15](../monitor/Sources/MonitorCore/HookInstaller.swift#L15)
declares `HookInstallError.outputLimitExceeded`. The current installation function never
returns that case at
[monitor/Sources/MonitorCore/HookInstaller.swift:149](../monitor/Sources/MonitorCore/HookInstaller.swift#L149).
The separate inspection error with the same case name remains reachable and must stay.
Evidence: [src/protocol.ts:4](../src/protocol.ts#L4) exports `protocolVersion`, but
repository searches found no caller.

The proposed change removes those two unused declarations and the unreachable installation
message branch. The change preserves bounded inspection and cooperative installer cleanup.
Existing native checks, type checks, and IPC checks provide the validation boundary.
Removing additional unused export modifiers alone does not justify separate work.

### P3: Consolidate monitor process control and Homebrew location code

Monitor process consolidation is complete with H1, exact monitor shutdown. Homebrew
location consolidation remains open with H7, absolute Homebrew location.

The review baseline contained different monitor quit implementations. Plan 007 replaced
both implementations with the shared helper. Evidence:
[src/install.ts:55](../src/install.ts#L55) and [src/hooks.ts:51](../src/hooks.ts#L51)
repeat supported Homebrew location checks. Source service control bypasses those checks at
[scripts/service.ts:848](../scripts/service.ts#L848). These copies require coordinated
changes and already produce different behavior.

The proposed change shares narrow native primitives with H1, exact monitor shutdown, and
H7, absolute Homebrew location. The packaged and source installers keep their distinct
installation and rollback transactions. The source installer remains supported and must
stay. This pruning belongs with the related hardening work; it does not require a separate
framework.

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

Documentation reconciliation remains a small follow-up.
[docs/design.md:312](../docs/design.md#L312) describes the tracked source hook as the
automatic path. [README.md:399](../README.md#L399) describes the packaged hook, which
current local Git configuration selects. The documentation needs to distinguish the
supported source path from the packaged path. The tracked source hook and the single
pre-commit trigger remain repository requirements. Visual checks, VoiceOver checks,
minimum macOS support, Intel execution, and startup at the next login remain existing
evidence gaps.

## Validation and retained boundaries

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

Completed: H1, exact monitor shutdown, and H2, existing file permissions, have separate
units. The user authorized the full list in order. The main agent owns completion and
validation of each unit. H3, concurrent Codex edits, is next.

Each accepted unit needs its own local commit on `main`. The repository maintainer owns
pushes and repository backups.
