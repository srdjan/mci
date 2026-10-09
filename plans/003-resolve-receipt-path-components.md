# Plan 003: Resolve receipt paths in filesystem order

## Status and authority

This plan covers audit finding 3: receipt identity can name the wrong workflow after a
symlink and `..`. The user selected this plan on 2026-10-06. Implementation is complete in
local commit `4deb5b2`. The [plan index](README.md) owns current status.

Priority is high. Effort and change risk are medium. Confidence is high. No other plan is
a prerequisite. The source baseline is local `main` at `7b74afa`.

The executor owns implementation, checks, and one local commit. The maintainer owns
backups. Work on local `main`; do not push or create a branch.

## Problem and evidence

`src/ci-receipt.ts:299-307` removes `..` before resolving symlinks. `canonicalIdentity`
then resolves the already normalized path. The CLI reads the original workflow path in
`src/cli.ts:95` and `src/cli.ts:283`.

The early normalization at `src/ci-receipt.ts:316` is the critical drift excerpt:

```ts
const candidate = normalizedAbsolute(realWorkspace.value, workflow);
```

The audit created `alias` as a symlink to another directory's child. Reading
`alias/../ci.yml` selected that other directory's workflow. Public `beginReceipt` recorded
the repository's `ci.yml` instead.

`src/codex.ts:62-68` uses workflow identity when clearing failures. A success for the
incorrect recorded path can therefore clear another workflow's failure.

`tests/ci_receipt_test.ts:102-123` preserves a missing workflow's identity beneath an
existing directory symlink. The fix must preserve that behavior and add component-order
coverage. Existing receipts contain no original invocation path, so migration cannot
reconstruct every earlier incorrect identity.

## Scope and boundaries

| File                       | Permitted change                                          |
| -------------------------- | --------------------------------------------------------- |
| `src/ci-receipt.ts`        | Correct canonical workflow identity.                      |
| `tests/ci_receipt_test.ts` | Test symlinks, parent components, and missing targets.    |
| `tests/codex_test.ts`      | Check failure clearing through public hook behavior.      |
| `tests/cli_test.ts`        | Check receipt identity against actual CLI file selection. |
| `docs/design.md`           | Describe resolution and compatibility limits.             |
| `VERIFICATION.md`          | Record checks and reproduction evidence.                  |
| `plans/README.md`          | Update this plan's status.                                |

Exclude receipt schema changes, session selection changes, automatic receipt deletion, and
changes to failure timestamps. Do not change which workflow the CLI executes. Existing
receipts remain readable. Corrected receipts must not rewrite old receipt files.

Use `Result` for expected filesystem failures. Narrow `unknown`; do not use `any`. Use
existing receipt fixtures and public Codex hook subprocesses.

## Drift check and commands

Run the drift check first. Compare changed source against the evidence above before
editing.

```sh
git diff 7b74afa -- src/ci-receipt.ts tests/ci_receipt_test.ts tests/codex_test.ts tests/cli_test.ts docs/design.md VERIFICATION.md
```

| Purpose         | Command                                                                                         | Expected result              |
| --------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| Type checks     | `deno task check`                                                                               | Exit 0.                      |
| Focused checks  | `deno test --permission-set=mci tests/ci_receipt_test.ts tests/codex_test.ts tests/cli_test.ts` | All selected tests pass.     |
| Format          | `deno task fmt:check`                                                                           | Exit 0.                      |
| Lint            | `deno task lint`                                                                                | Exit 0.                      |
| Complete checks | `deno task verify`                                                                              | Deno and native checks pass. |

No dependency installation is required. Git's pre-commit hook requires a registered
checkout and a responding daemon. Do not bypass the hook.

## Ordered implementation

### Step 1: Reproduce the wrong identity through the public API

Create two workflows with distinct contents. Link a repository directory to a child of the
other workflow's directory. Call `beginReceipt` with `alias/../ci.yml`.

Compare its recorded workflow against `Deno.realPath` on the original path. Cover relative
and absolute invocation paths. Keep fixtures under a short private temporary directory.

The new tests must fail against the baseline. Run the focused command after adding them.

### Step 2: Resolve symlinks before parent components

Replace lexical cleanup before filesystem resolution. For an existing workflow, resolve
the original path with `Deno.realPath` before normalization.

For a missing workflow, process components in order. Resolve existing symlink components
before interpreting subsequent `..`. Expand relative symlink targets against the link's
parent. Preserve the unresolved suffix after the deepest resolved component.

Handle dangling symlink targets with the same component order. Detect active symlink
cycles and return an error. Distinguish missing-path errors from permission, I/O, and
not-directory errors. Do not convert those other errors into a guessed identity.

Return the existing workspace and workflow fields. Keep canonical workspace selection and
receipt serialization unchanged.

Run focused tests. Require correct identity for existing paths and stable identity for
supported missing-target repairs.

### Step 3: Check failure clearing and CLI selection

Add a CLI regression with the two distinct workflows. Assert that its receipt identifies
the workflow whose commands actually ran.

Through `codex hook`, show that a passing unrelated workflow leaves the failure
unresolved. Then run the same workflow successfully and require that its failure clears.
Preserve session isolation and the existing start-time ordering rule.

Run focused checks. Require the existing missing-workflow-through-symlink regression to
continue passing.

### Step 4: Document compatibility and commit

Document that old incorrect identities cannot be reconstructed from current receipt
fields. Do not silently rewrite or delete them. A legacy unresolved receipt can require
owner inspection after a corrected run.

Run complete checks. Record observed results and update the index before the local commit.

## Test cases and done criteria

Cover file links, directory links, relative link targets, `.` and `..`, and missing
suffixes. Cover dangling targets before creation, link cycles, and not-directory errors.
Test permission failure only through a deterministic public seam or a supported native
fixture.

Completion requires matching receipt and execution identities. Unrelated success must not
clear a failure. Existing receipt shapes and session rules must remain compatible. Focused
and complete checks pass. Only scoped files change. The index records the local commit.

## Stop conditions

Stop if the fix requires a receipt schema migration. Stop if missing-path identity cannot
remain stable under the documented repair case. Stop if cycle handling requires an
unmeasured traversal limit. Stop if checks fail twice after local correction. Report any
required file outside the scope.

## Maintenance notes

Concurrent filesystem changes can still change path identity between receipt creation and
execution. This plan fixes component ordering. It does not claim atomic file selection or
reconstruct earlier incorrect receipts.
