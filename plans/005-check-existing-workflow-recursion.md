# Plan 005: Check defined task dependencies in existing workflows

## Status and authority

This plan covers audit finding 4: existing workflows bypass checks for indirect task
recursion. The user selected this plan on 2026-10-06. Implementation remains pending.

Priority is high. Effort and change risk are medium after checking compatibility tests.
Confidence is high. Plan 004, task option parsing, is a prerequisite. The source baseline
is local `main` at `7b74afa`.

The executor owns implementation, checks, and one local commit. The maintainer owns
backups. Work on local `main`; do not push or create a branch.

## Problem and evidence

`src/hooks.ts:915-927` traverses task dependencies only when setup generates a workflow.
For an existing workflow, setup checks direct commands only. `installHookWithPolicy` makes
the same direct check at `src/hooks.ts:555-557`.

The generated-workflow branch at `src/hooks.ts:917-918` contains the current graph check:

```ts
const verified = validateTasks(tasks, selectedStandardTasks);
if (!verified.ok) return verified;
```

The audit created an existing workflow that runs `deno task test`. The repository defined
`test` as `deno task mci:ci`. Public `setupHookWith` accepted installation and added the
managed `mci:ci` task.

The resulting task can submit CI while its parent request owns the same repository queue.
The parent waits for the queued request. The queued request cannot start until the parent
finishes. The setup probe confirmed acceptance; this queue effect follows from the FIFO
contract rather than a measured hang.

`tests/hooks_test.ts:437-452` deliberately preserves an existing workflow with undefined
optional `build` and `browser` tasks. This plan must not require every existing workflow
task to exist during installation.

## Scope and boundaries

| File                  | Permitted change                                                |
| --------------------- | --------------------------------------------------------------- |
| `src/hooks.ts`        | Traverse defined root task dependencies for existing workflows. |
| `tests/hooks_test.ts` | Cover setup and explicit installation before mutation.          |
| `README.md`           | Describe the expanded recursion check and its limits.           |
| `docs/design.md`      | Record strict and compatibility validation modes.               |
| `VERIFICATION.md`     | Record public regressions and checks.                           |
| `plans/README.md`     | Update this plan's status.                                      |

Exclude daemon queues, workflow execution, task generation policy, and Swift interfaces.
Preserve existing workflow bytes, unknown-hook refusal, and worktree isolation. Keep
undefined optional tasks accepted in existing workflows.

Use the shared scanner from Plan 004. Inspect root-context invocations only. Treat changed
step directories and opaque configurations according to that plan's boundary. Do not claim
that arbitrary shell code cannot recurse.

Use `Result` for expected failures. Do not use `any`. Reuse `withRepository`, capability
doubles, and snapshot assertions in `tests/hooks_test.ts`.

## Drift check and commands

Confirm Plan 004 is complete in the index. Its parser changes are expected drift. Compare
current source with both plans before editing.

```sh
git diff 7b74afa -- src/hooks.ts tests/hooks_test.ts README.md docs/design.md VERIFICATION.md
```

| Purpose         | Command                                                                | Expected result              |
| --------------- | ---------------------------------------------------------------------- | ---------------------------- |
| Type checks     | `deno task check`                                                      | Exit 0.                      |
| Focused checks  | `deno test --permission-set=mci tests/hooks_test.ts tests/cli_test.ts` | All selected tests pass.     |
| Format          | `deno task fmt:check`                                                  | Exit 0.                      |
| Lint            | `deno task lint`                                                       | Exit 0.                      |
| Complete checks | `deno task verify`                                                     | Deno and native checks pass. |

No dependency installation is required. Git's pre-commit hook requires a registered
checkout and a responding daemon. Do not bypass the hook.

## Ordered implementation

### Step 1: Add refusal regressions for both APIs

Add the audit graph to an existing `ci/local-ci.yml`. Call `setupHookWith`. Add the same
graph to the explicit workflow fixture and call `installHookWith`.

Cover `test -> mci:ci`, `test -> prepare -> mci:ci`, and a defined dependency cycle.
Include literal `mci ci` reached through a defined task. Assert refusal before writes.

Compare workflow, `deno.json`, `.gitignore`, shared Git configuration, and worktree Git
configuration before and after each refusal. The new recursion regressions must fail
against the baseline.

Run the focused command after adding the regressions.

### Step 2: Traverse tasks from selected workflow steps

Add a private selected-job validator that receives the parsed plan and repository tasks.
Scan each step with the parser from Plan 004. Traverse defined dependencies for root
invocations without executing their commands.

Reject a reached `ci`, `mci:ci`, literal `mci ci`, or defined dependency cycle. Track
visiting and visited task names as the current `validateTasks` implementation does. Stop
traversal successfully at an undefined optional task.

Keep generated-workflow validation strict. Missing, empty, or invalid generated-task
dependencies must continue to fail. Reject invalid defined commands reached from an
existing workflow without requiring undefined tasks to exist.

Run type checks. Require the strict and compatibility modes to remain explicit.

### Step 3: Apply validation before mutation

Use the validator in both the existing-workflow setup path and explicit installation. Read
and validate the repository configuration before the first mutation.

Account for each step's `directory`. Do not interpret commands in another directory as
root tasks without evidence. Preserve the configured YAML and all optional steps byte for
byte.

Run focused tests. Require every recursion refusal to leave all captured configuration
unchanged. Require undefined `build` and `browser` acceptance to remain successful.

### Step 4: Check parser integration and document limits

Add same-root option forms from Plan 004 to the indirect recursion tests. Cover foreign
configurations and changed working directories using the documented opaque policy.

Run complete checks. Update documentation, verification evidence, and the index before the
local commit.

## Test cases and done criteria

Cover both public installation APIs, direct and indirect recursion, and dependency cycles.
Cover undefined optional tasks, valid optional tasks, and root task options. Preserve
generated task ordering and existing workflow contents.

Completion requires refusal before mutation for each supported recursive graph. Accepted
existing workflows must preserve their compatibility behavior. Focused and complete checks
pass. Only scoped files change. The index records the local commit.

## Stop conditions

Stop if Plan 004 is incomplete or its parser contract differs from this plan. Stop if
closing the finding requires daemon changes. Stop if compatibility requires rejection of
undefined optional tasks. Stop if checks fail twice after local correction. Report any
required file outside the scope.

## Maintenance notes

Plan 006 changes cancellation around these same validation and mutation boundaries. Keep
the task validator independent of cancellation handling. No new automatic CI trigger
belongs in this work.
