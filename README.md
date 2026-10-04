# mci

A local CI runner for macOS, written in Deno and light functional TypeScript. It reads a
small GitHub Actions YAML subset and runs one selected job against your current working
tree.

One daemon serves all registered repositories for one user. Each repository has a FIFO
queue, while different repositories can run at the same time.

The runner uses trusted local commands and one selected job. See
[VERIFICATION.md](VERIFICATION.md) for tested hosts, commands, and remaining evidence
limits.

## Install with a local Homebrew tap

Install Homebrew and Deno 2.9.7 or newer. Make Bash available on `PATH`. The package build
also requires the Xcode Command Line Tools.

Build the package from this checkout. Create the local tap, then copy the generated
formula into the tap.

Package archive names include their full SHA-256 checksum. The generated formula points to
that archive. The packager replaces the formula after it prepares both artifacts. Earlier
archives remain available for copied formulas. The repository maintainer owns archive
removal.

```sh
deno task package
brew tap-new --no-git local/meeci
cp dist/tap/Formula/mci.rb "$(brew --repo local/meeci)/Formula/mci.rb"
brew install local/meeci/mci
mci setup
```

`mci setup` starts the Homebrew service and installs `~/Applications/mci Monitor.app`. The
daemon imports the earlier registry only when its own registry does not exist.

Register each repository. Then install its managed pre-commit hook.

```sh
cd /path/to/your/repository
mci register "$PWD"
mci hooks install "$PWD" --workflow ci/local-ci.yml --job check
```

The hook adds the `mci:ci` task to `deno.json`. The task uses the stable Homebrew binary.
Git selects the absolute hook directory under the stable Homebrew prefix. Hook
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
mci doctor "$PWD"
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

After a daemon restart, unfinished requests become INTERRUPTED. The daemon does not retry
them.

To update a same-version local package, build and copy the formula again. Then reinstall
the formula, restart the service, and refresh the monitor app.

```sh
deno task package
cp dist/tap/Formula/mci.rb "$(brew --repo local/meeci)/Formula/mci.rb"
brew reinstall local/meeci/mci
brew services restart mci
mci setup
```

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

Captured helper commands allow 1 MiB per output stream. The source monitor build allows 16
MiB per stream. A MiB is 1,048,576 bytes. Output beyond a budget fails the helper and
starts bounded cleanup. Workflow steps continue to stream their output.

The `mci` task monitors its native Deno task parent. If that parent exits, the CLI cancels
the active job and cleans the workspace. Standalone execution uses the usual OS signals
and job deadline.

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

Install this repository's tracked development hook after cloning:

```sh
deno task hooks:install
```

Git runs `.githooks/pre-commit` before each commit. The hook calls `deno task ci` from the
repository root.

The local YAML calls `deno task verify` directly. A failed check blocks the commit, and
the checks include unstaged changes.

An installed Homebrew service also accepts requests from the source CLI. Without that
service, run the source daemon in a separate terminal:

```sh
deno task mci daemon
```

Use another terminal to register this checkout and submit its local workflow:

```sh
deno task mci register "$PWD"
deno task mci ci ci/local-ci.yml --job check
```

The source monitor installer requires a running daemon. It builds, signs, installs, and
opens the native app.

```sh
deno task monitor:install "$PWD"
```

Each repository keeps request logs under `.mci/ci/requests/`. The daemon projects the
latest completed result to `.mci/ci/latest.json`, `status.json`, and `latest.log`.

The daemon keeps the latest completed result visible while another request runs or waits.
It retains that result and every spool file used by a connected client. Pending journal
entries also retain recovery files.

To read the latest saved output:

```sh
less .mci/ci/latest.log
```

The menu bar app observes daemon snapshots and status. It can register or unregister a
repository, open a repository, and open saved logs.

The monitor never starts CI. It shows the active request, queue count, and latest
completed result for each repository.

For a manual check:

```sh
deno task verify
```

This runs formatting, linting, type checking and real subprocess tests. On macOS it also
runs the CLI success/SIGINT test skipped on Linux. The source is organized as pure
workflow validation, process supervision and a small CLI. There are no application
classes, inheritance, expression engine or plugin system. Typed results carry failures;
exception handling is limited to library and OS boundaries.

`deno task ci` runs the local YAML and saves its output.

Read [docs/design.md](docs/design.md) for module responsibilities, recovery rules, and
release ownership. The local workflow lives in `ci/local-ci.yml` and uses the current
checkout and installed Deno. Automatic CI runs only through the pre-commit hook. GitHub
serves only as a repository backup service.

The CLI identifies the host, runtime, and resolved Bash executable. Installed commands and
the inherited environment remain inputs to each local run. A local pass does not establish
a clean commit, toolchain reproducibility, hosted-image parity, or results for unselected
jobs.

## References

- [act native host runners](https://nektosact.com/usage/runners.html)
- [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [Deno subprocess API](https://docs.deno.com/api/deno/subprocess/)
- [YAML parser](https://github.com/eemeli/yaml)
