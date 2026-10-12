# mci

A local CI runner for macOS, written in Deno and light functional TypeScript. It reads a
small GitHub Actions YAML subset and runs one selected job against your current working
tree.

One daemon serves all registered repositories for one user. Each repository has a FIFO
queue, while different repositories can run at the same time.

The runner uses trusted local commands and one selected job. The verified host is macOS
26.6 on Apple Silicon. [docs/design.md](docs/design.md) states the remaining evidence
limits.

## Install with a local Homebrew tap

Install Homebrew and Deno. The verified host uses Deno 2.9.7; other Deno versions are
unverified. Make Bash available on `PATH`. The package build also requires the Xcode
Command Line Tools.

Build the package from this checkout. Create the local tap, then copy the generated
formula into the tap.

Package archive names include their full SHA-256 checksum. The generated formula points to
that archive. The packager replaces the formula after it prepares both artifacts. Earlier
archives remain available for copied formulas. The repository maintainer owns archive
removal.

```sh
deno task package
brew tap-new --no-git local/mci
cp dist/tap/Formula/mci.rb "$(brew --repo local/mci)/Formula/mci.rb"
brew install local/mci/mci
mci setup
```

`mci setup` installs and opens `~/Applications/mci Monitor.app`. It starts the Homebrew
service only when the daemon does not answer.

Register each repository. Then configure its managed pre-commit hook.

```sh
cd /path/to/your/repository
mci register "$PWD"
mci hooks setup "$PWD"
```

Hook installation adds the `mci:ci` task to `deno.json`. The task uses the stable Homebrew
binary. Installation then runs `git config --local core.hooksPath` with the absolute hook
directory under the stable Homebrew prefix. Linked worktrees of the repository share that
setting.

Installation refuses when `core.hooksPath` already names another directory. It also
refuses when the current Git hooks directory holds an active hook, because the new hook
path disables every hook in that directory. The message names each hook. Installation has
no rollback. If the `git config` step fails after the `deno.json` write, the error names
that step. Run the same command again to finish.

The hook is the only automatic CI trigger. GitHub remains a repository backup service.

Run these commands for manual checks or diagnosis:

```sh
mci check ci/local-ci.yml --job check
mci run ci/local-ci.yml --job check
mci ci ci/local-ci.yml --job check
mci status
mci logs "$PWD" --follow
```

`mci ci` requires a registered repository and a running daemon. It waits for the submitted
request and streams that request's log.

The client waits up to five seconds for acceptance. After cancellation, the client waits
up to ten seconds for the daemon result. These deadlines are policies. Client deadlines do
not limit accepted execution or queue waiting. Each job keeps its workflow deadline.

If either client deadline expires, the client closes its connection and reports unknown
completion. The request does not resume automatically. `mci status` shows the current
daemon state.

The daemon cancels a request when its submitting client disconnects. The cancellation does
not affect requests from other clients.

After a daemon restart, an unfinished request that began becomes INTERRUPTED. The daemon
drops a queued request that never began. It retries neither.

The daemon and monitor use `~/Library/Application Support/mci` for shared state. Existing
installations do not migrate state automatically. Before an upgrade, stop the service.
Move the previous state directory to this location. If the installed monitor has a
different `MCIInstaller` value, move its bundle aside before `mci setup`.

After renaming a repository folder, register its new path with `mci register`.

To update a same-version local package, build and copy the formula again. Then reinstall
the formula, restart the service, and refresh the monitor app.

```sh
deno task package
cp dist/tap/Formula/mci.rb "$(brew --repo local/mci)/Formula/mci.rb"
brew reinstall local/mci/mci
brew services restart mci
mci setup
```

## CI failures in Codex

Install the session adapter in each repository:

```sh
mci codex install "$PWD"
```

For a source checkout, run this command in the target repository. Replace the placeholder
with the path of the mci checkout:

```sh
deno task --config /path/to/mci/deno.json mci codex install "$PWD"
```

Inside the mci checkout, `deno task mci codex install "$PWD"` is sufficient.

The installer updates `.codex/hooks.json`, keeps other hooks, and removes older mci hooks
that it no longer installs. Codex must review and trust the new definitions before the
hooks run. The Codex CLI provides `/hooks` for that review. A current session can require
a restart to load the new configuration. The
[Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) describes hook trust.

When `mci ci` or `mci run` fails inside Codex, the adapter reports the failure at the
start of the session and at each prompt. The message names the workflow, job, failure
detail, and log. It also tells the agent to fix CI before other work. When a failure
remains unresolved, the `Stop` hook asks Codex to continue the repair once. The adapter
does not report a failure after each tool call.

A later passing run clears a failure for the same workspace, workflow, and job. The
passing run must start at or after the finish time of the failure. Failures in other jobs
or sessions stay separate. A validation error with exit code 2 is the one exception. Any
later passing run in the same workspace clears it, because a mistyped job or workflow path
cannot pass on a rerun.

The CLI saves a pending receipt before validation or execution. It saves the final receipt
after the outcome. Validation errors, daemon errors, cancellation, and unknown completion
therefore stay visible. If the client exits before the final save, the receipt stays
pending. The adapter then tells the agent to wait for active CI.

A receipt write failure prints a warning on stderr. It does not change the CI exit code
and it does not stop CI from starting. After a failed final write, the pending receipt
stays in place. Fix the receipt storage when you see the warning.

The CLI selects `MCI_SESSION_ID`, then `CODEX_SESSION_ID`, then `CODEX_THREAD_ID`. The
hook reads `MCI_SESSION_ID` when set. Otherwise, it reads the session identifier of the
Codex event and ignores inherited Codex identifiers. Set `MCI_SESSION_ID` before starting
Codex so that tools and hooks use the same value. A command without a session identifier
does not create a receipt. Receipts live in `sessions/` under the mci service directory.
They contain result metadata, not environment values or transcript content. The owner
removes the directory of a finished session. The reader skips a receipt that it cannot
decode and prints one warning for it.

Session hooks read receipts and never start CI themselves. The pre-commit hook remains the
only automatic CI trigger. The adapter guides the agent and requests continuation. It does
not lock tool calls. If `stop_hook_active` is true, the adapter reports the unresolved
state without another continuation.

## A workflow

```yaml
name: Local checks
on: workflow_dispatch
defaults:
  run:
    shell: bash
jobs:
  check:
    runs-on: macos-latest
    timeout-minutes: 10
    steps:
      - name: Format
        run: deno fmt --check
      - name: Test
        run: deno task test
```

Always select the file and job explicitly. The invocation directory is the workspace.
Existing files, including uncommitted changes, are used in place. `check` validates and
prints the plan without executing workflow commands. It checks for Bash using filesystem
metadata, but does not run Bash or validate the programs inside scripts.

| Supported               | Behavior                                                             |
| ----------------------- | -------------------------------------------------------------------- |
| `run`, `name`           | Sequential named steps; each gets a fresh shell                      |
| `env`                   | Literal strings at workflow, job and step levels; most specific wins |
| `defaults.run`          | Bash and working directory defaults, with per-step overrides         |
| `working-directory`     | Relative to workspace; must exist when its step starts               |
| `timeout-minutes`       | One job deadline; default 15; positive integer up to 35791           |
| `runs-on: macos-latest` | Use this Mac; no hosted image or architecture emulation              |
| `on`                    | Metadata only; no events, filters, inputs or scheduling              |

The effective `shell` must explicitly be `bash`. It runs with
`--noprofile --norc -e -o pipefail`. An `export` or `cd` in one step does not persist to
the next; files do. Steps have closed stdin and stream stdout/stderr live.

**Everything else in shared configuration or the selected job is rejected.** This includes
`uses`, checkout/setup actions, expressions, conditions, matrices, dependencies,
containers, outputs and `continue-on-error`. No unsupported action is silently skipped.
Try:

```sh
deno task mci check examples/unsupported.yml --job check
# Exit 2; the first command is never executed.
```

Other jobs are reported but not scheduled or semantically validated. The parser requires
one valid YAML document before the runner selects a job. Syntax, duplicate keys, aliases,
explicit tags, merge keys, and key types therefore receive checks across the entire
document. Invalid YAML in any job rejects the workflow before execution. Ordinary shell
expansion such as `$NAME` is allowed; GitHub `${{ ... }}` expressions are unsupported.

## Environment and process behavior

The invoking environment is inherited. Workflow/job/step values overlay it, and the runner
sets `CI=true` and `MCI_LOCAL=true`. `BASH_ENV`, `ENV`, `GITHUB_*` and `RUNNER_*` are
removed from inherited state and rejected in workflow env. `CI` and `MCI_LOCAL` cannot be
overridden by workflow configuration. Environment values must be strings; variable names
use shell identifier syntax. The runner also reserves `MCI_TASK_PARENT` and removes it
from each step environment.

The first failed step stops the job. A timeout, SIGINT, or SIGTERM reaches the active
process group. The runner escalates termination after a two-second grace period. The
runner bounds its subsequent wait for the direct child. Cleanup errors preserve the
original execution detail and make the run fail. Process identity inspection also has a
deadline and bounded cleanup.

Helper commands that the `mci` CLI runs allow 1 MiB per output stream. A MiB is 1,048,576
bytes. Output beyond a budget fails the helper and starts bounded cleanup. Workflow steps
continue to stream their output.

Under the `mci` task, `mci run` monitors its native Deno task parent. If that parent
exits, the CLI cancels the active job and cleans the workspace. `mci ci` always monitors
its parent and cancels its daemon request when the parent exits. Standalone `mci run` uses
the usual OS signals and job deadline.

The runner cleans up background processes in the same group after every step. Background
processes cannot act as services for later steps. The runner removes private scripts after
confirmed cleanup.

The runner holds an exclusive file lock in `.mci/lock` throughout execution and cleanup. A
competing runner returns an error before it launches a workflow step. The operating system
releases the lock if the runner exits or receives SIGKILL. The lock file remains in place
so later runs use the same inode.

The runner stores private scripts and an atomic recovery journal under `.mci/`. After an
interrupted run, the next run checks the recorded process identity before recovery.
Recovery compares the process start identity, process group, and private script path. If
identity or cleanup remains uncertain, recovery retains the journal and reports a failure.
The runner removes abandoned private scripts only after recovery succeeds.

| Exit      | Meaning                                                  |
| --------- | -------------------------------------------------------- |
| 0         | Selected job passed                                      |
| 1         | Step, process launch, cleanup or runtime failure         |
| 2         | Invalid invocation, invalid workflow or failed preflight |
| 124       | Job timed out                                            |
| 130 / 143 | Cancelled by SIGINT / SIGTERM                            |

Run only trusted workflows. Commands can change host files and access local credentials.
Deno permissions do not sandbox child programs. The runner provides no secret masking,
environment-file protocol, or workflow-command parser.

File locking controls cooperating runners; trusted commands can replace the lock file or
change shared files themselves. Recovery remains best effort because process inspection
and signaling are separate operations. A crash between process creation and journal
persistence can leave an unrecorded process. Detached descendants and changed process
identities can require manual cleanup. The runner reports uncertain recorded identities
instead of terminating an unrelated process.

## Develop and validate

Git runs one effective pre-commit hook before each commit. Managed installation sets the
local hook path to the packaged Homebrew hook, which calls `deno task mci:ci`. Read the
effective Git configuration before you identify the active hook.

The tracked `mci:ci` task in this repository names the Apple Silicon prefix
`/opt/homebrew`. On a host with the Intel prefix `/usr/local`, setup refuses that task as
foreign. Before managed setup on such a host, change the task path to
`/usr/local/opt/mci/bin/mci`.

The packaged hook submits `ci/local-ci.yml`, job `check`, to the local daemon. The daemon
saves output under `.mci/ci/`. The hook needs a running daemon and a registered checkout.

The local YAML selects the four standard tasks and the optional `app:check` task. A failed
check blocks the commit, and the checks include unstaged changes.

Each repository keeps request logs under `.mci/ci/requests/`. The daemon projects the
latest completed result to `.mci/ci/latest.json`. The `log` field of that file names the
saved output of the result.

The daemon keeps the latest completed result visible while another request runs or waits.
It retains that result and every spool file used by a connected client. Pending journal
entries also retain recovery files.

To read the latest saved output, open the file that the `log` field names:

```sh
less "$(jq -r .log .mci/ci/latest.json)"
```

The menu bar app observes daemon status. It can register or unregister a repository, open
a repository, and open saved logs.

When you add a folder, the app only registers the repository with the daemon. The panel
reminds you to run `mci hooks setup <path>` once in a terminal. Setup uses
`ci/local-ci.yml` and job `check`. Setup keeps an existing workflow byte for byte. If the
workflow is absent, setup selects defined tasks in this order: `fmt:check`, `lint`,
`check`, and `test`. Setup creates one step per defined task. The repository must define
at least one standard task. Setup adds `.mci/` to `.gitignore` when that entry is absent.
This entry excludes saved logs and runtime files from Git and Deno formatting.

Setup then runs the same steps as `mci hooks install`. Setup checks the whole installation
before it writes any file.

mci does not scan task commands for recursion. Instead, `mci ci` refuses at runtime inside
a daemon job of the same repository. The daemon gives each job the variables
`MCI_DAEMON_SOCKET` and `MCI_REPOSITORY_PATH`. A workflow cannot set these names. When
both values match the current daemon and the current directory, `mci ci` prints an error
and exits with status 2. Without this check, the job would wait for itself. A test daemon
with another `MCI_HOME` has another socket, so it accepts the submission.

The workflow selects the task set for each repository. Optional build, browser, or other
tasks remain explicit steps in that file. Their commands belong in `deno.json`. For
example, a repository can select type checks, tests, and an optional build:

```yaml
name: Local validation
on: workflow_dispatch
defaults:
  run:
    shell: bash
jobs:
  check:
    runs-on: macos-latest
    steps:
      - name: Type checks
        run: deno task check
      - name: Tests
        run: deno task test
      - name: Build
        run: deno task build
```

Every repository set up with `mci hooks setup` uses the packaged hook. An active hook in
the current hooks directory, including a tracked source hook, blocks setup with a specific
error.

If setup fails, the command prints the error and exits with status 1. The repository stays
registered. For another workflow or job, use `mci hooks install` with the required
arguments. That command preserves its strict refusal rules.

Hook installation preserves `deno.json` when its managed task already matches. A folder
must be the Git worktree root; the installer checks that root first. Installation keeps
the POSIX permission bits of `deno.json`.

The monitor never starts CI. It shows the active request, queue count, and latest
completed result for each repository.

For a manual check:

```sh
deno task verify
```

This runs formatting, linting, type checking, real subprocess tests, and `app:check`.
`app:check` builds the Swift monitor and runs its checks. It needs the Xcode Command Line
Tools. On macOS the tests also run the CLI success/SIGINT test skipped on Linux. The Deno
source is organized as pure workflow validation, process supervision, the daemon, and a
small CLI. The Deno source has no application classes, inheritance, expression engine or
plugin system. Typed results carry failures; exception handling is limited to library and
OS boundaries.

`deno task mci:ci` submits the local YAML to the daemon, which saves its output.

Read [docs/design.md](docs/design.md) for module responsibilities, recovery rules, and
release ownership. [docs/rebase-plan.md](docs/rebase-plan.md) records the current
simplification plan. Git history keeps earlier plans and verification records. The local
workflow lives in `ci/local-ci.yml` and uses the current checkout and installed Deno.
Automatic CI runs only through the pre-commit hook. GitHub serves only as a repository
backup service.

The CLI identifies the host, runtime, and resolved Bash executable. Installed commands and
the inherited environment remain inputs to each local run. A local pass does not establish
a clean commit, toolchain reproducibility, hosted-image parity, or results for unselected
jobs.

### Development

Installed use needs Homebrew. Run `brew services start mci`, then run `mci setup`.

For development, run the daemon from this checkout in a terminal:

```sh
mkdir -p /tmp/mci-dev
MCI_HOME=/tmp/mci-dev deno task mci daemon
```

`MCI_HOME` selects a temporary service directory. This isolates the daemon from the
installed Homebrew service. Set the same `MCI_HOME` value in every other terminal.

Register this checkout from another terminal. Then submit its local workflow:

```sh
MCI_HOME=/tmp/mci-dev deno task mci register "$PWD"
MCI_HOME=/tmp/mci-dev deno task mci ci ci/local-ci.yml --job check
```

To build and test the menu bar app without installing it, run `deno task app:check`.

## References

- [act native host runners](https://nektosact.com/usage/runners.html)
- [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [Deno subprocess API](https://docs.deno.com/api/deno/subprocess/)
- [YAML parser](https://github.com/eemeli/yaml)
