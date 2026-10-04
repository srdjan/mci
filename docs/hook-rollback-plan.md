# Hook rollback diagnostics

## Objective and scope

This unit addresses H3 (report hook rollback failures) in
`plans/hardening-pruning-list.md`. A failed hook installation must preserve its primary
error and report every failed restoration attempt.

The worker owns `src/hooks.ts` and `tests/hooks_test.ts`. The main agent owns this plan,
`README.md`, `docs/design.md`, and `VERIFICATION.md`. Other backlog items remain separate.

## Required behavior

If enabling `extensions.worktreeConfig` fails, the installer attempts to restore the
previous `deno.json` contents. A failed restoration adds its error to the primary error.

If setting the worktree hook path fails, the installer retains its current rollback
sequence. The installer attempts to restore an extension enabled by this installation to
its prior value or prior absence. The installer also attempts to restore the previous
`deno.json` contents.

The installer checks every rollback result. One failed rollback must not prevent the
remaining restoration attempts. The returned error retains the primary failure and all
rollback failures.

Each rollback diagnostic names the affected file or Git setting. It also states the
recovery action. Git recovery distinguishes a prior value from a previously absent
setting. Rollback diagnostics must not print the previous contents of `deno.json`.

Successful restoration adds no rollback failure diagnostic. Successful installation keeps
its current behavior. The installer preserves an extension that was already enabled before
installation.

## Implementation boundary

The existing `Result` type represents restoration failures. The existing atomic file
writer already returns this type. The Git capability already returns its operation result.
The implementation must consume these results instead of discarding them.

The change adds no transaction framework, dependency, public capability, or test-only
export. The change does not install hooks in this checkout or change automatic CI.

## Verification

The worker adds focused public tests before changing production code. The tests call
`installHookWith` in temporary repositories with temporary package fixtures.

A small Git capability injects the primary failure and the Git rollback failure.
Filesystem changes during that callback force atomic restoration to fail. The test retains
the original file outside the failed restoration target and cleans the fixture.

Checks cover file restoration failure after extension enablement failure, extension
rollback failure after hook configuration failure, and combined restoration failures.
Checks distinguish prior extension absence from a prior false value.

Successful rollback checks retain the primary error and confirm that the previous file and
Git configuration remain correct. Existing installation and worktree tests continue to
pass. Each regression must first fail for a missing rollback diagnostic. Successful
rollback checks establish the existing behavior before the change.

## Completion and ownership

The main agent reviews each changed line and runs focused and full checks. An independent
review checks failure aggregation, recovery instructions, and worktree isolation.

The local Git hook runs full verification before the completed unit is committed on
`main`. No commit is pushed, and no installed binary is replaced.
