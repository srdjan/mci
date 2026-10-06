# Repository instructions

GitHub serves only as a repository backup service. Automatic CI runs only through the
local Git pre-commit hook. Do not add GitHub Actions workflows or remote test triggers.

The tracked hook lives at `.githooks/pre-commit` and calls `deno task ci`.
`deno task hooks:install` installs the hook path in the local Git configuration. Manual
checks remain available for diagnosis and release evidence.

CI YAML calls Deno tasks directly. Saved CI logs and status remain gitignored under
`.mci/ci/`. One local daemon serves one user and multiple repositories. Each repository
uses a FIFO queue, while different repositories can run concurrently. Restart interrupts
started work and drops queued work. The daemon retries neither.

The menu bar monitor app reads daemon snapshots and opens saved logs. The monitor must not
start CI or add another automatic trigger.

mci provides general tasks that repositories can select through configuration. Keep
repository-specific commands and task choices in each repository's configuration. Do not
add behavior selected by a repository name or path to mci.

Work directly on local main. Commit each complete unit locally. Never push; the user owns
repository backups.
