# Repository instructions

GitHub serves only as a repository backup service. Automatic CI runs only through the
local Git pre-commit hook. Do not add GitHub Actions workflows or remote test triggers.

The tracked hook lives at `.githooks/pre-commit` and calls `deno task ci`.
`deno task hooks:install` installs the hook path in the local Git configuration. Manual
checks remain available for diagnosis and release evidence.

CI YAML calls Deno tasks directly. Saved CI logs and status remain gitignored under
`.mci/ci/`. The menu bar monitor app reads those results and opens logs. The monitor must
not start CI or add another automatic trigger.

Work directly on local main. Commit each complete unit locally. Never push; the user owns
repository backups.
