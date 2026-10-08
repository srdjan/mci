# Plan 014: Return doctor health status

## Authority and baseline

The user authorized the complete backlog. This unit covers H8, doctor exit status. The
baseline is local `main` at `0005b90`.

The doctor collects PASS and FAIL strings but returns success. The CLI therefore returns
zero after failed checks. Scripts cannot detect unhealthy installation through exit
status.

## Contract and design

Represent each check with its name, passed state, and detail. Return all checks and
aggregate health. Existing FAIL checks contribute to aggregate failure. Keep existing
check order, optional repository selection, details, and native operations.

Expose a narrow doctor capability for controlled public tests. Native operations retain
their bounded commands and existing filesystem checks. Expose a doctor command helper with
an inspector and output callbacks. The CLI prints every report, returns zero for health,
and returns one if any check fails. Argument errors retain their existing status.

Do not add dependencies, repair operations, or automatic triggers. Document the
exit-status change for existing callers. Do not mutate the user's daemon or installation
in tests.

## Scope and ownership

The main agent owns `src/hooks.ts`, `src/cli.ts`, documentation, review, checks, and
commit. The worker owns `tests/doctor_test.ts` and additions to `tests/cli_test.ts`. Other
agents share the checkout. Preserve their edits. Work directly on local `main`; never
push.

## Ordered execution and validation

1. Retain native doctor operations behind explicit capabilities and structured outcomes.
2. Expose the existing zero-return command behavior through a public test capability.
3. Add a regression with a failed required check. Observe the zero return before
   correction.
4. Return aggregate health status while preserving every printed report.
5. Check healthy, unavailable, blocked, and invalid repository states. Check native CLI
   failure against an isolated unavailable daemon directory.
6. Review every changed line. Run focused checks and the complete local gate.

Use simple capabilities and public commands. Each new test must finish below one second.
Native CLI checks must use isolated temporary state and perform diagnostics only. The main
agent owns authoritative checks and the gate. No script may exceed two minutes without a
decision.

## Completion and limits

Structured reports preserve existing diagnostics. Healthy status returns zero; any FAIL
returns one after printing all reports. Tests and local gate pass. Record completion and
create one isolated local commit. Native checks establish the tested host only.

Report required edits outside scope or a changed definition of health before expansion.
