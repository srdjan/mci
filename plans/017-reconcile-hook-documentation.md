# Plan 017: Reconcile hook documentation

## Authority and baseline

The user authorized the documentation follow-up with the complete backlog. The baseline is
local `main` at `8d60d14`. All eight hardening items and three pruning items are
committed. The last code gate passed 453 Deno tests and 339 native checks, with one
platform test ignored.

## Contract and scope

Git selects one effective pre-commit hook. The tracked source hook calls `deno task ci`.
The packaged hook calls `deno task mci:ci`. This checkout currently selects the packaged
hook through `.git/config.worktree`. Both tasks select `ci/local-ci.yml`, job `check`.
Both paths use the local daemon. Neither adds another automatic trigger.

Correct README and design claims that assume the tracked hook is always active. Clarify
repository instructions for future agents. Keep source-hook installation available.
Replace stale execution status with one compact index and worklog. Preserve individual
plans as records of authorized execution. Keep the backlog's evidence limits.

The main agent owns documentation and checks. A read-only worker reviews factual drift and
links. Agents share the checkout and preserve other edits. Change no source, task, hook,
configuration, dependency, or trigger. Work on local `main`; never push.

## Validation and completion

Compare documentation with both hook files, Deno tasks, and effective Git configuration.
Run link checks, formatting, and the configured local gate. Review every changed line.
Record completion, commit locally, and confirm the checkout is clean. The maintainer owns
repository backups and any additional platform or release acceptance checks.
