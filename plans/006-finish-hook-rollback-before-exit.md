# Plan 006: Finish hook rollback before reporting cancellation

## Status and authority

This plan covers audit finding 5: the monitor can terminate hook setup during mutation or
rollback. The user selected this plan on 2026-10-06. Implementation remains pending.

Priority is medium. Effort is large after inspection of application termination. Change
risk is medium. Confidence is high for the source defect. Cancellation during mutation
still requires reproduction.

Plan 004, task option parsing, and Plan 005, existing workflow validation, are
prerequisites. The source baseline is local `main` at `7b74afa`.

The executor owns implementation, checks, and one local commit. The maintainer owns
backups. Work on local `main`; do not push or create a branch.

## Problem and evidence

`HookInstaller.swift:434-454` stops installation after cancellation or its outer deadline.
`stop` sends SIGTERM, waits 100 milliseconds, then sends SIGKILL to the direct process.
The hook CLI routes at `src/cli.ts:208-242` register no signal handlers.

The forced termination at `HookInstaller.swift:518` is the critical drift excerpt:

```swift
if process.isRunning { _ = kill(process.processIdentifier, SIGKILL) }
```

`setupHookWith` creates a workflow and changes `.gitignore` before calling the inner
installer. `installHookWithPolicy` changes `deno.json`, `extensions.worktreeConfig`, and
`core.hooksPath`. Its restoration functions run only while the CLI remains alive.

An outer signal can therefore prevent rollback. A running Git helper can survive its CLI
and complete a configuration change after the monitor reports failure. Current native
checks use direct processes without repository mutations.

`MonitorModel.swift:187-203` cancels operations after daemon loss or repository removal.
`PanelView.swift:89` quits the application without draining installation tasks. The
installation path needs one cancellation contract across the CLI and monitor.

## Chosen cancellation contract

The CLI owns the forward-operation deadline. SIGINT, SIGTERM, and deadline expiry request
cooperative cancellation. The CLI finishes an active bounded helper, then evaluates the
request at a transaction checkpoint. It completes rollback before exit.

The monitor waits for CLI exit as the completion handshake. It does not force termination
of a transactional installation. Normal application Quit also waits for that handshake.
Read-only inspection keeps its current bounded termination policy.

Reuse the existing 120000-millisecond forward deadline. Cleanup can continue after that
deadline. Existing helper deadlines bound individual waits. No measured evidence supports
a new whole-rollback deadline or a safe forced-kill grace period.

If cancellation arrives after the final required mutation succeeds, report success. The
transaction has committed. Before commit, report cancellation only after restoration
finishes. Preserve each restoration failure in the returned diagnostic.

Forced application termination and host crashes remain interruption limits. Do not claim
that they complete rollback. Immediate interruption of an active helper is deferred.

## Scope and boundaries

| File                                                      | Permitted change                                             |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `src/cli.ts`                                              | Add hook signal handling and child-owned deadline arguments. |
| `src/hooks.ts`                                            | Add cancellation checkpoints and ordered restoration.        |
| `tests/hooks_test.ts`                                     | Test cancellation through public capability APIs.            |
| `tests/cli_test.ts`                                       | Test hook CLI signal handling and argument compatibility.    |
| `monitor/Sources/MonitorCore/HookInstaller.swift`         | Separate transactional installation from bounded inspection. |
| `monitor/Sources/MonitorCore/HookLifecycle.swift`         | New file for cancellation and draining of owned tasks.       |
| `monitor/Sources/MonitorChecks/HookInstallerChecks.swift` | Test the installer exit handshake.                           |
| `monitor/Sources/MonitorChecks/HookLifecycleChecks.swift` | New file for public lifecycle checks.                        |
| `monitor/Sources/MonitorChecks/main.swift`                | Register new native checks.                                  |
| `monitor/Sources/MonitorApp/MonitorModel.swift`           | Retain and drain cancelled installations.                    |
| `monitor/Sources/MonitorApp/MonitorApp.swift`             | Coordinate normal application termination.                   |
| `README.md`                                               | Describe deadline and cleanup behavior.                      |
| `docs/design.md`                                          | Record commit, cancellation, and termination rules.          |
| `VERIFICATION.md`                                         | Record reproduction and validation limits.                   |
| `plans/README.md`                                         | Update this plan's status.                                   |

Exclude daemon changes, CI submission, new automatic triggers, helper process-group
redesign, and crash-recovery journals for installation. Preserve hook conflict checks,
worktree isolation, source workflow support, and strict rollback diagnostics.

Use `Result` for expected failures and tagged cancellation reasons. Do not use `any`.
Match the current Swift result types and direct process fixtures. Keep UI work outside the
blocking helper path.

## Drift check and commands

Confirm Plans 004 and 005 are complete. Their hook changes are expected drift. The two new
Swift files above do not exist at the baseline.

```sh
git diff 7b74afa -- src/cli.ts src/hooks.ts tests/hooks_test.ts tests/cli_test.ts monitor/Sources/MonitorCore/HookInstaller.swift monitor/Sources/MonitorCore/HookLifecycle.swift monitor/Sources/MonitorChecks/HookInstallerChecks.swift monitor/Sources/MonitorChecks/HookLifecycleChecks.swift monitor/Sources/MonitorChecks/main.swift monitor/Sources/MonitorApp/MonitorModel.swift monitor/Sources/MonitorApp/MonitorApp.swift README.md docs/design.md VERIFICATION.md
```

| Purpose             | Command                                                                | Expected result                                 |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| Type checks         | `deno task check`                                                      | Exit 0.                                         |
| Focused Deno checks | `deno test --permission-set=mci tests/hooks_test.ts tests/cli_test.ts` | All selected tests pass.                        |
| Native checks       | `deno task app:check`                                                  | Native build and checks pass.                   |
| CLI syntax          | `deno task mci --help`                                                 | Help names the optional hook deadline argument. |
| Format              | `deno task fmt:check`                                                  | Exit 0.                                         |
| Lint                | `deno task lint`                                                       | Exit 0.                                         |
| Complete checks     | `deno task verify`                                                     | Deno and native checks pass.                    |

No dependency installation is required. Native checks need the installed Xcode Command
Line Tools. Git's pre-commit hook requires a registered checkout and a responding daemon.
Do not bypass the hook.

## Ordered implementation

### Step 1: Reproduce interrupted restoration

Use `setupHookWith` and the existing controlled capability fixtures. Request cancellation
after workflow creation, ignore-file mutation, configuration mutation, and extension
enablement. Assert exact restoration before the result resolves.

Add a native installer fixture that traps TERM and starts a controlled helper. Keep the
helper pending until a test gate releases restoration. Require no installer result before
that release and no surviving helper after completion.

Use short injected deadlines and controlled gates. Keep each new test below one second. Do
not wait for the production deadline or edit a real repository outside its fixture. The
new cancellation tests must fail against the baseline.

### Step 2: Give hook commands one cancellation context

Add an optional cancellation context to public hook setup and installation options. The
context contains an `AbortSignal` with a tagged timeout, SIGINT, or SIGTERM reason. Add
optional operation options after the current arguments of `installHookWith` and
`installHook`. Extend `HookSetupOptions` for setup. Forward the context through
`installHookWithPolicy`.

Add an optional `--timeout-ms <value>` argument to both hook CLI routes. Keep existing
command forms valid.

Register SIGINT and SIGTERM handlers before hook work begins. Start one CLI timer from the
supplied deadline or the existing default. Validate its value as a positive safe integer
within the existing maximum. Remove listeners and timers after cleanup.

Pass one tagged cancellation context through setup and inner installation. Do not abort an
active Git or Homebrew helper. Keep helpers under their existing bounded capture policy.

Run type checks and focused Deno checks. Require argument errors to occur before mutation.

### Step 3: Make cancellation use restoration paths

Check cancellation before mutation, after each completed mutation, and immediately before
commit. Track generated files, ignore changes, configuration changes, and Git settings
with the existing restoration evidence.

On cancellation before commit, perform all required restoration attempts in reverse order.
Restoration commands must ignore the cancelled forward signal. Preserve concurrent-edit
checks and never replace a user's later file edits.

Handle cancellation after extension enablement but before hook-path configuration. Restore
the extension and configuration as the current failure path does. Let successful final
hook-path configuration commit the transaction.

Return cancellation with exit 130 or 143 for the corresponding signal. Return timeout with
exit 124. Include restoration failures in stderr. Return exit 0 after commit, even when a
late cancellation request arrives.

Run focused Deno checks. Require exact restored bytes and settings at every precommit
checkpoint. Require success after the final commit checkpoint.

### Step 4: Wait for transactional CLI exit in the monitor

Split installation execution from `runBounded`. Keep `runBounded` for read-only
inspection. Pass the existing deadline through the new CLI argument during installation.

On task cancellation, send SIGTERM once. Then wait for the installer exit. Do not apply
the current 100-millisecond SIGKILL escalation to installation. Do not kill installation
when diagnostic output exceeds the monitor's display budget.

Capture installation output in private files. Read a bounded diagnostic tail after exit
and remove the files after readers close. Preserve timeout and restoration details in the
Swift error. Report success when the CLI confirms commit with exit 0.

The new argument protects compatibility with an older packaged CLI. That CLI must reject
the unsupported argument before mutation. Do not silently retry without the argument.

Run native checks. Require cooperative cancellation to wait for the helper and restoration
gate. Require older-CLI refusal and unchanged inspection timeout behavior.

### Step 5: Drain cancelled installations and normal Quit

Add a small owned-task lifecycle in `HookLifecycle.swift`. Cancelled installation tasks
remain retained until their completion handshake. Expose cancellation and drain operations
for public native checks.

Integrate the lifecycle with `MonitorModel`. Daemon loss, repository removal, and path
changes request cancellation without discarding tasks that still run cleanup. Prevent a
second installation while the first transaction remains active.

Retain restoration diagnostics when a cancelled task finishes. A removed repository must
not receive stale row updates. Surface unresolved restoration through the existing model
error fields, even when the repository row no longer exists.

Coordinate normal termination through the application delegate. Return deferred
termination while owned installations drain. Reply to the termination request after the
handshakes complete. Preserve the current Quit button's call to normal application
termination.

Run native checks. Require delayed exit, task retention, and no duplicated installer
during cleanup. Confirm that an app without active installation can quit immediately.

### Step 6: Document and commit

Document that cancellation completion includes bounded active-helper waiting and rollback.
Do not claim a fixed whole-command latency. Record the forced-termination limit and the
older-package refusal behavior.

Run complete checks. Record reproduction results and update the index before the local
commit. Keep any temporary demo or recording under gitignored `demos/`.

## Test cases and done criteria

Cover cancellation before mutation, after each mutation, during an active helper, during
restoration, and after commit. Cover restoration failure and concurrent file edits. Cover
deadline expiry, older CLI refusal, duplicate installation prevention, and normal Quit
during cleanup.

Completion requires the CLI result to follow commit or completed restoration attempts. No
helper started by the cancellation fixture may survive its completion handshake. Normal
Quit must drain installation tasks. Inspection checks must retain their bounds.

Focused and complete checks pass. Only scoped files change. The index records the commit.

## Stop conditions

Stop if a hard parent kill must interrupt rollback. Stop if cancellation must immediately
kill an active helper. Those requirements need another design and measured cleanup
evidence.

Stop if an older CLI accepts the new argument but lacks cooperative cancellation. Stop if
normal macOS termination cannot await the handshake. Stop if a new test needs more than
one second or a script needs more than two minutes. Stop if checks fail twice after local
correction. Report any required file outside the scope.

## Maintenance notes

This route prevents the monitor from abandoning a live transactional CLI. It preserves the
existing native helper cleanup limits. Future forced cleanup needs process ownership,
Git-state reconciliation, and an explicit recovery contract.
