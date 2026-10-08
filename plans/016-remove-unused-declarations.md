# Plan 016: Remove unused declarations

## Authority and baseline

The user authorized P2, unused declarations, within the complete backlog. The baseline is
local `main` at `731c299`. Source searches found no caller of `protocolVersion`.
Installation never returns `HookInstallError.outputLimitExceeded`.

## Scope and design

Remove only the unused protocol export, the installation error case, and its message
branch. Preserve `CommandError.outputLimitExceeded` and its reachable inspection checks.
Preserve bounded inspection, installation output capture, cancellation, and restoration.

The main agent owns source, documentation, validation, and commit. A read-only worker
reviews callers and the final diff. Agents share the checkout and preserve other edits.
Work directly on local `main`; never push.

## Validation and completion

Search every caller before deletion. Run public protocol and IPC tests, type checks, lint,
and the complete local gate. Existing native checks cover output bounds and cooperative
cleanup. This behavior-preserving deletion needs no mirrored test. Record the evidence and
commit this isolated unit locally. The main agent then owns documentation reconciliation.
Platform and power-loss limits remain unchanged.
