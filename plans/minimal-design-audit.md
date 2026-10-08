# Minimal design audit

## Result and scope

The best next step is bounded consolidation before new features. A full rewrite would put
established recovery behavior at unnecessary risk.

This audit reviews local `main` at `10b7f10` on 2026-10-08. The initial worktree was
clean. Production code was unchanged at that baseline. Source line references describe
that baseline.

The audit covers the runner, workflow parser, daemon, storage, client, installation,
session receipts, package scripts, and native monitor. Two read-only agents examined
separate areas. The main agent checked each recommendation against the current source.

Six bounded simplifications are recommended. Two larger consolidations require additional
compatibility evidence. Three proposed reductions are not recommended with current
evidence.

These are design findings, not confirmed runtime defects. Source inspection establishes
duplicated responsibility and unnecessary state. Runtime checks establish the current
baseline, not preservation after a future change.

## Execution status

The user selected findings 1-6 after this audit. All six code units are complete on local
`main`. The [implementation worklog](minimal-design-worklog.md) records each commit and
its acceptance checks. The final code gate passed 462 Deno tests and 339 native checks.
One opposite-platform test was ignored.

The seven production files grew from 4176 to 4194 lines. Shared rules and explicit lock
ownership reduce duplicated responsibilities. The changes do not reduce the total line
count. Findings 7-8 remain unselected; findings 9-11 retain their existing boundaries.

## Required behavior

The runner must execute the selected job against the current workspace. Validation must
reject unsupported configuration before execution. Shell environments, output, exit codes,
and failure diagnostics must retain their current behavior.

The daemon must preserve FIFO ordering within each repository and concurrency across
repositories. Each submitting connection owns its cancellation. Connected clients must
retain their request logs.

Restart must preserve completed results and interrupt begun requests. Restart must drop
requests that never began. Recording, projection, and journal cleanup must retain their
separate recovery rules.

Installers must preserve permissions, concurrent edits, rollback ordering, and
cancellation cleanup. Process cleanup must retain identity checks and bounded waits. The
monitor must observe CI without starting another automatic trigger.

Public commands, managed hooks, persisted formats, legacy import, and supported source
installation must remain available. Repository configuration must continue to select
repository tasks. Git history requires no rebase for this cleanup.

The authoritative contracts are [AGENTS.md](../AGENTS.md), [README.md](../README.md), and
[design.md](../docs/design.md). Existing regression tests provide the failure scenarios
for each boundary.

## Recommended minimal design

The current separation between workflow validation, execution, coordination, and adapters
is useful. The design needs fewer repeated policies within those boundaries.

| Responsibility                           | Remaining owner                           |
| ---------------------------------------- | ----------------------------------------- |
| Workflow semantics and plans             | `workflow.ts`                             |
| Execution and process recovery           | `runner.ts`, `process.ts`, `workspace.ts` |
| Request ordering and ownership           | `daemon.ts`                               |
| Durable records and projections          | `daemon-store.ts`                         |
| Transport framing and complete writes    | `ipc.ts`                                  |
| Hook rules and installation transactions | `hooks.ts`                                |
| User commands and session reporting      | CLI and Codex adapters                    |
| Display and native interaction           | Swift monitor                             |

This table defines responsibilities, not a required file rearrangement. A smaller file
count alone would not establish a simpler design.

## Six bounded simplifications

### 1. Represent connected request ownership with a set

**Observation:** [daemon.ts:66](../src/daemon.ts#L66) stores reader counts, although the
protocol assigns one submitting connection per request. `hold` has one call at line 772.
Failed acceptance and normal completion use exclusive release paths at lines 782 and 661.

The count above one adds a branch for ownership that current requests cannot establish.
The obsolete map also stores its request identifier twice. The separate `Owner` object
contains only the connection and its connected flag.

**Recommendation:** Use a set of connected request identifiers. Store each obsolete
request's repository path directly under its identifier. Keep the connection and connected
flag on `Job`.

The daemon remains the retention owner. Log deletion must still wait for both client
release and pending journal cleanup. This reduces state without removing retention
behavior.

**Risk:** Premature deletion would break a connected client during another completed run.
A future shared-reader feature would require a different ownership model.

**Acceptance:** Run the old-log, disconnection, failed-acceptance, cancellation, and
cleanup-failure tests in `daemon_test.ts` and `daemon_race_test.ts`. Reject the reduction
if one identifier can receive overlapping holds.

### 2. Load repository state through one function

**Observation:** [daemon.ts:841](../src/daemon.ts#L841) and
[daemon.ts:982](../src/daemon.ts#L982) construct the same repository state. Both recover
the workspace, load the latest result, and preserve the first blocking error.

**Recommendation:** Add one local `loadRepositoryState` function. Registration and startup
will retain their separate map insertion and publication steps. The daemon remains the
lifecycle owner.

**Risk:** A helper that changes error precedence can hide the original recovery failure.
Startup also performs journal recovery after initial state loading.

**Acceptance:** Check live registration and startup with healthy, busy, blocked, and
unreadable workspaces. Check valid latest results and failed latest reads. Preserve
startup journal recovery and publication order.

### 3. Recover a workspace without creating another run

**Observation:** [workspace.ts:249](../src/workspace.ts#L249) calls `openWorkspace`, then
closes the returned lease. [workspace.ts:181](../src/workspace.ts#L181) creates a run
directory and journal after recovery. Closing the lease immediately removes both.

Daemon startup and registration use this recovery-only path. The unnecessary allocation
can also fail after successful recovery and prevent a ready result.

**Recommendation:** Separate lock acquisition and recovery from run allocation inside
`workspace.ts`. `acquireWorkspace` will allocate private scripts and a journal only for
execution. `recoverWorkspace` will recover under the same lock, then release it.

The workspace module remains the lock and recovery owner. Keep the permanent lock inode
and all existing recovery checks.

**Risk:** Releasing the lock before recovery ends would permit competing cleanup or
execution. Error handling must release the lock without clearing uncertain recovery data.

**Acceptance:** Check busy-lock behavior, uncertain identity, retained journals, orphan
cleanup, symlink refusal, and repeated recovery. Add a public recovery check that creates
no fresh run directory or journal. Measure latency only if a performance claim is needed.

### 4. Share CLI workflow preparation

**Observation:** [cli.ts:224](../src/cli.ts#L224) and [cli.ts:421](../src/cli.ts#L421)
read workspace state, parse workflows, and resolve Bash separately. The commands also
repeat preflight error handling.

**Recommendation:** Use one preparation function within the CLI for `check`, `run`, and
`ci`. Return the workspace, source, environment, plan, and resolved shell. Keep
command-specific reporting and receipt publication at the command boundary.

The CLI remains the local preflight owner. The daemon must still validate submissions
independently. Removing daemon validation would weaken its public socket boundary.

**Risk:** The existing read order differs between paths. Refactoring must preserve each
command's diagnostic precedence when multiple inputs fail. Receipt creation must still
precede validation for execution commands.

**Acceptance:** Compare exit codes, diagnostics, receipts, and absence of execution for
missing files, invalid workflows, and absent Bash. Keep portable `check`, parent watching,
signal handling, and session failure tests.

### 5. Use one complete-write function

**Observation:** [ipc.ts:8](../src/ipc.ts#L8), [daemon.ts:201](../src/daemon.ts#L201),
[worker.ts:104](../src/worker.ts#L104), and [client.ts:54](../src/client.ts#L54) repeat
the same partial-write loop.

**Recommendation:** Use one structural writer function with an explicit diagnostic
argument. The function will write every byte or return the existing failure detail. Each
caller will retain framing, synchronization, and output policy.

The writer function owns only partial-write handling. It must not become a transport
framework or combine file synchronization with socket framing.

**Risk:** Changing zero-write diagnostics or handling can change externally visible
failure behavior. File and socket callers currently use slightly different failure
predicates.

**Acceptance:** Check short writes, zero writes, thrown errors, and exact diagnostics
through public callers. Existing IPC tests do not cover all short-write cases. Add the
missing behavior checks before consolidation.

### 6. Give hook preflight one implementation

**Observation:** [hooks.ts:1119](../src/hooks.ts#L1119) prepares setup and checks the
workflow, configuration, repository, and packaged hook. Setup later calls
[hooks.ts:674](../src/hooks.ts#L674), which repeats those checks before installation.

Setup creates workflow and ignore files before this call. The second read therefore also
detects changes after setup begins. Those reads are not all removable.

**Recommendation:** Share preflight rules and parsed installation data between both public
commands. Keep generated-file preparation in setup. Keep explicit resource checks before
mutation and preserve the existing rollback phases.

The hook module remains the rule and transaction owner. Delete duplicated validation code
first. Reuse observed data only when a current check proves that the resource did not
change.

**Risk:** A single stale snapshot could overwrite concurrent configuration changes or
install against changed hooks. Moving cancellation points can also interrupt restoration.

**Acceptance:** Run `hooks_test.ts` and CLI hook tests. Preserve concurrent-edit, worktree
migration, permissions, recursion, cancellation, commit-point, and failed-rollback cases.
Compare diagnostics before removing repeated reads.

## Two larger consolidations

### 7. Make TypeScript the hook readiness owner

**Observation:** [hooks.ts:73](../src/hooks.ts#L73) defines the managed task and hook.
[HookInstaller.swift:93](../monitor/Sources/MonitorCore/HookInstaller.swift#L93) repeats
the hook text. Swift also parses the generated task and checks readiness at lines 229-431.

This gives installation and readiness separate implementations of the same policy. A
format change requires matching changes across languages.

**Direction:** A typed, read-only `hooks inspect --json` command can make `hooks.ts` the
policy owner. Swift would discover the executable, enforce its command budget, decode the
response, and display readiness.

Existing behavior requires canonical repository roots, the effective worktree hook, the
selected executable, and the packaged hook path. Hook files retain their 64 KiB limit.
Configuration files retain their 1 MiB limit. Inspection retains its one-second deadline
and cancellation cleanup. Offline refreshes retain the last readiness result.

**Compatibility condition:** The current Swift inspector works without invoking a new CLI
command. Removing it immediately can change behavior with an absent or older binary. A
fallback preserves compatibility but temporarily increases complexity.

Choose a supported package-version policy before implementation. Compare both inspectors
against every readiness fixture first. Remove the fallback only when the supported binary
contract permits removal.

**Acceptance:** Retain `HookInstallerChecks.swift`, `HookStatus` behavior, and offline
monitor checks. Add absent-binary, older-binary, malformed-response, and exact
classification comparisons. No part of inspection may start CI.

### 8. Share the narrow bundle replacement transaction

**Observation:** [install.ts:220](../src/install.ts#L220) and
[install-monitor.ts:145](../scripts/install-monitor.ts#L145) repeat staging, backup
placement, replacement, restoration, and reopening.

**Direction:** Share only the validated bundle swap and restoration operations. Keep
build, signing, ownership validation, service ownership, registration, and readiness
checks in the current callers.

The current policies differ. A fresh source installation retains the new app after a later
failure. Packaged rollback attempts to remove the new app. Signature rules, placement
diagnostics, and reopen behavior also differ.

A large generic installer would hide these differences behind policy switches. That could
increase concepts despite fewer lines. Prefer a small shared transaction only when its
callers remain explicit.

**Acceptance:** Run both installer suites unchanged. Check fresh installation,
replacement, failed shutdown, retained backup, failed placement, failed restoration, and
exact diagnostic context. Keep each caller's command budgets and cleanup policy.

## Three reductions to retain or reject

### 9. Retain strict boundary decoders

Worker, protocol, and storage modules repeat small validation primitives. Their accepted
values differ intentionally. Worker display metadata accepts strings that executable and
protocol fields reject.

A generic schema layer would add a concept and could recreate the recent planner-worker
mismatch. Keep exact decoders at each untrusted boundary. Share a domain decoder only
after equivalence tests prove identical contracts.

Sending less display metadata to workers is a possible later reduction. It needs a
separate input contract and matching worker checks. Current evidence does not establish
that a new worker format offers enough benefit.

### 10. Retain distinct atomic replacement policies

[hooks.ts:636](../src/hooks.ts#L636), [codex.ts:111](../src/codex.ts#L111),
[ci-receipt.ts:264](../src/ci-receipt.ts#L264), and
[service.ts:789](../scripts/service.ts#L789) use different atomic writers.

Permissions, synchronization, pre-rename guards, temporary names, and cleanup diagnostics
differ. Daemon storage also synchronizes parent directories and copies logs.

A generic writer with switches for every policy would hide important behavior. Keep the
current writers for now. A later extraction must preserve each policy explicitly and
reduce concepts as well as lines.

### 11. Retain store serialization with current evidence

The daemon and store both serialize registry and terminal operations. Current daemon
callers often establish the same ordering first.

The store exposes independent mutation methods. Removing its chains would make correctness
depend on undocumented caller discipline. A production call-site scan alone does not prove
preservation of the store contract.

Keep the chains until a narrower internal store contract has explicit ownership and
concurrent-call checks. Journal and snapshot chains remain necessary across repositories.
Raw-path routing and canonical repository admission also protect different ordering
conditions.

## Complexity that remains necessary

Process groups, identity checks, workspace locks, and recovery journals protect cleanup
after interruption. Worker isolation protects daemon availability and cancellation
ownership.

Acceptance, begun state, terminal recording, projection, and cleanup protect different
crash boundaries. Combining these stages would lose recovery information. Saved
compatibility outputs and legacy import still have readers and migration behavior.

Receipt path resolution preserves ordered symbolic-link behavior and missing-path
identity. Notification state and receipts have separate owners. Cooperative installer
cancellation must finish restoration before monitor task removal or normal Quit.

There is no evidence to remove these boundaries, their regression tests, or supported
installation routes. There is also no measured basis for new queue or output thresholds.

## Baseline evidence

Formatting, lint, and type checks passed at the audit baseline. The main agent ran 77
focused Deno tests across workflow, worker, runner, workspace, command capture, and
process supervision. All 77 passed outside the sandbox.

The sandbox attempt passed 58 tests and failed 19. Its process tests reported that the
sandbox denied `/bin/ps`. The approved rerun used the same test selection and passed. This
was an environment restriction, not evidence of a source regression.

Focused logs reside at `/private/tmp/mci-simplification-runner-tests-approved.log`. These
checks do not establish all monitor, installer, or daemon behavior. The local pre-commit
gate provides the full documentation-commit check.

No benchmark establishes a latency improvement. The implementation worklog measures the
same module scope before and after the accepted changes. It records source growth and the
responsibilities that each shared function now owns.

## Worklog and next action

Objective: identify unnecessary complexity and a smaller design before new features.
Constraints: preserve functionality, local `main`, isolated local commits, no push, and no
additional automatic CI trigger.

Completed: the audit, all six selected simplifications, public characterization checks,
source review, and isolated local commits. Execution followed findings 1-6 in numerical
order. The implementation worklog retains the plan and evidence limits.

Findings 7-8 require compatibility decisions before execution. The user owns those
decisions. Findings 9-11 remain retained boundaries.

Next: the repository maintainer owns repository backups and any additional release
acceptance checks. The main agent does not push.
