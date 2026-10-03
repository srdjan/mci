# Hardening and pruning list

## Scope and baseline

This list reviews local `main` at `7b6fa38cd78f46bb9ef7d934b7d3272e2d557585` on
2026-10-03. The review covers the daemon, runner, monitor, installation, checks, and
documentation. This document records proposed work. The review changes no application
code.

The earlier findings in `docs/hardening-audit.md` are fixed. This list does not reopen
those findings.

`deno task verify` passed: 181 Deno tests passed, one platform test was ignored, and 309
native monitor checks passed. Formatting, linting, and type checking also passed.

Two temporary probes confirmed the client cancellation gap and the shutdown gap. The
probes used temporary sockets and directories. They did not change the installed daemon or
monitor.

Effort describes scope, not elapsed time. Small means one boundary and its checks. Medium
means coordinated changes across boundaries. Change risk describes what a fix or removal
can break.

## Ordered backlog

| Order | Item                                                        | Category  | Effect                                                                     | Effort | Change risk | Confidence                        |
| ----- | ----------------------------------------------------------- | --------- | -------------------------------------------------------------------------- | ------ | ----------- | --------------------------------- |
| 1     | H1: Bound submission cancellation                           | Hardening | A silent daemon keeps an interrupted client waiting                        | Medium | Medium      | High: probe and source            |
| 2     | H2: Bound shutdown during path resolution                   | Hardening | A stalled resolution keeps the daemon lock held during shutdown            | Medium | Medium      | High: controlled probe and source |
| 3     | H3: Report hook rollback failures                           | Hardening | Installation can leave changed configuration without a recovery diagnostic | Small  | Low         | High: source                      |
| 4     | H4: Bound captured command output                           | Hardening | A noisy helper command can exhaust memory before its timeout               | Medium | Medium      | High: source mechanism            |
| 5     | H5: Preserve a matching archive and formula                 | Hardening | A failed package build can leave mismatched release artifacts              | Medium | Medium      | High: source                      |
| 6     | H6: Keep the source installer backup until startup succeeds | Hardening | A failed startup leaves the replacement installed without the previous app | Medium | Medium      | High: source                      |
| 7     | P1: Remove the unused direct CI logger                      | Pruning   | Tests maintain a logger that the current CLI does not call                 | Medium | Low         | High: caller search               |
| 8     | P2: Remove the unused monitor status decoder                | Pruning   | Checks maintain the old status contract beside the daemon contract         | Medium | Medium      | High: caller search               |
| 9     | P3: Archive completed plans and reconcile evidence          | Pruning   | Historical instructions describe removed components as current work        | Small  | Low         | High: source                      |

## Hardening details

### H1: Bound submission cancellation

Evidence: `src/client.ts:105-125` sends cancellation but closes the socket only when that
send fails. The response loop has no deadline. `src/cli.ts:56-81` waits for this client
after SIGINT, SIGTERM, or parent death.

When a daemon accepts the connection but sends no response, cancellation does not release
the client. A Git hook can therefore remain blocked after an interruption.

The probe aborted at 50 ms. At the 300 ms observation, the signal was aborted and the
submission remained pending. Closing the server connection released the submission. These
values describe the probe, not a proposed timeout policy.

The proposed fix adds an acceptance deadline and a bounded wait after cancellation.
Cancellation handling must start before the initial request write. A completed
cancellation send must not depend indefinitely on a result response. The fix must preserve
ordinary job execution and queue waits.

Verification uses a temporary daemon socket that reads requests but sends no response.
Checks cover cancellation before acceptance, cancellation after acceptance, and an
ordinary long-running job. Timeout values need an explicit policy; this review does not
invent them.

The change risk concerns terminal delivery and log draining during normal cancellation. A
client timeout must report uncertain completion when the daemon gives no result. Blocked
terminal writes need a separate boundary; this item addresses socket waits.

### H2: Bound shutdown during path resolution

Evidence: `src/daemon.ts:552-564` awaits path resolution without a cancellation boundary.
`src/daemon.ts:725-759` keeps that wait inside a connection handler.
`src/daemon.ts:1183-1200` closes sockets, then awaits all handlers before releasing the
daemon lock.

When path resolution stalls, closing the socket does not release the resolution wait.
Daemon shutdown therefore waits and retains its lock. A later daemon cannot acquire that
lock while the old daemon remains alive.

A controlled `resolvePath` capability held one resolution. `close()` remained pending at
the 300 ms observation and completed after the capability released its promise. This probe
proves the dependency. It does not reproduce a stalled native filesystem.

The proposed fix adds a shutdown cancellation boundary around path resolution. Shutdown
must prevent a late resolution from accepting work or writing state. The fix must retain
request order for each path and concurrency across repositories.

Verification holds the resolver, closes the daemon, and checks lock and socket cleanup.
The check then releases the resolver and confirms that no late request starts. The change
risk concerns late continuations that could write after shutdown.

### H3: Report hook rollback failures

Evidence: `src/hooks.ts:139-149` discards the result of configuration restoration.
`src/hooks.ts:406-429` also discards Git rollback results after hook configuration fails.

When both installation and rollback fail, the returned error names only the installation
failure. The repository can retain a changed `deno.json` or `extensions.worktreeConfig`
setting without a diagnostic that identifies the remaining change.

The proposed fix returns restoration results and combines them with the primary failure.
The error must name the affected file or Git setting and the required recovery action.

Verification injects a hook configuration failure and a separate rollback failure through
`installHookWith`. A second check covers failed restoration of `deno.json`. The change
risk is low because successful installation behavior can remain unchanged.

### H4: Bound captured command output

Evidence: `src/command.ts:9-12` limits capture time and reaping time but not captured
bytes. `src/command.ts:52-73` stores every chunk and then allocates a combined buffer.

When a helper command produces large output before its deadline, captured data grows
without a byte limit. A timeout therefore does not bound memory use. Helper commands
include process inspection, hook installation, and monitor installation.

The proposed fix adds limits for stdout and stderr. Reaching a limit must stop capture,
terminate the direct child, and retain a clear diagnostic. Limits need caller-specific
requirements and measurements.

Verification uses a short command that exceeds a selected test limit. Checks cover
termination, reader cleanup, and a stable error. Ordinary helper output must still remain
available for diagnosis.

The mechanism is confirmed by source inspection. This review does not reproduce memory
exhaustion or claim its operational frequency. The change risk concerns truncated
diagnostics and cleanup after a capture limit.

### H5: Preserve a matching archive and formula

Evidence: `scripts/package.ts:130-132` selects stable archive and formula paths.
`scripts/package.ts:214-227` writes the archive first, then computes its checksum and
writes the formula directly. `tests/package_test.ts` checks formula text only.

When archive creation, checksum calculation, or formula writing fails, prior artifacts can
become partial or inconsistent. A same-version rebuild can leave a new archive beside a
formula that contains the old checksum.

The proposed fix prepares both artifacts under temporary names and validates both before
publication. Publication needs rollback or one switched directory reference; two separate
renames do not form one atomic transaction.

Verification starts with a matching prior archive and formula. Injected failures after
archive creation must leave the prior pair usable. A successful publication must leave the
formula checksum equal to the archive checksum.

This review does not run a package failure probe or rebuild the package. The change risk
concerns stable local archive paths and the Homebrew formula that refers to them.

### H6: Keep the source installer backup until startup succeeds

Evidence: `scripts/install-monitor.ts:125-151` removes the previous bundle after the
replacement move. `scripts/install-monitor.ts:222-232` registers the repository, opens the
app, and checks startup after that removal.

When registration, app opening, or startup detection fails, the installer returns an error
after it deletes the previous bundle. The previous working app cannot be restored through
that backup.

The source installer remains an active development command in `deno.json:20` and
`README.md:213-218`. It is not dead code. The packaged installer already retains its
backup through later checks in `src/install.ts:309-354`.

The proposed fix retains the backup until source installation succeeds. Failures after
replacement must restore and reopen the previous owned bundle. Restoration failures must
identify the retained backup location.

Verification injects registration, opening, and startup failures after replacement. Checks
confirm that the previous bundle remains recoverable and that foreign bundles remain
unchanged.

The change risk concerns app shutdown, replacement, and reopening. A shared installation
transaction is a possible follow-up, but removing the development command requires a
separate decision about its continued use.

## Pruning details

### P1: Remove the unused direct CI logger

Evidence: `src/ci.ts` contains 499 lines. Only `tests/ci_test.ts:1` and
`tests/monitor_fixtures_test.ts:1` import this module. The current CI path calls `submit`
in `src/cli.ts:63-71` and executes through the daemon.

The old logger maintains another lock, status writer, output drain, and cancellation path.
Its tests exercise a mechanism outside the current CLI path.

The proposed removal deletes `runLoggedCi` and checks that only cover this unused logger.
It retains the daemon parent-death check in `tests/ci_test.ts:41-145` and moves that check
to a current CLI or daemon test file.

That check currently calls the old `runShell` helper at `tests/ci_test.ts:133`. The
proposed change replaces that assertion with a second daemon submission that confirms
workspace reuse after cancellation.

Removal of the old status decoder follows the monitor pruning item below. The daemon must
retain legacy status import in `src/daemon-store.ts:523-557` and legacy registry import in
`src/daemon-store.ts:393-409`.

Verification checks the import graph and runs `deno task verify`. Current CLI checks must
continue to cover success, failure, SIGINT, parent death, and saved output. No reduction
in elapsed test time is claimed; that needs measurement.

### P2: Remove the unused monitor status decoder

Evidence: `monitor/Sources/MonitorApp/MonitorModel.swift:103-126` consumes daemon
snapshots. `CiStatus`, `decodeStatus`, `readCiStatus`, and `StatusError` have callers only
in legacy checks.

The old contracts reside in `monitor/Sources/MonitorCore/CiStatus.swift` and
`monitor/Sources/MonitorCore/MonitorError.swift`. Their checks reside in
`monitor/Sources/MonitorChecks/DecodeChecks.swift`, `tests/monitor_fixtures_test.ts`, and
`tests/fixtures/monitor/decode/`.

The proposed removal deletes the unused status types, decoders, file reader, and checks.
It moves `parseTimestamp` to a retained utility and keeps its calendar checks.
`DaemonProtocol.swift` and `DisplayState.swift` still call that utility.

The removal must retain daemon snapshot fixtures, snapshot checks, log reader checks, and
display checks. The removal must also retain legacy import in the daemon store.

Verification runs `deno task verify` and checks every remaining monitor caller. The change
risk concerns accidental removal of timestamp parsing or current fixture coverage. A lower
check count alone does not establish equivalent coverage.

### P3: Archive completed plans and reconcile evidence

Evidence: `docs/ci-monitor-plan.md:5-19` still directs SwiftBar installation and the old
CI logging adapter. `docs/hardening-worklog.md:15-39` calls that work active. The current
product uses the native monitor and shared daemon.

`docs/hardening-fix-plan.md:240-244` records the snapshot completion race as outside
scope. `docs/hardening-audit.md:76-80` records its later fix. `VERIFICATION.md:3-7` calls
an older 155-test run final. The current baseline passes 181 Deno tests and 309 native
checks.

The proposed change marks completed plans and worklogs as historical or moves them to an
archive. Current design and operation instructions remain in `docs/design.md` and
`README.md`.

The evidence record must separate the current source baseline from earlier package
installation evidence. This review does not rebuild or reinstall the package. Historical
measurements and accepted decisions must remain available.

Verification checks documentation links and matches current commands to `deno.json`. The
change risk is low if the archive preserves evidence and redirect links.

## Areas to retain and limits

The current checks cover strict IPC decoding, frame limits, queue order, cancellation
ownership, recovery, durable writes, and spool retention. This review found no reason to
remove those checks.

Legacy import remains a supported migration path. `latest.log` remains a documented
interface. `status.json` projection also remains documented; removing that projection
requires a compatibility decision.

The source monitor installer remains documented. Consolidating its transaction with
packaged setup can reduce duplicated behavior. This review does not classify the source
installer as unused.

File size alone does not justify splitting `daemon.ts`. Arbitrary trusted commands,
advisory locks, and best-effort process recovery remain accepted product boundaries. The
review proposes no hosted CI, new automatic trigger, or dependency migration.

Queue capacity, connection capacity, and maximum log growth need measurement before new
limits are proposed. The review establishes no safe numerical capacity.

Power-loss durability, minimum macOS support, Intel execution, VoiceOver behavior, and
startup at the next login retain their existing evidence limits.

## Next action and ownership

The repository maintainer owns selection of the next implementation unit. The recommended
first unit bounds submission cancellation, with shutdown cancellation reviewed next.

Each accepted unit needs its own checks and local commit on `main`. The repository
maintainer owns pushes and repository backups.
