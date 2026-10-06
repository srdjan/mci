# Plan 004: Parse Deno task options before task names

## Status and authority

This plan covers audit finding 6: setup rejects a valid task command with an option value.
The user selected this plan on 2026-10-06. Implementation remains pending.

Priority is medium. Effort and change risk are medium after inspection of configuration
options. Confidence is high. No other plan is a prerequisite. Plan 005 requires this
parser. The source baseline is local `main` at `7b74afa`.

The executor owns implementation, checks, and one local commit. The maintainer owns
backups. Work on local `main`; do not push or create a branch.

## Problem and evidence

`src/hooks.ts:148-153` detects direct recursion. `src/hooks.ts:184-191` finds task
dependencies. Both expressions assume that each long option consumes one token.

The dependency loop at `src/hooks.ts:217-218` shows the consumer that needs correct task
names:

```ts
for (const dependency of taskReferences(script)) {
  const checked = visit(dependency, selectedTask);
```

For `deno task --config deno.json lint`, dependency discovery returns `deno.json` as the
task name. `validateTasks` then requires a task with that name and refuses setup.

The audit called public `setupHookWith` with that command and a valid `lint` task. Setup
failed with a missing-task diagnostic for `deno.json`. Running the task with Deno 2.9.7
returned exit 0.

Local `deno task --help` identifies required-value options: `--cwd`, `-c`, `--config`,
`-f`, `--filter`, `-j`, and `--jobs`. It also lists optional-value options, including
`--env-file`, `--lock`, `--node-modules-dir`, and `--frozen-lockfile`.

## Scope and boundaries

| File                  | Permitted change                                                       |
| --------------------- | ---------------------------------------------------------------------- |
| `src/hooks.ts`        | Share task invocation parsing between dependency and recursion checks. |
| `tests/hooks_test.ts` | Check option parsing through public installation APIs.                 |
| `README.md`           | State the supported inspection boundary.                               |
| `docs/design.md`      | Record configuration-context handling.                                 |
| `VERIFICATION.md`     | Record local Deno evidence and checks.                                 |
| `plans/README.md`     | Update this plan's status.                                             |

Exclude complete shell parsing, command execution during validation, new dependencies,
JSONC support, and inspection of foreign task configurations. Do not add repository-name
or repository-path exceptions. Deno tasks remain selected by repository configuration.

Workflow scripts remain trusted commands. Static inspection covers literal invocations at
the command positions currently recognized. It cannot prove that arbitrary shell commands
avoid recursion.

Use `Result` for expected failures. Do not use `any`. Test public behavior rather than
exporting parser internals for tests.

## Drift check and commands

Run the drift check first. Compare changed source against the evidence above before
editing.

```sh
git diff 7b74afa -- src/hooks.ts tests/hooks_test.ts README.md docs/design.md VERIFICATION.md
```

| Purpose          | Command                                              | Expected result                                  |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------ |
| Runtime evidence | `deno --version`                                     | Record the installed version.                    |
| Option evidence  | `deno task --help`                                   | Confirm tested option spellings and value forms. |
| Type checks      | `deno task check`                                    | Exit 0.                                          |
| Focused checks   | `deno test --permission-set=mci tests/hooks_test.ts` | All selected tests pass.                         |
| Format           | `deno task fmt:check`                                | Exit 0.                                          |
| Lint             | `deno task lint`                                     | Exit 0.                                          |
| Complete checks  | `deno task verify`                                   | Deno and native checks pass.                     |

No dependency installation is required. Git's pre-commit hook requires a registered
checkout and a responding daemon. Do not bypass the hook.

## Ordered implementation

### Step 1: Add public option regressions

Call `setupHookWith` with a selected `test` task that invokes `lint` through an explicit
root configuration. Cover `--config deno.json`, `--config=deno.json`, and `-c deno.json`.

Assert successful setup and the expected generated workflow. Add corresponding recursion
cases whose task name is `mci:ci`. Require refusal before repository mutation.

The option-value regression must fail against the baseline. Run the focused command after
adding it.

### Step 2: Share one invocation scanner

Replace separate Deno invocation expressions with one private scanner. Return the literal
task name and configuration context. Use an explicit tagged result for a root invocation
or an opaque invocation.

Consume required option values before selecting the task name. Handle short options, long
options, equals forms, and literal quoted values. Confirm optional-value behavior against
the installed Deno runtime instead of guessing token consumption.

Recognize flags without values separately. Preserve direct literal `mci ci` detection. Use
the scanner in both `recursiveStep` and `taskReferences`.

Run type checks and focused tests. Require both consumers to identify the same literal
task name.

### Step 3: Preserve the configuration boundary

Traverse root tasks for default configuration and explicit root `deno.json`. Treat changed
working directories, foreign configurations, and workspace fan-out as opaque.

Do not require root tasks for an opaque invocation. Preserve acceptance of trusted
commands outside root inspection. Continue rejecting a literal `ci` or `mci:ci` task name
as the existing conservative policy.

Apply this policy to equivalent short and long option forms. Ignore task arguments after
the task name when discovering dependencies. Do not treat printed command text as a new
command merely because it contains `deno task`.

Run public tests with foreign `--config`, `--cwd`, and workspace options. Require no false
root dependency errors and unchanged generated workflow selection.

### Step 4: Record the supported subset

Document literal inspection and opaque configuration contexts. Retain strict validation of
generated tasks and same-root dependencies. Do not claim complete shell validation.

Run complete checks. Update verification evidence and the index before the local commit.

## Test cases and done criteria

Cover required values, optional values, flags, equals forms, quoted values, short options,
task arguments, and direct recursion after options. Cover ordinary printed text and
existing direct `mci ci` refusal cases.

Completion requires successful setup for valid root option forms. Recursion detection must
use the actual task name. Opaque commands must keep the stated compatibility policy.
Focused and complete checks pass. Only scoped files change. The index records the commit.

## Stop conditions

Stop if installed Deno option behavior differs from recorded local help. Stop if a fix
requires a general shell parser or another dependency. Stop if foreign configuration
inspection becomes necessary. Stop if checks fail twice after local correction. Report any
required file outside the scope.

## Maintenance notes

Plan 005 reuses this scanner for existing workflows. Deno option changes can require new
local runtime checks. Commands containing dynamic expansions remain outside complete
static inspection.
