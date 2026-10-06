# Automatic repository setup

The user approved migration of nextreg-demo to mci pre-commit CI. The user also requested
automatic migration when a repository enters the menu bar.

## Accepted behavior

The menu bar will call `mci hooks setup <repository> --replace-pre-push`. The chooser will
state that setup replaces the pre-push hook for the selected worktree. The explicit
`hooks install` command will retain its current refusal rules.

Setup will preserve an existing `ci/local-ci.yml` and validate job `check`. If that
workflow is absent, setup will create it from the existing `verify` task. Setup will
refuse a missing, invalid, or recursive verification task. Setup will not start CI. Setup
will add `.mci/` to `.gitignore` when that entry is absent. This entry excludes saved logs
and runtime files from Git and Deno formatting.

Setup can replace repository-owned `.githooks` configuration when no unrelated active
hooks exist. The replacement flag authorizes disabling the existing pre-push hook for the
selected worktree. Setup will leave existing hook files and shared Git configuration
unchanged. Setup will refuse an unknown pre-commit hook or another executable hook. Setup
will retain the stable Homebrew hook path and use worktree-scoped configuration. Setup
will restore generated files and settings when installation fails. Repeated setup will
preserve matching files.

The monitor will retain an installation error across status refreshes. A successful
installation or hook inspection will clear that error.

## Execution and checks

The implementation worker owns the setup command and its Deno behavior tests. The monitor
worker owns installation error state and its native behavior checks. The main agent owns
command integration, documentation, review, checks, packaging, and migration. The main
agent will review every changed line and run focused checks before the full local gate.

The main agent will install the updated local package and monitor. The main agent will
migrate nextreg-demo with the same setup command that the menu bar uses. The main agent
will update nextreg-demo documentation to name pre-commit CI as the automatic trigger. The
main agent will commit only files that belong to these units on local main. The user owns
all pushes.

## Evidence and limits

nextreg-demo has no effective pre-commit hook and no `ci/local-ci.yml`. Its existing
`.githooks/pre-push` runs `act` against `.github/local-ci.yml`. Its `verify` task runs the
repository's complete gate. The existing installer refuses `.githooks` and requires a
workflow before installation. The monitor currently replaces installation errors during
its next hook inspection. Other work is active in nextreg-demo. The migration must exclude
those changes. The complete nextreg-demo gate has a documented duration above two minutes.
The user instructions require confirmation before such a script starts.
