# Hardening and pruning list

## Scope and baseline

This list reviews local `main` at `7b6fa38cd78f46bb9ef7d934b7d3272e2d557585` on
2026-10-03. The review covers the daemon, runner, monitor, installation, checks, and
documentation. This document records proposed work. The review changes no application
code.

Earlier audit findings are fixed. `VERIFICATION.md` records them, and `docs/design.md`
describes the resulting behavior. This list does not reopen those findings.

`deno task verify` passed: 181 Deno tests passed, one platform test was ignored, and 309
native monitor checks passed. Formatting, linting, and type checking also passed.

H1 to H5 shipped in commits 85480a0, 17c1b48, 4f195c7, 13cae87, and fd13acb. H6 shipped
after them. `VERIFICATION.md` records each.

Effort describes scope, not elapsed time. Small means one boundary and its checks. Medium
means coordinated changes across boundaries. Change risk describes what a fix or removal
can break.

## Ordered backlog

| Order | Item                                         | Category | Effect                                                             | Effort | Change risk | Confidence          |
| ----- | -------------------------------------------- | -------- | ------------------------------------------------------------------ | ------ | ----------- | ------------------- |
| 1     | P1: Remove the unused direct CI logger       | Pruning  | Tests maintain a logger that the current CLI does not call         | Medium | Low         | High: caller search |
| 2     | P2: Remove the unused monitor status decoder | Pruning  | Checks maintain the old status contract beside the daemon contract | Medium | Medium      | High: caller search |

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
retain legacy status import in `src/daemon-store.ts:533-557` and legacy registry import in
`src/daemon-store.ts:393-409`.

Verification checks the import graph and runs `deno task verify`. Current CLI checks must
continue to cover success, failure, SIGINT, parent death, and saved output. No reduction
in elapsed test time is claimed; that needs measurement.

### P2: Remove the unused monitor status decoder

Evidence: `monitor/Sources/MonitorApp/MonitorModel.swift:96-128` consumes daemon
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

## Areas to retain and limits

The current checks cover strict IPC decoding, frame limits, queue order, cancellation
ownership, recovery, durable writes, and spool retention. This review found no reason to
remove those checks.

Legacy import remains a supported migration path. `latest.log` remains a documented
interface. `status.json` projection also remains documented; removing that projection
requires a compatibility decision.

The source monitor installer remains documented. Consolidating its transaction with
packaged setup can reduce duplicated behavior. The two installers differ after a failed
fresh install: setup removes the new app, while the source installer keeps it. This review
does not classify the source installer as unused.

File size alone does not justify splitting `daemon.ts`. Arbitrary trusted commands,
advisory locks, and best-effort process recovery remain accepted product boundaries. The
review proposes no hosted CI, new automatic trigger, or dependency migration.

Queue capacity, connection capacity, and maximum log growth need measurement before new
limits are proposed. The review establishes no safe numerical capacity.

Power-loss durability, minimum macOS support, Intel execution, VoiceOver behavior, and
startup at the next login retain their existing evidence limits.

The earlier manual record did not establish exact update latency, interrupted-state
latency, deleted-watch recovery, or picker cancellation.

Whether macOS returns a transient `accept()` error such as ECONNABORTED needs measurement.

## Next action and ownership

The repository maintainer owns selection of the next implementation unit. H1 to H6
shipped. The maintainer selects the next unit from P1 and P2.

Each accepted unit needs its own checks and local commit on `main`. The repository
maintainer owns pushes and repository backups.
