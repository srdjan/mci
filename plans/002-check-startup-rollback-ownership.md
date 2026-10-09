# Plan 002: Check process ownership before startup rollback

## Status and authority

This plan covers audit finding 2: startup rollback can signal a PID without checking
process identity. The user selected this plan on 2026-10-06. Implementation is complete in
local commit `96b7758`. The [plan index](README.md) owns current status.

Priority is high. Effort and change risk are medium. Confidence is high. No other plan is
a prerequisite. The source baseline is local `main` at `7b74afa`.

The executor owns implementation, checks, and one local commit. The maintainer owns
backups. Work on local `main`; do not push or create a branch.

## Problem and evidence

`scripts/service.ts:261-264` saves the launched PID, then waits for readiness. Process
inspection occurs only after readiness succeeds. A readiness failure therefore reaches
rollback without a captured identity.

`scripts/service.ts:181-187` then signals the bare PID. If the original process exits and
the operating system reuses its PID, rollback can signal another process.

The fallback at `scripts/service.ts:183-184` is the critical drift excerpt:

```ts
: launchedPid !== null
? await capabilities.signalProcess(launchedPid, "SIGTERM").then((result) =>
```

The audit called public `start` with simple capability doubles. Readiness failed, process
inspection never ran, and the signal double received SIGTERM. The probe did not reproduce
operating-system PID reuse or signal a real process.

`stopMatchingProcess` already compares PID, process group, start time, and command.
`tests/service_test.ts:252-260` covers changed identity during stop. Startup needs the
same ownership discipline before its first failure path.

## Scope and boundaries

| File                    | Permitted change                                       |
| ----------------------- | ------------------------------------------------------ |
| `scripts/service.ts`    | Capture launch ownership and remove PID-only rollback. |
| `tests/service_test.ts` | Test startup ownership through public `start`.         |
| `docs/design.md`        | Describe startup rollback and uncertain ownership.     |
| `VERIFICATION.md`       | Record checks and remaining process-race limits.       |
| `plans/README.md`       | Update this plan's status.                             |

Exclude daemon protocol, runner supervision, monitor installation, and Homebrew lifecycle
changes. Preserve reuse of preexisting daemons and custom service directories. Rollback
must stop only work started by the current invocation.

Use `Result` for expected failures. Do not use `any`. Reuse the capability doubles and
controlled clock in `tests/service_test.ts`.

## Drift check and commands

Run the drift check first. Compare changed source against the evidence above before
editing.

```sh
git diff 7b74afa -- scripts/service.ts tests/service_test.ts docs/design.md VERIFICATION.md
```

| Purpose         | Command                                                | Expected result              |
| --------------- | ------------------------------------------------------ | ---------------------------- |
| Type checks     | `deno task check`                                      | Exit 0.                      |
| Focused checks  | `deno test --permission-set=mci tests/service_test.ts` | All selected tests pass.     |
| Format          | `deno task fmt:check`                                  | Exit 0.                      |
| Lint            | `deno task lint`                                       | Exit 0.                      |
| Complete checks | `deno task verify`                                     | Deno and native checks pass. |

No dependency installation is required. Git's pre-commit hook requires a registered
checkout and a responding daemon. Do not bypass the hook.

## Ordered implementation

### Step 1: Add startup ownership regressions

Extend the existing `scene` double without adding a mocking library. Simulate a launched
daemon that never becomes ready. Return a changed identity before rollback.

Assert zero signals to the replacement process. Add missing-identity and inspection-error
cases. Assert that each error retains the startup failure and gives a recovery diagnostic.

The new tests must fail against the baseline. Run the focused command after adding them.

### Step 2: Capture ownership before the readiness wait

Observe the native child's status when `launchDaemon` spawns it. Add an `exited` query to
`DaemonLaunch` for observed exit state. Keep that observation across `unref` and readiness
waiting.

Inspect the launched PID before `waitForDaemon`. Capture PID, process group, and start
time only while the original child remains alive. Check observed exit before and after
inspection. An inspection must not adopt an identity after the original child exits.

Allow the expected launcher-to-Deno command transition during startup. Preserve stable
PID, process group, and start-time checks. After readiness, capture the full daemon
identity only if the stable fields still match.

Run type checks and focused tests. Require healthy launch, readiness, and record creation
to remain successful.

### Step 3: Remove the PID-only fallback

Route startup rollback through an ownership-aware stop operation. Recheck ownership before
signaling and while waiting for exit. Skip signals after observed child exit or identity
change.

When ownership is unavailable, return an explicit unresolved-cleanup diagnostic. Do not
signal the PID as a fallback. Preserve any recovery record that cleanup has not resolved.

Keep the original startup error when cleanup also fails. Preserve existing readiness,
shutdown, and polling policies. Do not add an estimated timeout.

Run focused tests. Require zero signals in every unknown or changed-ownership case.

### Step 4: Verify normal rollback and document limits

Test readiness failure while the original daemon remains alive. Require one owned
termination and confirmed exit. Test failure after record creation and preserve foreign
record contents.

Test the expected command transition with unchanged stable identity. Retain all
preexisting-daemon and custom-directory tests.

Run complete checks. Update evidence and the index before the local commit. Use doubles
for PID reuse; do not terminate an unrelated native process to test the fix.

## Done criteria

Public startup tests cover readiness failure, early exit, inspection failure, identity
change, normal rollback, and launcher command transition. Focused and complete checks
pass. No startup path signals a bare PID without ownership evidence. Only scoped files
change. The index records completion and the local commit.

## Stop conditions

Stop if native child status cannot remain observable after `unref`. Stop if normal exec
changes invalidate the chosen stable identity fields. Stop if the solution requires daemon
protocol changes or a new native launcher. Stop if checks fail twice after local
correction. Report any required file outside the scope.

## Maintenance notes

Process inspection and signaling remain separate operations. The fix removes unchecked
rollback; it does not claim atomic ownership checks. An uncertain cleanup can require
manual investigation.
