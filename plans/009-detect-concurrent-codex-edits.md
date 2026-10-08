# Plan 009: Detect concurrent Codex configuration edits

## Authority and evidence

The user authorized all numbered hardening and pruning items, with separate validation.
This unit covers H3, concurrent Codex configuration edits. The baseline is local `main` at
`2278de8`. Plan 008 preserves configuration permissions and remains a required contract.

`src/codex.ts` reads configuration through `readConfig`, merges handlers, and calls
`writeAtomic`. The read retains a parsed object and mode, but no original bytes or
identity. The writer renames a temporary file without checking the current destination. A
concurrent foreign handler can therefore disappear. Existing public CLI tests check static
merging and repeated installation, but do not inject an edit between read and replacement.

## Contract and design

Installation must detect changed input before replacement. Retain original bytes and
available identity metadata, including device, inode, size, modification time, and mode.
Represent absence separately from an existing regular file. Parse the captured bytes once,
with the existing JSON acceptance rules. Retain Plan 008's mode mask.

Stage the new content privately. Immediately before rename, compare the destination with
the captured input. Refuse changed bytes, changed identity, changed mode, removal, or a
new file after an absent read. Reject a nonregular file or symbolic link. An inspection
failure must return a diagnostic without replacing the destination. Clean up the staged
file on refusal. Diagnostics must not print configuration contents.

Expose `installCodexHooksWith` through a small configuration capability. Provide native
read and replacement operations so tests can wrap replacement with a controlled edit, then
call the real guarded writer. Keep capability inputs and snapshot types explicit. The
existing CLI uses the native capability and keeps its arguments and exit codes. Repository
validation and command selection retain their current behavior.

The shared atomic writer can accept an optional pre-replacement check. Notification state
writes keep their existing behavior. Alternatively, a narrow configuration writer can
reuse staging without changing unrelated callers. Do not introduce locks or retries.

The check detects changes observed before rename. Separate inspection and rename do not
exclude an arbitrary writer after the check. Identical rewrites can evade incomplete host
identity metadata. Parent directory replacement and same-user interference retain their
existing limits. Do not claim atomic comparison and replacement.

## Scope

Source ownership covers `src/codex.ts` and `tests/codex_test.ts`. Documentation covers
this plan, `plans/README.md`, `plans/hardening-pruning-list.md`, `docs/design.md`, and
`VERIFICATION.md`. The main agent owns integration, review, checks, and the local commit.
Workers own source and test changes only.

Keep hook trust, foreign handlers, recognized handler replacement, Result errors, and
permission preservation. Do not modify daemon protocols, hook task installation,
dependencies, or notification policy. Work on local `main`; never push.

## Ordered execution

1. Make the current installation route testable through the configuration capability. Add
   a public regression that edits a foreign handler before replacement. Observe the
   baseline overwrite before adding the guard.
2. Capture bytes and identity during the original read. Compare the staged replacement
   against the current input immediately before rename. Retain expected failures as
   Results.
3. Add checks for concurrent creation, removal, identical bytes with changed identity,
   changed mode, and failed inspection. Require preserved destination and private stage
   cleanup.
4. Keep existing CLI merging, rejection, permissions, and repeated installation checks.
5. Review every changed line. Run focused tests, type checks, lint, and the local gate.
   Record completion before the unit's local commit.

## Validation

Use real disposable files and simple capability wrappers. Do not change process-global
filesystem functions or depend on watcher timing. Each new test must finish below one
second. Run the smallest regression before the full selected suite.

| Check         | Command                                              | Expected result            |
| ------------- | ---------------------------------------------------- | -------------------------- |
| Focused tests | `deno test --permission-set=mci tests/codex_test.ts` | All selected tests pass.   |
| Type checks   | `deno task check`                                    | Exit 0.                    |
| Lint          | `deno task lint`                                     | Exit 0.                    |
| Formatting    | `deno task fmt:check`                                | Exit 0.                    |
| Complete gate | Local `git commit` with the configured hook          | All five local steps pass. |

The main agent runs authoritative validation. A worker runs only focused self-checks and
makes no index changes or commits. No dependency installation is required.

## Completion and stop conditions

The public regression first reproduces lost input, then proves refusal and retained
foreign content. Creation, removal, identity, mode, and inspection checks pass. Existing
contracts and the local gate pass. The index records completion and the unit has one local
commit.

Reconcile changed source evidence before editing. Report any need for atomic exclusion,
another module, or a new dependency. Report missing tools. Request a decision before a
script exceeds two minutes. Report a correction that fails twice.
