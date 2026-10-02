# Local CI monitor plan

## Goal and settled scope

Save pre-commit CI output and show its latest result in SwiftBar. Install and configure
SwiftBar on this Mac. Keep GitHub only as a repository backup service. Automatic CI starts
only through the Git pre-commit hook. The monitor reads results and opens logs; it never
starts CI. Preserve version 0.1.1 and the existing process recovery behavior.

## CI execution and records

The hook calls `deno task ci`. That task runs a Deno logging adapter. The adapter launches
the source CLI directly through `cliSourceArgs` to execute `ci/local-ci.yml`. The YAML
calls `deno task verify` directly. Remove the unused `ci/check.sh` wrapper.

The adapter saves `.mci/ci/latest.log` and atomically updates `.mci/ci/status.json`. The
status contains version 1, state, logger PID, logger identity, start time, finish time,
and exit code. Logger identity contains the native process start text and command. State
is running, pass, fail, or cancelled. The log remains local and gitignored.

A permanent file lock excludes competing writers. Publish running status before replacing
the log with a private new file. Reject log symlinks and preserve other hard links.
Preserve nonzero child exit codes. A cancelled child that exits zero returns the
interruption code.

The adapter streams stdout and stderr to the saved log and the invoking terminal. It
launches the CLI with parent supervision enabled. It forwards SIGINT and SIGTERM and
monitors its own task parent. Parent death uses the existing CLI cancellation path.
Expected filesystem and process failures remain Result values.

## Menu bar and installation

The monitor displays mci status and the last run time. Its menu offers Open log, Open
repository, and Refresh. A running record with an absent or changed logger identity
displays interrupted. Legacy completed records remain readable.

Legacy running records with live PIDs display an error because their identity is
unavailable. Missing state displays no runs; invalid state displays an error. Menu values
must not interpret log text as commands or SwiftBar markup.

The installer generates one executable plugin with absolute Deno and repository paths. The
plugin enters the quoted repository path before using the relative read grant. This order
supports commas and shell punctuation without broader process permission.

Use SwiftBar's existing plugin directory when present. Otherwise use a dedicated directory
under the user's Application Support directory, outside SwiftBar's internal plugin cache.
Do not overwrite unrelated plugins or preferences. Root owns app installation and startup.

## Ownership and order

The CI worker owns `src/ci.ts`, `scripts/ci.ts`, and `tests/ci_test.ts`. The monitor
worker owns its monitor, installer, and focused tests after the status contract is ready.
Root owns tasks, hook integration, YAML, wrapper removal, instructions, documentation, app
configuration, actual diff review, verification, and local commits.

## Verification and completion

Public tests cover saved stdout and stderr, success, exit failure, launch failure, writer
exclusion, cancellation, linked log preservation, status publication failure, and task
parent death. Monitor tests cover no runs, running, pass, fail, interrupted, invalid
state, changed identities, and paths with commas and shell punctuation. Use native
commands and small records. Check installation with a temporary plugin directory before
configuring the real app.

Run the local YAML through the hook and confirm its saved result and output. Check the
menu output and the installed app's plugin execution. Run required formatting, linting,
type checking, and tests through the final pre-commit hook. Review the changes
independently before committing them on local main. Never push.
