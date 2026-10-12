# Re-base plan

## Result and scope

This plan removes secondary features, compatibility layers, and hardening that do not earn
their cost. It keeps the product core. The baseline is local `main` at `b6e9f89` (v0.4.0).
The baseline has 28,097 tracked TypeScript and Swift lines and 5,611 prose lines. The full
suite passes in 46.4 s with 78.5% line coverage.

Two independent read-only analyses (Fable and codex astra) produced the findings. The
owner accepted six decisions on 2026-10-11. Projected sizes in this plan are estimates.
Each phase measures its real result.

## Core that stays

The product runs one selected job of a small GitHub Actions YAML subset against the
working tree. The Git pre-commit hook triggers it through one per-user daemon. A menu bar
monitor shows results.

The following code carries hard-won correctness. Phases must not change its behavior:

- `src/workflow.ts`: strict YAML subset validation and plan.
- `src/runner.ts`, `src/process.ts`: process groups, deadlines, identity-checked cleanup,
  the UTF-8 process inspection fix, and EPERM zombie-group handling.
- `src/workspace.ts`: the inode-bound workspace lock and run journal.
- The daemon crash-boundary order: accept to journal, `begun` before spawn, terminal
  record, `latest.json` projection, journal cleanup (`docs/design.md:102-115`).
- Per-repository FIFO, concurrency across repositories, cancellation owned by the
  submitting connection, and log retention for connected clients.
- Worker isolation and its strict control-file decoder; strict boundary decoders.
- `src/ipc.ts` framing and `src/client.ts` deadlines.
- Swift display code: `DisplayState.swift`, `Ansi.swift`, `DaemonProtocol.swift`,
  `DaemonClient.swift` (socket part), `PanelView.swift` (non-hook part), snapshot
  fixtures.

## Accepted decisions

1. Codex receipts: rewrite to a minimal adapter (about 300 source lines).
2. Repository hook setup: keep `mci hooks setup` and `mci hooks install`, rewritten to
   about 450 lines. Remove the tracked `.githooks` hook.
3. Nested CI protection: `mci ci` refuses at runtime inside a daemon job of the same
   repository. This replaces the static shell scanner.
4. Remove `snapshot.json`. The monitor reads only the socket `status` operation.
5. Install route: Homebrew only. Remove source `start`, `stop`, and `monitor:install`.
6. Delete `plans/`, `docs/plans/`, and `VERIFICATION.md`. Git history keeps them.

Both analysts also agreed on these cuts: legacy import, the `status.json` and `latest.log`
projections, `mci doctor`, and hook installation inside the monitor.

## Phases

The plan validation (Fable, 2026-10-11) found 17 issues. This text includes the fixes for
all of them.

### P0: Pin the commit gate to the package

The gate daemon on this host is a source daemon, started on 2026-10-06 by
`deno task start`. It starts each worker from the current `src/` files
(`src/daemon.ts:343-345`, `src/runtime.ts:8-19`), and it keeps old code in memory. Source
edits in later phases would reach the gate mid-change. The installed package is v0.3.0 and
the Homebrew service is not running.

Do these steps in this order from `b6e9f89`: run `deno task package`; copy the generated
formula into the local tap; run `deno task stop`; run `brew reinstall local/meeci/mci`;
run `mci setup`; run `mci status`; make one trivial commit. The gate then runs on the
packaged v0.4.0 client, daemon, and worker. Source edits in P1 to P8 cannot reach it.

Verification: `mci --version` prints `0.4.0`. `brew services list` shows `mci started`. No
`src/main.ts daemon` process remains. The trivial commit passes the gate.

Each phase is one or more local commits. Each commit passes the pre-commit gate
(`ci/local-ci.yml`, job `check`). Each phase updates `README.md`, `docs/design.md`, and
`AGENTS.md` for its own changes. Each phase records its measured line counts in its commit
message.

### P1: Delete historical prose

Delete `plans/`, `docs/plans/`, and `VERIFICATION.md`. Remove or rewrite every link to
them in `README.md` and `docs/design.md`. Keep in `docs/design.md` the evidence limits
that matter now: supported hosts, power-loss durability is unconfirmed, and the recovery
limits.

Verification: `grep -rn 'plans/\|VERIFICATION' README.md docs AGENTS.md` prints only this
plan's own lines. `deno task fmt:check` passes.

### P2: Remove legacy import and compatibility projections

In `src/daemon-store.ts`, remove `decodeLegacyRegistry`, the `monitor.json` import,
`decodeLegacyTerminal`, `legacyAdapterActive`, the legacy branch of `readLatest`, the
`.latest-` prefix handling, and the `begun`-absent journal compatibility. Remove the
`status.json` and `latest.log` writes from `projectTerminal`. Remove `atomicCopy` if it
has no remaining caller. Keep `latest.json`.

Remove legacy handling elsewhere: `.mci-hooks` in `src/hooks.ts` and the `ci-summary.sh`
handler in `src/codex.ts`. Delete the test at `tests/install_test.ts:107-123` and the
sentence at `README.md:37-38`. Do not edit `scripts/service.ts` or
`scripts/install-monitor.ts`; P4 deletes them. In Swift, remove `logPath(workspace:)` and
`readLogTail(workspace:)` from `LogReader.swift`. Move their checks to the path-based
reader.

A state file in an old format now produces a clear decode error or an empty state. It
never produces a guessed result. Delete the legacy tests (about 25 in
`tests/daemon_test.ts` and the installer tests). Keep the `latest.json` case of the
projection loop in `tests/daemon_race_test.ts`.

Verification:
`grep -rni 'legacy\|status\.json\|latest\.log\|mci-hooks' src monitor/Sources` prints only
the `latest.log` fixture name in `LogReaderChecks.swift`. Daemon test files pass.
`deno task app:check` passes.

### P3: Remove doctor, accept backoff, and the tracked hook

Remove `mci doctor` (`src/hooks.ts:1428-1620`, CLI routing, `tests/doctor_test.ts`, CLI
doctor tests, docs). Remove the accept-failure backoff in `src/daemon.ts:1176-1225` and
`:1058-1061`. An accept failure now logs and exits 1, and launchd restarts the service.
Keep `firstMessage`. One transient accept error now ends the daemon and cancels the
running job. After P0, launchd restarts the Homebrew service (`keep_alive true`). Rewrite
`docs/design.md:63-71` and `:217-219` to say this.

Remove `.githooks/` and the `deno.json` tasks `hooks:install` and `ci`. Update the docs:
`AGENTS.md:6-14`, `README.md:281-307`, `:475`, and `docs/design.md:350-364`. `AGENTS.md`
keeps that the packaged hook calls `deno task mci:ci`. The `HookMigration` code and its
four tests leave with the P6 rewrite.

Optional owner step: run `git config --local --unset core.hooksPath` in `mci` and
`nextreg-demo`. The worktree value already selects the packaged hook and shadows it.

Verification: `deno task verify` passes. `mci --help` does not list `doctor`. A commit in
this checkout still runs CI through the packaged hook.

### P4: Homebrew-only install

Move `infoPlist` and its XML escaping test from `scripts/install-monitor.ts` into
`scripts/package.ts` and `tests/package_test.ts`. Delete `scripts/service.ts`,
`scripts/install-monitor.ts`, `tests/service_test.ts`, `tests/install_monitor_test.ts`,
and the `deno.json` tasks `start`, `stop`, and `monitor:install`. Delete
`scripts/registry.ts`; its only callers are the two deleted files. Update
`README.md:312-357` and `docs/design.md:35`, `:70`, `:661-699`.

Keep atomic formula publication in `scripts/package.ts`. Keep the packaged installer
rollback in `src/install.ts`. Development uses `deno task mci daemon` in a terminal, with
`MCI_HOME` for isolation. Document that route in `README.md`.

Verification: `deno task verify` passes. `deno task package` succeeds.

### P5: Remove hook installation from the monitor

Delete `HookInstaller.swift`, `HookLifecycle.swift`, `HookStatus.swift`,
`HookInstallerChecks.swift`, and `HookLifecycleChecks.swift`. Remove hook registrations,
inspections, pending installations, retry, and installation-aware termination from
`MonitorModel.swift`, `PanelView.swift`, `DisplayState.swift` (the `hookReadiness` field
and the `HookReadiness` extension), and `MonitorApp.swift`. Update the checks in
`MonitorChecks/main.swift:10-11`, `DisplayChecks.swift:30-45`, and
`SnapshotChecks.swift:105-121`. Quit returns `.terminateNow`. "Add folder" only registers
the repository. The panel tells the user to run `mci hooks setup <path>` once.

Remove `--timeout-ms`, `hookCancellationCode`, and the signal and timer plumbing of
`runHookOperation` from `src/cli.ts`. Remove their tests. Update `AGENTS.md:21-22`,
`README.md:372-437`, and `docs/design.md:567-612`.

Verification: `deno task app:check` passes. `deno task verify` passes. Manual check by the
owner: "Add folder" registers a repository.

### P6: Rewrite hooks.ts

Write `src/hooks.ts` again from this contract. Do not keep the old control flow. Keep
`hookScript` byte-identical: `scripts/package.ts` writes it as the packaged hook, and
validation compares the installed text with it. Keep the exports `hookScript`,
`nativeHookCapabilities`, `installHook`, `setupHook`, `installHookWith`, and
`setupHookWith`. Do not change the `WorkerInput` or worker record shapes.

`mci hooks install <repository> --workflow <file> --job <id>`:

1. Resolve the repository root with Git. Refuse a path that is not a worktree root.
2. Validate the workflow and job with `planWorkflow`.
3. Validate the packaged hook installation (keep `validatePackagedHookInstallation`).
4. Read the effective `core.hooksPath`. If it equals the packaged hooks directory or its
   real path, skip step 6. (`/opt/homebrew/opt/mci` is a symbolic link.) If it names
   another directory, refuse. Otherwise inspect the hooks directory that Git uses now
   (`git rev-parse --git-path hooks`). A new hook path disables every hook in that
   directory, so refuse when it holds any active Git hook (a known hook name, not a
   `.sample` file). The message names each such hook.
5. Add or keep the `mci:ci` task in `deno.json`. Preserve the POSIX permission bits and
   use atomic replacement. Keep a matching existing task unchanged.
6. Run `git config --local core.hooksPath <packaged hooks directory>`.

If step 6 fails, report the error and name the step. A rerun completes the work. There is
no cancellation, no rollback, no `extensions.worktreeConfig`, and no `--replace-pre-push`.
Remove the `--replace-pre-push` flag from `src/cli.ts` and its tests.

`mci hooks setup <repository>`: if `ci/local-ci.yml` is absent, generate it with one step
per defined standard task in the order `fmt:check`, `lint`, `check`, `test`. Require at
least one task. Keep an existing workflow byte for byte. Add `.mci/` to `.gitignore` when
it is absent. Then run install with job `check`.

Nested CI protection replaces the shell tokenizer, `inspectInvocations`,
`recursiveInvocations`, `validateTasks`, and `HookMigration`. Add the socket path to
`DaemonRuntime` from `paths.socket` in `startDaemon`. In `newJob` (`src/daemon.ts:595`),
set `inherited` to
`{ ...request.env, MCI_DAEMON_SOCKET: <socket>, MCI_REPOSITORY_PATH:
<canonical repository path> }`,
with the daemon values last. Do not change `stepEnvironment`. In `mci ci`, before the
receipt starts (`src/cli.ts:411`), compare `servicePaths().socket` with
`MCI_DAEMON_SOCKET`. Also compare `Deno.realPath(Deno.cwd())` without a trailing slash
with `MCI_REPOSITORY_PATH`. Exit 2 with a clear message only when both match. A test
daemon uses another `MCI_HOME` and another socket, so it accepts the submission. Add both
names to `reserved` in `src/workflow.ts:31-33`.

Rewrite `tests/hooks_test.ts` against the contract. Add a public test for the nested
refusal and one for a test daemon inside a job.

Update `README.md:40-71`, `:376-437`, `docs/design.md:418-481`, and `AGENTS.md:10-14`.

Verification: `deno test --permission-set=mci tests/hooks_test.ts tests/cli_test.ts`
passes. `deno task verify` passes. Measure the new `hooks_test.ts` time (baseline 15.7 s).
`deno task mci hooks setup "$PWD"` succeeds without a file change in this checkout,
because the hook path and the `mci:ci` task already match.

### P7: Minimal Codex adapter

Write `src/codex.ts` and `src/ci-receipt.ts` again as one small adapter. Keep these rules
from `docs/design.md:483-556`:

- The CLI selects `MCI_SESSION_ID`, then `CODEX_SESSION_ID`, then `CODEX_THREAD_ID`. No
  session means no receipt.
- Receipts live in `sessions/<sha256 of session>/<uuid>.json` under the service directory.
  Writes use a private temporary file and atomic rename.
- The CLI writes a pending receipt before validation and the final receipt after the
  outcome. The final receipt keeps the request identifier and log path when present.
- `mci codex hook` reads `MCI_SESSION_ID` or the event session identifier only.
- A later success clears matching workspace, workflow, and job failures that finished at
  or before its start. A validation error (kind `error`, code 2) clears on any later
  success in the same workspace and session.
- Session start and prompt submission restore unresolved failure context. `Stop` requests
  continuation, except when `stop_hook_active` is true.
- `PostToolUse` returns `{}`. `codex install` no longer registers it.
- `mci codex install` merges managed handlers into `.codex/hooks.json`. It keeps foreign
  handlers and the POSIX permission bits. It removes managed handlers that are no longer
  managed, such as the old `PostToolUse` handler. A new file uses mode `0644`.
- The receipt schema stays version 1 with the same keys, so the 14 existing session
  directories stay readable. The reader ignores entries that do not end in `.json`. A
  receipt that fails to decode produces one warning and is skipped.

Remove: ordered symlink path identity (use `Deno.realPath` with a raw-path fallback), the
notification state file and its lock, and concurrent-edit detection in `codex install`. A
receipt write failure prints a warning on stderr and does not change the CI exit code.
This changes `src/cli.ts:195-207` and `:411-421`. Rewrite the receipt tests in
`tests/cli_test.ts` at lines 464, 538, 603, 632, and 828. Update `README.md:108-166` and
`docs/design.md:483-556`.

Verification: the rewritten `tests/codex_test.ts` and `tests/ci_receipt_test.ts` pass. A
failing `mci ci` under a session produces one warning from `mci codex hook`.

### P8: Remove snapshot.json

Remove `publish`, `publishJob`, candidate publication before admission and its rollback,
`writeSnapshot`, `snapshotChain`, and `paths.snapshot`. Delete the five snapshot tests
(`tests/daemon_race_test.ts:936`, `:1022`, `:1077`, `:1526`, `:1767`). Do not change the
`WorkerInput` or worker record shapes.

In Swift, remove `snapshotPath` (`DaemonClient.swift:35`), the fallback
(`MonitorModel.swift:232-243`), `readSnapshot(path:)` (`DaemonProtocol.swift:269`), and
`checkSnapshotFileSafety` (`SnapshotChecks.swift:70-77`). Keep `decodeSnapshot(data:)` for
the fixtures. While the daemon is down, the monitor shows "daemon unavailable" with no
rows.

The directory watcher still fires on `requests.json` and `registry.json` writes. Only step
changes lose their signal. Keep `DirectoryWatcher` and the 5 s tick. Add a 1 s tick while
any row is queued or running.

Update `docs/design.md:119-125`, `:172`, `:205`, `:560-565`, and `README.md:372`.

Verification: daemon and CLI test files pass. `deno task verify` passes. Manual: run two
repositories at the same time; `kill -9` the daemon during a job, restart it, and check
that the latest result is INTERRUPTED.

### P9: Install the result

Run `deno task package`, copy the formula into the local tap, run
`brew reinstall
local/meeci/mci`, `brew services restart mci`, and `mci setup`. The
nested-CI refusal and the monitor changes then reach the host.

## Deferred

Replacing the daemon promise chains needs its own specification. `routing` serializes by
path text before the repository is known, and terminal projection writes to repository
volumes that can stall. Persisting only begun requests, spool retention by count, and
`command.ts` byte budgets also stay unchanged. Revisit them after P8 with measurements.
