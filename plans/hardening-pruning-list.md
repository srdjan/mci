# Hardening and pruning list

## Scope and result

This review identifies eight hardening items and three pruning items on local `main` at
`c1215f2`, dated 2026-10-08. The list proposes work; application changes have not started.
The review covers Deno execution, daemon storage, hook installation, service control,
packaging, and the native monitor.

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

The user selected this item for planning on 2026-10-08.
[Plan 007](007-exact-monitor-shutdown.md) records the execution scope; implementation
remains pending.

Evidence: [src/install.ts:126](../src/install.ts#L126) and
[scripts/install-monitor.ts:328](../scripts/install-monitor.ts#L328) construct a
prefix-only process pattern. A pure pattern probe confirmed that the pattern matches both
`MonitorApp` and a sibling `MonitorAppHelper` executable. Setup, reinstall, rollback, and
source stop can therefore signal an unrelated matching executable. The review signaled no
process.

Evidence: [src/install.ts:138](../src/install.ts#L138) treats successful signal delivery
as successful shutdown. Setup then renames the existing app at
[src/install.ts:286](../src/install.ts#L286). If the old monitor exits slowly, setup
replaces and opens the app while the old process still runs. The source installer already
polls for exit at [scripts/install-monitor.ts:403](../scripts/install-monitor.ts#L403).
Actual delayed monitor exit remains untested here.

The proposed change uses one exact executable matcher and an explicit quit-and-wait
result. The change must preserve cooperative hook restoration and refuse replacement when
shutdown remains uncertain. Checks must cover a sibling executable, arguments, delayed
exit, and failed shutdown before bundle mutation. Native checks must use disposable
processes.

### H2: Preserve existing file permissions

Evidence: [src/codex.ts:111](../src/codex.ts#L111) replaces configuration through a
temporary file. The installer always supplies `0644` at
[src/codex.ts:453](../src/codex.ts#L453). Replacing an existing `0600` file therefore
widens its mode to `0644`. Other accounts can read that file when directory permissions
permit access.

Evidence: [src/hooks.ts:956](../src/hooks.ts#L956) replaces `deno.json` without its
previous mode. Rollback also omits the previous mode at
[src/hooks.ts:972](../src/hooks.ts#L972). The replacement uses creation permissions
instead of the owner's selected permissions. This finding comes from source inspection;
this review ran no permission regression.

The proposed change retains the existing mode for replacement and restoration. New files
retain an explicit creation policy. Checks must cover restrictive modes, successful
replacement, failed installation, and unchanged configuration. The executor must record
unsupported ownership or access-control metadata separately.

### H3: Detect concurrent Codex configuration edits

Evidence: [src/codex.ts:320](../src/codex.ts#L320) reads `.codex/hooks.json` without
retaining its original bytes or file identity. The installer replaces that configuration
at [src/codex.ts:453](../src/codex.ts#L453) without checking for changes. If another
process edits the file between those operations, replacement loses the concurrent edit.
Foreign handler preservation covers only the configuration that the installer first reads.

The proposed change detects changed input and returns a conflict before replacement. A
recheck alone does not establish atomic exclusion against arbitrary editors. The executor
must define that remaining concurrency boundary and preserve installation idempotence.
Checks must exercise public installation with a controlled concurrent edit to a foreign
handler. This review confirms the missing check through source inspection; it does not
reproduce the concurrent edit.

### H4: Align planner and worker input contracts

Evidence: [src/workflow.ts:210](../src/workflow.ts#L210) copies unselected job names into
`otherJobs` without validating those names. The worker rejects empty or NUL-containing
names at [src/worker.ts:48](../src/worker.ts#L48). A public probe supplied an empty
unselected job name beside a valid selected job. The planner returned success, but the
worker exited with code 1 and `worker input failed: invalid worker input`. The selected
command did not start.

The proposed change establishes one contract for accepted plans and worker input. The
executor must preserve the documented exclusion of unselected job semantics. Removing
display-only `otherJobs` from worker transport is an alternative to rejecting unrelated
metadata. Checks must compare validation, direct execution, and daemon execution for the
same workflow. The CLI must retain its unselected-job display at
[src/cli.ts:454](../src/cli.ts#L454).

### H5: Report submission rollback failures

Evidence: [src/daemon.ts:707](../src/daemon.ts#L707) discards spool removal failure after
journal acceptance fails. The shutdown path discards journal and spool cleanup results at
[src/daemon.ts:713](../src/daemon.ts#L713). Snapshot acceptance failure also discards both
cleanup results at [src/daemon.ts:721](../src/daemon.ts#L721). If cleanup fails, artifacts
or journal entries remain without a cleanup diagnostic in the response.

The proposed change retains the primary failure and each cleanup failure. The executor
must define whether failed cleanup blocks further work for that repository. Checks must
inject journal cleanup and spool removal failures through daemon capabilities. Checks must
confirm that rejected work never starts and recovery evidence remains available. These
secondary failures remain untested in this review.

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

Evidence: [src/install.ts:126](../src/install.ts#L126) and
[scripts/install-monitor.ts:392](../scripts/install-monitor.ts#L392) implement different
monitor quit behavior. Evidence: [src/install.ts:55](../src/install.ts#L55) and
[src/hooks.ts:51](../src/hooks.ts#L51) repeat supported Homebrew location checks. Source
service control bypasses those checks at
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

Completed: the main advisor reviewed current evidence and created this list. Application
changes remain proposed and have not started. The repository maintainer owns selection of
the next unit. H1, exact monitor shutdown, is the recommended first unit. After selection,
I will write a focused execution plan with public regression checks.

Each accepted unit needs its own local commit on `main`. The repository maintainer owns
pushes and repository backups.
