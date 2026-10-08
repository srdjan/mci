# Plan 008: Preserve configuration permissions

## Authority and baseline

The user authorized the complete hardening and pruning list on 2026-10-08. This unit
covers H2, existing file permissions. The baseline is local `main` at `c5fb75d`. Work
stays on local `main`. The main agent owns review, validation, documentation, and the
local commit. The maintainer owns pushes.

## Current evidence

`src/codex.ts` reads existing hook configuration through `readConfig`. That function
already reads file metadata, but returns only the parsed object. Installation supplies
`0o644` to `writeAtomic`, so replacement widens an existing `0600` file.

`src/hooks.ts` reads existing `deno.json` before task installation. Replacement calls
`writeAtomic` without the old mode. `configChange.mode` is null, and restoration also
omits the mode. The temporary file therefore loses the previous permissions.

Both writers already support an explicit mode. The existing Git ignore transaction retains
file metadata and passes the saved mode to its writer.

## Scope and boundaries

Source and test ownership covers `src/codex.ts`, `src/hooks.ts`, `tests/codex_test.ts`,
and `tests/hooks_test.ts`. Documentation ownership covers this plan, `plans/README.md`,
`plans/hardening-pruning-list.md`, `docs/design.md`, and `VERIFICATION.md`.

Preserve existing POSIX permission bits on successful replacement and restoration. Keep an
explicit creation policy for new Codex hook configuration. The hook installer already
requires an existing `deno.json`; do not introduce configuration creation. Unchanged or
rejected configuration must keep its bytes and permissions.

Preserve public signatures, handler merging, cancellation, and rollback diagnostics. Do
not combine concurrent Codex edits, H3, with this unit. Do not promise preservation of
owners, ACLs, extended attributes, or atomic exclusion against other writers. If the host
supplies no POSIX mode, document that evidence boundary.

## Ordered work

1. Add public regressions before source changes. Run a restrictive Codex replacement and a
   restrictive Deno task replacement against the baseline. Record the failures.
2. Retain the Codex mode with the already-read metadata. Pass that mode to the existing
   atomic writer. Preserve the explicit `0o644` policy for a new configuration.
3. Capture the Deno configuration mode before mutation. Pass the saved mode to replacement
   and rollback. Retain the mode in `configChange` instead of null.
4. Check successful replacement, repeated installation, rejected configuration, and late
   rollback failure. Verify the original bytes and permission bits after restoration.
5. Review each changed line. Run focused checks and the configured local pre-commit gate.
   Record completion and limitations before the local commit.

## Validation

The public Codex route is `codex install`. Hook tests use `setupHookWith` and
`installHookWith`, with existing filesystem fixtures and simple Git capabilities. Use
explicit `Deno.chmod` after fixture creation so the host umask cannot alter inputs. Each
new test must finish below one second. Run a small filtered regression first.

| Check         | Command                                                                  | Expected result            |
| ------------- | ------------------------------------------------------------------------ | -------------------------- |
| Focused       | `deno test --permission-set=mci tests/codex_test.ts tests/hooks_test.ts` | All selected tests pass.   |
| Types         | `deno task check`                                                        | Exit 0.                    |
| Lint          | `deno task lint`                                                         | Exit 0.                    |
| Format        | `deno task fmt:check`                                                    | Exit 0.                    |
| Complete gate | Local `git commit` with its configured hook                              | All five local steps pass. |

The main agent runs the authoritative checks. Workers make no Git index changes or
commits. No dependency installation or generator is necessary.

## Completion and stop conditions

The regressions prove permission preservation through public routes. Existing focused
tests and the complete local gate pass. The index records completion. One local commit
contains only this unit.

If source drift changes the stated contract, reconcile the plan before editing. If
preservation requires another module or metadata policy, report the scope change. If a
required command is absent, report the missing command. If a script exceeds two minutes,
request a decision before running it. Report a correction that fails twice.
