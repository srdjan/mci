# Plan 012: Report final snapshot failures

## Authority and baseline

The user authorized the complete backlog. This unit covers H6, final snapshot publication
failures. The baseline is local `main` at `3d1f46c`.

`complete` and `settleUnstarted` discard the final publication Result. Live status remains
current, but `snapshot.json` can retain active or queued state. The monitor reads that
fallback file when the daemon becomes unavailable.

## Contract and design

Report each failed final publication through the existing `reportDiagnostic` capability.
The native capability writes stderr, which service startup saves in `daemon.log`. Include
the request identifier and final snapshot operation. Do not print workflow or environment
contents. Await publication before resolving the request, as before.

Preserve the recorded result, client result, in-memory latest result, and existing blocks.
Snapshot failure alone does not block repository execution. A later successful publication
repairs the fallback file. Add no retries, protocol fields, or durability claims.

Use one narrow final-publication helper in completed and unstarted settlement. Keep other
publication callers' existing Result handling. Submission rollback retains Plan 011's
policy.

## Scope and ownership

The main agent owns `src/daemon.ts`, documentation, review, checks, and commit. The worker
owns `tests/daemon_race_test.ts` only. Other agents share the checkout. Preserve their
edits. Work directly on local `main`; never push.

## Ordered execution and validation

1. Add a public regression that fails completed publication. Observe missing diagnostics
   before changing source. Preserve the terminal result in the assertion.
2. Add the final-publication helper and use it in both settlement routes.
3. Test completed and queued cancellation faults through native store wrappers.
4. Check live status and the saved fallback file while publication fails.
5. Check request diagnostics, preserved latest results, and repair after later
   publication.
6. Review every changed line. Run focused checks and the complete local gate.

Use disposable files, public socket operations, and controlled capability gates. Each new
test must finish below one second. Keep fixture teardown effective after assertion
failure. The worker runs only new focused tests. The main agent owns authoritative checks
and gate. No script may exceed two minutes without a decision.

## Completion and limits

Both settlement paths report final publication failure. Workflow results remain unchanged.
Live status and fallback differences match the documented policy. Later publication
repairs fallback state. Record completion and create one isolated local commit.

These checks do not establish snapshot durability after power loss. Report required edits
outside scope or a diagnostic policy conflict before expanding source.
