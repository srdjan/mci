# Plan 007: Match the monitor path and confirm shutdown

## Status and authority

The user selected option 1, exact monitor shutdown, on 2026-10-08. This plan covers H1,
exact monitor shutdown, from the current hardening list. The selection authorizes
planning; implementation has not started.

Priority is high. Effort and change risk are medium. Confidence is high. No other open
plan is a prerequisite. The source baseline is local `main` at `11e034b`.

The executor owns implementation, checks, and one local commit. The maintainer owns
execution selection and repository backups. Work remains on local `main`; pushes remain
the maintainer's responsibility.

## Problem and current evidence

[src/install.ts:126](../src/install.ts#L126) constructs a prefix-only process pattern.
[scripts/install-monitor.ts:328](../scripts/install-monitor.ts#L328) repeats that pattern
for inspection and signaling. Both patterns match a sibling executable such as
`MonitorAppHelper`. A pure pattern probe confirmed this behavior without signaling a
process.

The packaged quit capability returns after `pkill` exits at
[src/install.ts:138](../src/install.ts#L138). Successful signal delivery does not
establish monitor exit. Setup immediately moves the old bundle at
[src/install.ts:286](../src/install.ts#L286). A monitor that exits slowly can therefore
remain active during replacement.

Packaged rollback starts with destination removal at
[src/install.ts:222](../src/install.ts#L222). It does not quit or inspect a replacement
process before removing that process's bundle. An uncertain launch failure can therefore
restore the old bundle while the replacement still runs. Source rollback already refuses
mutation after quit failure at
[scripts/install-monitor.ts:171](../scripts/install-monitor.ts#L171).

The source quit capability already polls every 100 ms for 2000 ms at
[scripts/install-monitor.ts:403](../scripts/install-monitor.ts#L403). Those values are
existing policies, not measured shutdown capacity. The local macOS `pgrep` manual confirms
extended regular expressions and matching of full argument lists with `-f`. Exit code 0
means a match; code 1 means no match. Codes above 1 report an error.

### Critical drift excerpts

Packaged shutdown currently builds this pattern in `src/install.ts`:

```ts
const pattern = `^${executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
```

Its success condition is:

```ts
return stopped.value.status.code <= 1
  ? ok(undefined)
  : err(`/usr/bin/pkill exited with ${stopped.value.status.code}`);
```

Packaged rollback currently begins:

```ts
const removed = await capabilities.remove(destination);
```

Source inspection and shutdown share this incomplete matcher:

```ts
const processPattern = (executablePath: string): string =>
  `^${escapeRegex(executablePath)}`;
```

## Behavior and compatibility boundaries

A matching command starts with the complete monitor executable path. The complete path
must end at the command boundary or precede whitespace that separates arguments. The
matcher must reject `MonitorAppHelper`, another directory, and an argument that merely
contains the monitor path. Paths with spaces and regular-expression metacharacters must
remain literal.

Success from the shared quit operation means inspection confirmed that no matching monitor
remains. Signal delivery alone cannot return success. Inspection failure and shutdown
timeout return errors. Installers must not remove, rename, restore, or reopen a bundle
whose matching process has uncertain shutdown.

The current signal remains SIGTERM. The helper sends no SIGKILL and introduces no retry
that signals repeatedly. The shutdown wait preserves the existing 2000 ms observation
policy and 100 ms polling policy. Individual command capture can extend elapsed time
beyond that observation window. The plan makes no hard real-time guarantee.

Normal AppKit Quit drains hook installation at
[monitor/Sources/MonitorApp/MonitorApp.swift:9](../monitor/Sources/MonitorApp/MonitorApp.swift#L9).
The monitor has no existing graceful CLI quit interface or SIGTERM handler. SIGTERM
remains forced termination and can interrupt hook restoration. This plan improves matching
and bundle mutation order; it does not make SIGTERM cooperative.

Command-line matching does not authenticate an executable or establish atomic process
identity. Custom argument lists, ambiguous whitespace, process replacement, and a new
launch after inspection retain their evidence limits. The executor must document those
limits instead of claiming complete protection against arbitrary same-user processes.

Public installer capability types and CLI arguments remain unchanged. Source service
control receives the shared behavior through existing native monitor capabilities. Fresh
packaged rollback still removes the new app after confirmed shutdown. Fresh source
installation retains its existing failure policy. Service ownership, daemon identity
checks, signatures, registration, and login preferences retain their current contracts.

## Scope

| File                              | Permitted change                                                    |
| --------------------------------- | ------------------------------------------------------------------- |
| `src/monitor-process.ts`          | Add one shared process inspection and quit helper.                  |
| `src/install.ts`                  | Use the helper and guard packaged rollback before bundle removal.   |
| `scripts/install-monitor.ts`      | Use shared matching, inspection, and quit behavior.                 |
| `tests/monitor_process_test.ts`   | Test the public helper with capabilities and owned native fixtures. |
| `tests/install_test.ts`           | Test packaged replacement and rollback ordering.                    |
| `tests/install_monitor_test.ts`   | Preserve source installation and rollback contracts.                |
| `tests/service_test.ts`           | Preserve source reopen, stop, and diagnostic behavior.              |
| `docs/design.md`                  | Describe matching, shutdown confirmation, and termination limits.   |
| `VERIFICATION.md`                 | Record checks and remaining evidence limits.                        |
| `plans/README.md`                 | Record execution status and completion.                             |
| `plans/hardening-pruning-list.md` | Record completion of exact monitor shutdown.                        |

`scripts/service.ts` is a read-only consumer for this plan. Its native bindings already
reference the source installer's `quit` and `isRunning` functions. `src/process.ts` and
`src/command.ts` remain read-only dependencies. No hook, daemon, native UI, package,
permission, or Homebrew locator changes belong in this unit. Other hardening and pruning
items remain unselected. Only duplicate monitor process code necessary for this fix can be
removed.

## Drift check and commands

Run the drift check before editing. Compare changed files with the current evidence and
critical excerpts. A source mismatch requires reconciliation before implementation.

```sh
git status --short
git diff 11e034b -- src/install.ts scripts/install-monitor.ts scripts/service.ts tests/install_test.ts tests/install_monitor_test.ts tests/service_test.ts docs/design.md VERIFICATION.md
```

Check whether the new helper and its test already exist. If either file exists, inspect
its purpose before creating or replacing content. The baseline contains neither file.

| Purpose                   | Command                                                                                                                                  | Expected result                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Existing focused baseline | `deno test --permission-set=mci tests/install_test.ts tests/install_monitor_test.ts tests/service_test.ts`                               | Existing tests pass.                       |
| New focused checks        | `deno test --permission-set=mci tests/monitor_process_test.ts tests/install_test.ts tests/install_monitor_test.ts tests/service_test.ts` | All selected tests pass.                   |
| Type checks               | `deno task check`                                                                                                                        | Exit 0.                                    |
| Formatting                | `deno task fmt:check`                                                                                                                    | Exit 0.                                    |
| Lint                      | `deno task lint`                                                                                                                         | Exit 0.                                    |
| Complete checks           | `deno task verify`                                                                                                                       | Deno and native checks pass.               |
| Local gate                | `git commit` with the configured hook                                                                                                    | Job `check` in `ci/local-ci.yml` succeeds. |

No dependency installation or generator is required. The local hook requires a responding
daemon and a registered checkout. The executor must not bypass that hook. A failed gate
requires correction and the same workflow and job.

## Ordered implementation

### Step 1: Add public regressions

Add `tests/monitor_process_test.ts` for the shared public process operations. Use a simple
command capability and controlled clock. Test matched, absent, and failed command results.
Test delayed exit and observation timeout without real two-second sleeps. Require one
SIGTERM command and no SIGKILL command.

Add packaged regressions through `setupWith` in `tests/install_test.ts`. Hold the quit
promise pending and assert that the old bundle remains unchanged. After confirmed exit,
require replacement to proceed. On quit failure, require the original bundle to remain and
staging cleanup to retain existing behavior.

Model uncertain new-app launch followed by rollback. Require rollback to quit the new app
before removal or restoration. On rollback quit failure, retain the destination and any
existing backup. For a fresh installation, report the retained destination without
claiming that a backup exists. Preserve the primary setup error before the shutdown
diagnostic.

Run the existing focused command first. Run new regressions against the unchanged
implementation wherever the existing public APIs permit that comparison. The rollback
regression must fail on the baseline because rollback omits quit. An installer capability
double alone cannot prove native exit waiting.

### Step 2: Add one shared process helper

Add `src/monitor-process.ts` with the existing Result convention. Keep expected failures
as Result values and use no `any`. Provide public inspection and quit operations with a
command runner, monotonic clock, and delay capability. Name the public operations
`monitorRunningWith` and `quitMonitorWith`. Keep the pattern builder private.

Use this POSIX pattern shape:

```text
^<escaped complete executable path>([[:space:]]|$)
```

Escape extended regular-expression metacharacters in the complete path. Pass the pattern
as one process argument. Do not insert shell quoting into the argument. Do not use
JavaScript lookahead, noncapturing groups, or `\s`.

Map `pgrep` code 0 to running and code 1 to absent. Treat other codes and capture failures
as diagnostic errors. Accept `pkill` codes 0 and 1, then inspect until absence is
confirmed. Send SIGTERM once, using an explicit signal argument. Return an error if
inspection fails or the observation policy expires.

Reuse `captureCommand` at the native boundary. Preserve caller policies through a small
runner adapter. Packaged capture keeps 5000 ms, 1000 ms reaping, and one MiB per stream.
Source capture keeps 10000 ms, 2000 ms reaping, and one MiB per stream. The shared
observation values remain 2000 ms and 100 ms.

Run new focused checks and type checks. Require absent processes to succeed without a
forced escalation. Require helpers to retain command and capture diagnostics.

### Step 3: Integrate installation and rollback

Replace packaged native `quit` with the shared quit operation. Replace source
`processPattern`, `pgrep`, and the duplicate quit loop with shared operations. Preserve
`nativeCapabilities.isRunning` and `nativeCapabilities.quit` signatures. Remove only
helpers that become unused.

Keep the initial quit before packaged and source replacement. Add a quit call before
destination removal in packaged `rollback`. If quit fails, return a diagnostic and retain
the destination and backup. If no destination previously existed, name only the retained
new app. Preserve service stop ordering and ownership checks.

Run the new focused command. Require existing source rollback tests to preserve retained
backups and primary errors. Require source service tests to preserve reopen and stop
behavior. No installer path may restore a backup after uncertain monitor shutdown.

### Step 4: Check native matching and document limits

Add a macOS fixture for exact-name and sibling-prefix processes. Copy `/bin/sleep` into
each fixture's unique temporary executable path. Include spaces and regular-expression
metacharacters in that path. Launch each copy directly; a shell script can expose its
interpreter as the command prefix. Confirm the host reports each fixture path before
calling the shared quit operation.

Require inspection to ignore the sibling-prefix process. Require the exact process to exit
after the helper's SIGTERM. Require the sibling process to remain alive. Clean up only
fixture-owned child handles or recorded fixture PIDs. Signal no installed monitor or
unrelated process.

Run a small fixture first and measure its complete duration. Each test must finish below
one second. Use a controlled clock for the full timeout case. Do not add a compiler or
dependency download merely to construct the fixture. If the host does not expose fixture
arguments as expected, report the limit before choosing another fixture.

Run focused checks, formatting, lint, type checks, and complete checks. Record whether
native matching passed on the tested macOS host. Document command-line identity limits and
forced termination separately from confirmed exit waiting. Update the index and hardening
list before the local commit.

## Done criteria

Public tests cover exact matching, sibling rejection, arguments, delayed exit, absence,
timeout, and command failures. Packaged rollback confirms exit before removal. Replacement
rollback preserves both app bundles when shutdown remains uncertain. Fresh rollback
preserves only the new destination when shutdown remains uncertain.

Source rollback, service behavior, daemon ownership, and public capability signatures
remain compatible. The shared helper replaces duplicate monitor process logic. Focused and
complete checks pass. The configured local gate passes and the unit has one local commit
on `main`.

Only scoped files change, and plan status records completion.

## Stop conditions

If source evidence changed, reconcile the plan before editing. If the solution needs a
graceful native quit interface, stop and report the additional scope. If the matcher needs
authenticated executable identity, stop and report the additional scope. If confirmed
shutdown requires SIGKILL, stop and report the unresolved process. If a fixture cannot
isolate its processes, stop before sending a signal. If an individual test exceeds one
second, reduce the fixture before continuing.

If a script requires more than two minutes, request the user's decision before running
that script. If required tools are absent, report the missing tools without installing
dependencies. If a correction fails twice, report the remaining failure. If implementation
needs another file or product contract, report the required scope change.

## Planning evidence and next action

The focused baseline passed 67 tests in 324 ms on the current macOS host. The review
inspected all direct consumers and the local `pgrep` manual. No native signal fixture or
delayed monitor exit probe ran during planning. The preceding full gate passed 399 Deno
tests and 339 native checks, with one platform test ignored. Those counts describe
planning evidence, not implementation completion.

The maintainer owns the next decision: execution of this plan. After an execution request,
I will coordinate implementation, review, checks, and the local commit.
