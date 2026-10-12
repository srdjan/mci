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
mci hooks setup "$PWD" --replace-pre-push
```

Hook installation adds the `mci:ci` task to `deno.json`. The task uses the stable Homebrew
binary. Git selects the absolute hook directory under the stable Homebrew prefix. Hook
installation uses Git configuration scoped to the current worktree.

If installation rollback fails, the diagnostic keeps the original error. It names each
failed restoration target and gives the recovery action.

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

The installer updates `.codex/hooks.json` and preserves other hooks. Codex must review and
trust the new definitions before the hooks run. The Codex CLI provides `/hooks` for that
review. A current session can require a restart to load the new configuration. The
[Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) describes hook trust.

When `mci ci` or `mci run` fails inside Codex, the adapter reports the failure in the
session. The message identifies the workflow, job, failure detail, and available log. The
adapter also directs the agent to fix CI before continuing other work. A check before turn
completion requests repair continuation when a failure remains unresolved.

A later passing run clears only failures for the same workspace, workflow, and job. A
passing run that began before a failure finished cannot clear that failure. Failures in
other jobs or sessions remain separate. A validation error with exit code 2 is the one
exception. Any later passing run in the same workspace clears it, because a mistyped job
or workflow path cannot pass on a rerun. The adapter does not use a result age limit or
infer CI results from Git command text.

The CLI saves a receipt before validation or execution. Validation errors, daemon
unavailability, cancellation, and unknown completion therefore remain visible. If the
client exits before it saves a final result, its receipt remains pending. The adapter
directs the agent to wait for active CI before attempting repair. A later passing run of
the same checks can resolve that pending receipt.

If receipt creation fails, the CLI returns 1 before it starts CI. If receipt publication
fails after CI passes, the CLI returns 1 and reports unresolved state. A publication
failure preserves an existing nonzero CI exit code.

The CLI selects `MCI_SESSION_ID`, then `CODEX_SESSION_ID`, then `CODEX_THREAD_ID`. The
adapter selects `MCI_SESSION_ID` when set. Otherwise, the adapter uses the Codex event's
session identifier and ignores inherited Codex identifiers. Set an override before
starting Codex so tools and hooks use the same value. Commands without a session
identifier do not create session receipts. Receipts live under the mci service directory
in `sessions/`. They contain result metadata, not environment values or transcript
content. The adapter retains receipts until the owner removes the completed session
directory.

Session hooks read receipts and never start CI themselves. The pre-commit hook remains the
only automatic CI trigger. Repair commands remain available. The adapter guides the agent
and requests continuation; it does not lock every tool call. The adapter requests one
repair continuation per turn. If the repair remains blocked, Codex reports the unresolved
state and retains it for the next turn.

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
worktree hook path to the packaged Homebrew hook, which calls `deno task mci:ci`. The
maintainer's checkout selects the packaged hook through its worktree configuration. A
worktree setting takes precedence over a repository-local setting.

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

The menu bar app observes daemon snapshots and status. It can register or unregister a
repository, open a repository, and open saved logs.

When you add a folder, the app only registers the repository with the daemon. The panel
reminds you to run `mci hooks setup <path>` once in a terminal. Add `--replace-pre-push`
to replace an active pre-push hook. Setup uses `ci/local-ci.yml` and job `check`. Setup
preserves an existing workflow. If the workflow is absent, setup selects defined tasks in
this order: `fmt:check`, `lint`, `check`, and `test`. Setup creates one step per task and
omits absent tasks. The repository must define at least one standard task. Each selected
task must be a nonempty string. Setup adds `.mci/` to `.gitignore` when that entry is
absent. This entry excludes saved logs and runtime files from Git and Deno formatting.

Setup inspects literal Deno task commands at supported shell command positions. It parses
task options before task names. Default configuration and explicit root `deno.json` use
root task dependencies. Foreign configurations, changed directories, and workspace runs
remain trusted commands outside root inspection. A literal `ci` or `mci:ci` task still
causes refusal. Static inspection does not validate arbitrary shell programs.

`mci hooks setup` and `mci hooks install` also traverse defined root task dependencies in
existing workflows. Installation refuses recursive CI calls, defined cycles, and invalid
defined commands. Undefined optional tasks remain accepted during installation. Generated
workflows require every selected task and discovered root dependency.

Setup adds the `mci:ci` task and selects the packaged Homebrew hook for the worktree.
Setup can replace repository-owned `.githooks` configuration and disable its pre-push
hook. Setup preserves the old hook files and shared Git settings. Sibling worktrees keep
their hooks. An unknown active pre-commit hook or another active hook blocks setup with a
specific error. The command without `--replace-pre-push` refuses an active pre-push hook.

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

Every repository set up with `mci hooks setup` uses the packaged hook. A tracked source
hook is a custom hook and receives the same conflict result as another unknown active
hook. The maintainer's mci checkout selects the packaged hook through its local worktree
configuration.

If setup fails, the command prints the error and exits with status 1. The repository stays
registered. For another workflow or job, use `mci hooks install` with the required
arguments. That command preserves its strict refusal rules.

Hook installation preserves `deno.json` when its managed task already matches. A folder
must be the Git worktree root; the installer checks that root before local configuration.

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
