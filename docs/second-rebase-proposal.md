# Proposal for the second rebase

## Result and scope

I recommend a bounded second rebase. The largest justified change removes persistence for
queued requests that restart already discards. The foundation keeps one daemon, isolated
workers, strict workflow validation, workspace recovery, and the menu bar monitor. A
whole-product rewrite has no measured advantage in this review.

This document proposes changes. It does not authorize implementation, installation, or
removal of existing state. The assessed revision is local `main` at
`154d60bc7f50a15b4ece43222abd4ab647fea6b6`. The working tree was clean throughout the
independent reviews. The previous rebase in `docs/rebase-plan.md` is complete. These
recommendations concern the remaining code only.

## Measurements and evidence limits

| Measure                                                  |          Current result |
| -------------------------------------------------------- | ----------------------: |
| Tracked TypeScript and Swift lines                       |                  17,726 |
| TypeScript source lines                                  |                   6,068 |
| TypeScript script lines                                  |                     562 |
| TypeScript test and helper lines                         |                   8,729 |
| Swift lines, including Package.swift                     |                   2,367 |
| AST (abstract syntax tree) branches in TypeScript source |                   1,992 |
| Deno tests                                               |   264 passed, 1 ignored |
| Deno suite with coverage, wall time                      |                 23.12 s |
| Reported line coverage, all instrumented files           |                   79.7% |
| Reported branch coverage, all instrumented files         |                   83.9% |
| Weighted source line coverage                            | 4,070 / 4,963, or 82.0% |
| Weighted source branch coverage                          | 2,052 / 2,446, or 83.9% |
| Swift checks                                             |              247 passed |
| Swift build and checks, wall time                        |                 11.68 s |

The measurement pilot parsed `src/result.ts` and ran `tests/protocol_test.ts` with
coverage in less than one minute. The full measurement changed the scope, not the counting
method. A TypeScript 6.0.3 compiler walker counted branches from the syntax tree. The
count includes decisions, explicit else branches, and returns inside branches. Return
counts cover if, case, conditional, and catch ancestors within the same function.
Decisions include conditions, switch cases, loops, catch blocks, logical operators, null
coalescing, and optional chaining.

Function complexity starts at one and adds decisions inside that function. The function
count excludes decisions inside nested functions. This structural measure is not a runtime
cost measurement.

The suite command was `deno test --permission-set=mci --coverage=<temporary-directory>`.
The native command was `deno task app:check`. The times include command startup; native
timing also includes release builds. These are single observations on this host, not
benchmark distributions. The Deno test log contained no reported individual test time of
one second or more. File times in the appendix sum reported test durations and exclude
setup overhead.

The declared test counts include the ignored test. Some tests contain multiple cases, so
test counts do not count behavior guarantees.

Coverage from the parent test process does not prove coverage of every CLI subprocess. Low
module coverage is a reason to inspect public tests, not evidence that the module is
unused. Swift checks cover MonitorCore and build MonitorApp, but do not prove the
lifecycle of the running application. Power-loss durability remains unmeasured. Future
line savings, branch reductions, and runtime improvements need measurement after each
candidate change. No numerical savings in this proposal are estimates.

## Product contracts that stay

The pre-commit hook remains the only automatic CI trigger. The monitor reads status,
registers repositories, and opens logs; it does not start CI or install hooks. Each
repository retains FIFO (first-in, first-out) execution and one active worker. Different
repositories can run concurrently. The submitting connection owns cancellation. A restart
interrupts unfinished started work, drops queued work, and retries neither.

A cancelled queued request never replaces the latest completed result.

The runner retains strict selected-job validation, fresh Bash steps, environment
filtering, deadlines, and failure exit codes. The worker retains an immutable accepted
plan, strict control decoding, and isolation from the daemon. Workspace recovery retains
the permanent inode lock, process identity checks, group termination, and evidence when
cleanup is uncertain. Client deadlines and connected-client log retention stay. Terminal
recording precedes latest projection and journal cleanup. A failed projection cannot erase
a recorded successful result.

## Ranked findings

### 1. Persist started requests only

**Evidence:** `src/daemon.ts:644-726` allocates files and journals each accepted request
with `begun: false`. `src/daemon.ts:490-509` later updates that entry before starting the
worker. `src/daemon.ts:937-1002` discards unstarted entries during recovery.
`src/daemon-store.ts:403-410` exposes separate accept, begin, and finish journal
mutations. The daemon and store contain 1,735 lines and 517 counted AST branches together.
That footprint describes the affected modules; it is not the amount removable.

**Proposal:** keep queued requests in memory. Allocate the request log before acceptance
so the client keeps its accepted log path. Persist the complete started request
immediately before worker spawn. Replace `begin(id, started)` with insertion of the
complete request metadata. The current function only updates an existing journal entry.
Remove the admission journal write and journal cleanup for ordinary queued cancellation.

Replace admission rollback with cleanup of files that never reached execution. Keep
diagnostics and repository blocking when cleanup remains uncertain.

**Contract change:** acceptance confirms memory admission and an allocated log. Acceptance
no longer confirms durable evidence of an unstarted request. Restart behavior remains
unchanged: queued work disappears without execution. A crash after start persistence but
before spawn can still produce INTERRUPTED. The system does not claim that the worker ran
in that case.

**Preserve:** FIFO before and after canonical path resolution, concurrency, connection
cancellation, latest-result rules, and retained logs for connected clients. Keep global
journal serialization because started requests from different repositories still share one
file. Keep terminal recording, latest projection, and their fault handling. An ambiguous
start write must prevent spawn and retain recovery evidence. Failure now arrives after
acceptance as a failed terminal, rather than an admission storage rejection. Cleanup for a
failed start must handle a possibly persisted entry.

The failed-start cleanup must not use the simpler cleanup for an ordinary queued
cancellation.

**Migration:** initially keep the version 1 journal shape and `begun` field. The new
writer adds only complete `begun: true` entries. The decoder and startup recovery must
still process existing `begun: false` entries. Removing the field later requires a
separate schema decision and migration. No terminal or receipt schema changes belong in
this phase. A downgrade can read the unchanged schema; the old writer will resume
admission persistence.

**Prerequisites:** test admission disconnect, failed acceptance send, queued cancellation,
allocation failure, shutdown, and an active request with a queued request. Use the
accepted response to obtain queued request identifiers instead of reading the admission
journal. Check real daemon termination before start persistence, after persistence, and
after terminal recording. Check orphan pruning without deleting latest results, pending
evidence, or logs held by connected clients. Measure queue visibility in the monitor even
if the watcher stays. Memory admission no longer writes requests.json, so the watcher
loses that queue notification.

**Acceptance:** every started request has its durable marker before spawn. No ordinary
queued cancellation writes the journal. Restart never executes queued work. Recorded
completion survives failed projection or journal cleanup. The changed modules must have
fewer lifecycle transitions and measured structural reduction. A candidate that only moves
the same code into new files does not pass.

### 2. Remove unreachable monitor states and unused helpers

**Evidence:** `MonitorModel.swift:67,88,134` passes true to every successful snapshot
update. `MonitorModel.swift:136-139` clears rows and repositories when status fails.
`DisplayState.swift:176-197` still constructs stale rows for an unavailable daemon.
`SnapshotChecks.swift:98-102` exercises that unused path. `DisplayState.swift:92-107`
supplies a convenience initializer used only by display checks. `DaemonClient.swift:36-38`
defines a Swift ping helper with no caller.

**Proposal:** remove the stale-row argument and branch from `rowState`. Simplify
successful snapshot handling in MonitorModel. Remove the unused Swift ping helper. Move
checks away from the test-only RowState constructor, then remove that constructor if no
production caller remains. Keep coverage of every display priority through valid
repository values or the existing repository-based constructor.

**Preserve:** the global unavailable icon, missing folders, blocked repositories, queue
counts, current steps, and previous completed results. The monitor still shows no rows
while the daemon is unavailable. The TypeScript ping protocol operation stays because
installed clients can still send it. Removing an unused Swift helper does not require
removing its public wire operation.

**Acceptance:** `deno task app:check` passes. An isolated application check confirms
unavailable, available, and unavailable-again transitions. No stale-row path remains in
production source. The checks still cover display priority and attention counts. This
phase needs no state migration.

### 3. Separate monitor installation from service startup

**Evidence:** `src/install.ts:240-365` coordinates app replacement, service ownership,
readiness, launch, and rollback. `setupWith` contains 126 lines and measured
complexity 26. The installer contains 393 lines and 122 counted branches.
`tests/install_test.ts` contains 15 tests that cover replacement and recovery behavior.
The previous rebase explicitly retained installer rollback at `docs/rebase-plan.md:170`.

**Proposal:** finish app replacement as one operation. Keep ownership checks, signature
checks, staging, confirmed app shutdown, and rollback for failed placement or validation.
After replacement succeeds, start the service if needed, then open the app. A later
service, readiness, or open failure reports partial success and the exact retry step.
Remove service ownership accounting and rollback of a completed app replacement after
those later failures.

**Contract change:** a service or open failure can leave the new app installed and the
service running. The system does not automatically restore the previous app after a
completed replacement. Remove the backup after installed-bundle validation succeeds. If
backup cleanup fails, report the installed app and retained backup path as partial
success. Never remove an unidentified backup automatically during a rerun. A rerun must
finish the remaining operation safely.

The user must accept this change because the earlier plan retained the broader rollback
guarantee.

**Acceptance:** foreign bundles remain untouched. Uncertain app shutdown prevents
replacement. Placement failure restores the old app or reports its retained backup
location. Every partial-success state has a public rerun test and an actionable message.
No test disappears merely because it covers a difficult failure. The executor changes a
test only when its corresponding contract changes.

### 4. Use one automatic refresh mechanism in the monitor

**Evidence:** `DirectoryWatcher.swift` contains 53 lines. `MonitorModel.swift:40-58`
starts the watcher and debounce task. `MonitorModel.swift:102-106` also polls while
repairing the watcher. The existing timer refreshes each second during known work and each
five seconds while idle.

**Proposal:** remove DirectoryWatcher, its repair logic, and the event debounce task. Keep
startup refresh, refresh after repository operations, and coalescing of slow socket
requests. Keep the current active and idle polling intervals initially.

**Contract change:** work that begins while the monitor is idle waits for the next idle
poll to become visible. A short job can first appear as a completed result. The
five-second interval is a configured policy, not a measured upper bound on display
latency.

**Acceptance:** measure display latency and socket request counts on an isolated daemon.
Check short jobs, active steps, registration, restart, missing service directories, and
slow responses. Record whether the observed latency meets the user's needs before deleting
the watcher. If prompt detection remains required, keep the watcher. This phase changes no
persistence schema.

### 5. Delete minor compatibility and output-filtering code

**Evidence:** `MonitorApp.swift:13` accepts the old `MCI_MONITOR_REGISTRY_DIR` name. The
repository has no producer for that name. The current test override uses
`MCI_MONITOR_DAEMON_DIR`. `scripts/app-check.ts:4-36` filters one linker warning through
custom UTF-8 buffering and write loops. The full script contains 85 lines and 15 counted
branches.

**Proposal:** remove the old environment fallback with a compatibility note. Let Swift
build and check commands inherit stdout and stderr. Remove the filter, custom pumps, and
synchronous output loops. Keep the macOS guard, explicit MonitorApp build, check command,
launch diagnostics, and exit propagation.

**Contract changes:** the old environment name no longer selects the daemon directory. The
build log shows the previously suppressed warning. No monitor function or validation gate
disappears.

**Acceptance:** the current daemon override still works. The script preserves a failed
build or check program exit code. `deno task app:check` builds MonitorApp and passes the
checks. The repository does not need a new generic subprocess framework for this deletion.

### 6. Remove small duplicated boundary helpers only when the result is smaller

**Evidence:** `src/management.ts:26-34` repeats complete byte-write logic already provided
by `src/ipc.ts:9-20`. Protocol, worker, and store decoders repeat object and exact-key
predicates. The three decoder modules contain 985 lines; most of those lines enforce
distinct schemas.

**Proposal:** reuse `writeAll` where diagnostics and exit behavior remain the same.
Consider a small shared module for identical scalar predicates only. Keep schema-specific
validation and error messages beside each boundary. Reject a decoder language, schema
framework, or new dependency without a measured reduction.

**Acceptance:** partial writes, zero writes, invalid keys, malformed environments, and
current fixtures behave the same. Mechanical candidates have fewer total lines and
branches after counting every new helper and caller. A type improvement must identify the
illegal state that the compiler prevents. It need not reduce branch counts. This work is
secondary and does not justify a new architecture.

## Cuts rejected or deferred

| Candidate                                             | Disposition                  | Reason                                                                           |
| ----------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| Remove helper byte budgets                            | Reject                       | Fixed helper names do not establish a bound on their output.                     |
| Replace connected-client retention with a fixed count | Reject                       | A client can stall on terminal output; no measured drain bound protects its log. |
| Remove path routing order                             | Reject                       | FIFO remains required, including admission before canonical resolution.          |
| Replace all promise chains with one global queue      | Reject                       | Unrelated repositories would wait on stalled operations.                         |
| Rewrite daemon scheduling around a generic actor      | Defer                        | No specified candidate or measured advantage exists.                             |
| Collapse terminal record and latest projection        | Reject                       | Failed projection must preserve recorded completion.                             |
| Remove immutable package publication                  | Defer                        | Existing tests cover conflicting artifacts and concurrent publication.           |
| Collapse CLI input reads                              | Reject as mechanical cleanup | Public tests require different error precedence for ci and check/run.            |
| Slow worker polling or rely only on a stat size check | Defer                        | Polling changes latency; a growing file can exceed a preceding stat observation. |
| Delete Codex receipts                                 | Optional product cut only    | The owner retained and rewrote this adapter in the previous rebase.              |
| Delete ANSI rendering                                 | Optional product cut only    | Plain output still needs control-sequence handling and changes log presentation. |
| Remove direct mci run                                 | Reject                       | It shares the runner and remains useful for diagnosis.                           |
| Replace the workflow format                           | Reject                       | The current planner is 220 lines and has a defined public contract.              |
| Delete race tests to reduce test size                 | Reject                       | Test deletion cannot substitute for removing a production obligation.            |

## Test correctness and prerequisites

The race tests use real stores with selected operations delayed or failed. Their injection
points model filesystem faults; public outcomes remain the acceptance evidence. Some tests
also assert exact store operation order. Those assertions must change when admission
persistence disappears, while their public recovery assertions stay. The queued-restart
test must obtain its identifier from acceptance rather than the old journal layout.

MonitorChecks does not execute MonitorModel as a running application. A native build and
unit checks therefore cannot prove refresh scheduling or daemon availability transitions.
The monitor phases require an isolated application acceptance check. No slow individual
test was identified from the reported durations in this run. Repeated crash checks require
an agreed count and measured outcomes before scaling.

## Foundation after the changes

The workflow planner remains pure validation that produces an ordered Plan. The runner
owns one execution and delegates process and workspace effects to existing capabilities.
The worker remains the execution boundary between the runner and the shared daemon. The
daemon owns memory admission, durable execution start, result recording, and recovery. The
monitor remains a client of live daemon status.

Queued state belongs to memory; recovery state describes work that reached the execution
boundary. Expected failures remain Result values. The rebase does not add a general
scheduler, database, plugin system, or schema framework. Internal modules can change only
when the complete candidate becomes simpler under the preserved contracts.

## Phased execution plan

Each phase has one isolated local commit after its checks pass. The effective packaged
hook remains active, and the executor never pushes. Before code changes, the executor
reads `docs/solutions/` and `CONCEPTS.md`. The packaged gate must run independently of
edited source, as the recorded learning requires. The current effective hook comes from
`.git/config.worktree` and selects `/opt/homebrew/opt/mci/libexec/hooks`. No installation
change is necessary merely to prepare this proposal.

| Phase | Scope                                                   | Required decision                   | Checks                                                              | Expected measurement                                    |
| ----- | ------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| 0     | Correct design drift and establish changed contracts    | Accept proposal scope               | Read source, effective hook, and packaged daemon evidence           | No production code reduction                            |
| 1     | Remove stale monitor states and unused helper           | None beyond execution approval      | `deno task app:check`; isolated availability check                  | Fewer production display paths; exact savings measured  |
| 2     | Remove old environment fallback and Swift output filter | Decision 4 below                    | `deno task app:check`; override and failure checks                  | Fewer script branches and removed fallback              |
| 3     | Reuse identical boundary helpers where smaller          | None beyond execution approval      | Selected public tests; `deno task verify`                           | Lower complete mechanical footprint                     |
| 4     | Keep queues in memory and persist started work          | Decision 1 below                    | Daemon, race, client, and CLI tests; actual crash checks; full gate | No admission journal transition; savings measured       |
| 5     | Separate completed app replacement from service/open    | Decision 2 below                    | Installer tests; measured package/setup acceptance                  | Fewer rollback states; partial success remains explicit |
| 6     | Use polling alone                                       | Decision 3 below                    | Native checks; measured latency and request counts                  | One refresh mechanism; observed latency recorded        |
| 7     | Package and install the accepted result                 | Explicit installation authorization | Package build; installed daemon/monitor checks                      | Measured final footprint and behavior                   |

A future executor first runs one short successful job and one failing job on an isolated
daemon. Only the scope changes when the executor expands crash and concurrency checks. A
candidate must pass the full gate after the focused checks. The executor records actual
line, branch, coverage, and runtime changes for each phase. No percentage target justifies
removing a required guarantee.

## Documentation to update during execution

`docs/design.md:90-92` still describes candidate publication before queue admission. The
current daemon removed that publication in the previous rebase. The first documentation
phase must remove this obsolete claim.

The queue phase updates admission, restart, cleanup, and journal sections in README and
design documentation. The installer phase updates setup completion, partial success,
recovery, and retry instructions. The monitor phase updates refresh policy and removes
watcher responsibilities. The helper phase removes only the obsolete filtering
description. AGENTS.md changes only when the new constraint must bind other agents.
CONCEPTS.md changes only when a project term or contract changes.

The completed first rebase remains historical evidence in `docs/rebase-plan.md`.

## Decisions for the owner

Decision 1 (queued request persistence): memory admission with durable start, recommended;
or keep durable admission. The recommended option authorizes the queue contract change
described in finding 1.

Decision 2 (installer recovery): preserve app-swap rollback but report later partial
success, recommended; or keep full automatic rollback. The recommended option authorizes
only the reduced rollback scope described in finding 3.

Decision 3 (monitor refresh): measure polling alone before acceptance, recommended; or
keep watcher plus polling. Measurement does not authorize deleting the watcher before the
latency result is accepted.

Decision 4 (minor compatibility): remove the old monitor environment name and
build-warning filter, recommended; or keep both. The recommended option authorizes the two
small behavior changes described in finding 5.

These decisions accept specific contract changes; they do not authorize installation or
state deletion. The owner selects the scope before the main agent edits production code.

## Review reconciliation

The reviews ran against the same clean revision and independent initial briefs. Both
reviewers recommend bounded simplification and reject a deeper daemon rewrite. One
reconciliation round supplied the same source evidence and every position to both
reviewers. The main agent checked the findings against source and public tests.

| Round          | Requested model | Served model receipt | Movement | Different serving family from host |
| -------------- | --------------- | -------------------- | -------- | ---------------------------------- |
| Initial        | Fable, high     | claude-fable-5-1     | initial  | yes                                |
| Initial        | Astra, high     | gpt-6-astra          | initial  | no                                 |
| Reconciliation | Fable, high     | claude-fable-5-1     | moved    | yes                                |
| Reconciliation | Astra, high     | gpt-6-astra          | held     | no                                 |

Astra shares the host's serving family. Its separate context provides another assessment,
but does not establish cross-provider independence. Neither review changed repository
files. Agreement increases confidence; it does not prove that the proposed implementation
will preserve every contract.

Fable corrected its initial claim that the CLI input reads were equivalent. The public
precedence test contradicts that claim. Fable also withdrew changes to worker polling,
byte budgets, count-based retention, and routing order. Its static count of 261 tests was
superseded by the measured 264 passing tests and one ignored test. Astra kept its bounded
approach and added the queue-notification prerequisite for the monitor.

The remaining differences concern ping compatibility, package publication, and watcher
removal. Fable considers removal of ping and simpler package publication acceptable for
the current package and a single maintainer. The main agent keeps those guarantees because
installed clients and overlapping package commands remain possible. The source and tests
establish those contracts; no measurement establishes that they are unnecessary. Fable
prefers keeping the watcher; Astra accepts measured polling as a separate latency
decision. The proposal requires measurement and owner acceptance before watcher removal.

The final judgment favors a smaller execution lifecycle over reduced correctness
guarantees. No further review round is necessary for this proposal. Implementation must
still prove the accepted candidate against the stated checks.

## Full baseline by module

The table covers all 46 tracked TypeScript files. Imports count declarations; fan-in
counts importing files across tracked TypeScript, including tests. LCOV is a text format
for coverage records. Coverage denominators come from Deno LCOV and differ from physical
line counts. The test column maps a source module to its associated test file when that
file exists. An associated file can test other modules too.

The table reports structural complexity, not a runtime benchmark.

| Module                          | Lines | AST branches | Maximum complexity | Imports / fan-in | Line / branch coverage | Tests / time |
| ------------------------------- | ----: | -----------: | -----------------: | ---------------: | ---------------------: | -----------: |
| `scripts/app-check.ts`          |    85 |           15 |                  5 |            1 / 0 |           not measured | not isolated |
| `scripts/package.ts`            |   477 |           85 |                 14 |            3 / 1 |          46.2% / 87.0% |  17 / 0.032s |
| `src/ci-receipt.ts`             |   176 |           52 |                 19 |            3 / 5 |          94.5% / 92.3% |   8 / 0.023s |
| `src/cli.ts`                    |   413 |          102 |                 45 |           13 / 1 |          92.2% / 91.7% |  27 / 5.906s |
| `src/client.ts`                 |   221 |           80 |                 23 |            4 / 7 |          83.6% / 73.5% |   6 / 0.442s |
| `src/codex.ts`                  |   240 |           80 |                 14 |            4 / 2 |          91.6% / 93.9% |  14 / 0.357s |
| `src/command.ts`                |   351 |           83 |                 41 |            1 / 5 |          81.7% / 83.5% |  15 / 0.092s |
| `src/daemon-store.ts`           |   519 |          222 |                 13 |            3 / 2 |          84.7% / 74.1% | not isolated |
| `src/daemon.ts`                 |  1216 |          295 |                 31 |           10 / 4 |          82.2% / 78.9% |  29 / 6.627s |
| `src/homebrew.ts`               |    17 |            4 |                  4 |            1 / 3 |        100.0% / 100.0% |   7 / 0.017s |
| `src/hooks.ts`                  |   469 |          157 |                 13 |            4 / 4 |          91.2% / 82.4% |  17 / 0.161s |
| `src/install.ts`                |   393 |          122 |                 26 |            5 / 2 |          48.1% / 85.6% |  15 / 0.112s |
| `src/ipc.ts`                    |    78 |           26 |                 11 |            1 / 6 |          85.3% / 88.1% |   5 / 0.034s |
| `src/main.ts`                   |    10 |            1 |                  1 |            2 / 0 |    55.6% / no branches | not isolated |
| `src/management.ts`             |   176 |           85 |                 29 |            2 / 1 |           6.0% / 50.0% | not isolated |
| `src/monitor-process.ts`        |    62 |           18 |                  8 |            1 / 2 |        100.0% / 100.0% |   7 / 0.099s |
| `src/paths.ts`                  |    40 |           14 |                 10 |            1 / 8 |          78.6% / 50.0% | not isolated |
| `src/process.ts`                |   523 |          141 |                 23 |            2 / 3 |          93.0% / 89.3% |  31 / 0.244s |
| `src/protocol.ts`               |   282 |          136 |                 25 |            2 / 9 |          96.0% / 96.7% |   4 / 0.001s |
| `src/result.ts`                 |    17 |            3 |                  2 |           0 / 33 |         100.0% / 83.3% | not isolated |
| `src/runner.ts`                 |   161 |           51 |                 15 |            4 / 4 |          91.5% / 86.2% |  14 / 1.293s |
| `src/runtime.ts`                |    20 |            1 |                  2 |            1 / 9 |         100.0% / 50.0% | not isolated |
| `src/worker.ts`                 |   184 |           87 |                 13 |            4 / 3 |          88.6% / 82.4% |   4 / 0.401s |
| `src/workflow.ts`               |   220 |           88 |                 14 |           2 / 10 |          94.9% / 92.1% |   7 / 0.022s |
| `src/workspace.ts`              |   280 |          144 |                 22 |            3 / 3 |          78.0% / 75.4% |   9 / 0.033s |
| `tests/ci_receipt_test.ts`      |   280 |           11 |                  5 |            2 / 0 |           not measured |   8 / 0.023s |
| `tests/cli_test.ts`             |  1070 |           69 |                 14 |            6 / 0 |           not measured |  27 / 5.906s |
| `tests/client_test.ts`          |   238 |           10 |                  5 |            5 / 0 |           not measured |   6 / 0.442s |
| `tests/codex_test.ts`           |   454 |           10 |                  3 |            5 / 0 |           not measured |  14 / 0.357s |
| `tests/command_test.ts`         |   260 |            8 |                  3 |            2 / 0 |           not measured |  15 / 0.092s |
| `tests/daemon_helpers.ts`       |    25 |            2 |                  3 |            3 / 2 |         100.0% / 50.0% | not isolated |
| `tests/daemon_race_test.ts`     |  1479 |          142 |                 11 |            7 / 0 |           not measured |  29 / 5.698s |
| `tests/daemon_test.ts`          |  1352 |          133 |                 24 |            9 / 0 |           not measured |  29 / 6.627s |
| `tests/helpers.ts`              |    64 |            5 |                  3 |           1 / 20 |          93.3% / 70.0% | not isolated |
| `tests/homebrew_test.ts`        |   105 |            4 |                  3 |            3 / 0 |           not measured |   7 / 0.017s |
| `tests/hooks_test.ts`           |   469 |           28 |                  9 |            3 / 0 |           not measured |  17 / 0.161s |
| `tests/install_test.ts`         |   436 |           14 |                  2 |            3 / 0 |           not measured |  15 / 0.112s |
| `tests/ipc_test.ts`             |   118 |            6 |                  3 |            2 / 0 |           not measured |   5 / 0.034s |
| `tests/monitor_process_test.ts` |   239 |            8 |                  3 |            4 / 0 |           not measured |   7 / 0.099s |
| `tests/package_test.ts`         |   456 |           19 |                  7 |            3 / 0 |           not measured |  17 / 0.032s |
| `tests/process_test.ts`         |   759 |           38 |                  6 |            3 / 0 |           not measured |  31 / 0.244s |
| `tests/protocol_test.ts`        |   109 |            6 |                  6 |            2 / 0 |           not measured |   4 / 0.001s |
| `tests/runner_test.ts`          |   326 |           15 |                  6 |            4 / 0 |           not measured |  14 / 1.293s |
| `tests/worker_test.ts`          |   144 |            6 |                  4 |            4 / 0 |           not measured |   4 / 0.401s |
| `tests/workflow_test.ts`        |   157 |            4 |                  2 |            2 / 0 |           not measured |   7 / 0.022s |
| `tests/workspace_test.ts`       |   189 |            8 |                  4 |            2 / 0 |           not measured |   9 / 0.033s |

Swift has 27 tracked files, including Package.swift. The aggregate is 2,367 lines. Swift
coverage and syntax-tree branches were not measured; the native evidence is the build and
247 checks.

| Swift file                                               | Lines |
| -------------------------------------------------------- | ----: |
| `monitor/Package.swift`                                  |    12 |
| `monitor/Sources/MonitorApp/AddRepository.swift`         |    30 |
| `monitor/Sources/MonitorApp/Colors.swift`                |    37 |
| `monitor/Sources/MonitorApp/DirectoryWatcher.swift`      |    53 |
| `monitor/Sources/MonitorApp/ErrorNotice.swift`           |    25 |
| `monitor/Sources/MonitorApp/LogWindow.swift`             |   177 |
| `monitor/Sources/MonitorApp/LoginItem.swift`             |    50 |
| `monitor/Sources/MonitorApp/MonitorApp.swift`            |    47 |
| `monitor/Sources/MonitorApp/MonitorModel.swift`          |   155 |
| `monitor/Sources/MonitorApp/PanelView.swift`             |   189 |
| `monitor/Sources/MonitorChecks/AnsiChecks.swift`         |   110 |
| `monitor/Sources/MonitorChecks/Check.swift`              |    45 |
| `monitor/Sources/MonitorChecks/DisplayChecks.swift`      |    29 |
| `monitor/Sources/MonitorChecks/ErrorMessageChecks.swift` |    22 |
| `monitor/Sources/MonitorChecks/LogReaderChecks.swift`    |   121 |
| `monitor/Sources/MonitorChecks/SnapshotChecks.swift`     |   108 |
| `monitor/Sources/MonitorChecks/TextChecks.swift`         |    30 |
| `monitor/Sources/MonitorChecks/TimestampChecks.swift`    |    20 |
| `monitor/Sources/MonitorChecks/main.swift`               |    10 |
| `monitor/Sources/MonitorCore/Ansi.swift`                 |   215 |
| `monitor/Sources/MonitorCore/DaemonClient.swift`         |   201 |
| `monitor/Sources/MonitorCore/DaemonProtocol.swift`       |   262 |
| `monitor/Sources/MonitorCore/DisplayState.swift`         |   240 |
| `monitor/Sources/MonitorCore/ErrorMessage.swift`         |    21 |
| `monitor/Sources/MonitorCore/LogReader.swift`            |    88 |
| `monitor/Sources/MonitorCore/TextFormat.swift`           |    30 |
| `monitor/Sources/MonitorCore/Timestamp.swift`            |    40 |

Next action: the owner selects Decisions 1 through 4, then the main agent prepares the
accepted execution scope.
