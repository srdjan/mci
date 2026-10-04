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
after them. P1 shipped after H6. P2 shipped after P1. `VERIFICATION.md` records each.

Effort describes scope, not elapsed time. Small means one boundary and its checks. Medium
means coordinated changes across boundaries. Change risk describes what a fix or removal
can break.

## Ordered backlog

No open backlog items remain.

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

The legacy `status.json` import in `src/daemon-store.ts` has no direct test before or
after the P2 change.

Whether macOS returns a transient `accept()` error such as ECONNABORTED needs measurement.

## Next action and ownership

All listed units shipped: H1 to H6, P1, and P2. The repository maintainer owns any new
item.

Each accepted unit needs its own checks and local commit on `main`. The repository
maintainer owns pushes and repository backups.
