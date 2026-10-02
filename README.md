# mci

A minimal local CI runner for macOS, written in Deno and light functional TypeScript. It
reads a small GitHub Actions YAML subset and runs one selected job against your current
working tree.

The runner uses trusted local commands and one selected job. See
[VERIFICATION.md](VERIFICATION.md) for tested hosts, commands, and remaining evidence
limits.

## Quick start

Install [Deno](https://docs.deno.com/runtime/getting_started/installation/) 2.9.7 or newer
and make Bash available on `PATH`. No Node installation, Docker, VM or GitHub account is
needed. Run these commands from the extracted repository root:

```sh
deno task mci check examples/basic.yml --job check
deno task demo
deno task mci run ci/local-ci.yml --job check
```

`demo` and `run` require macOS. `check`, type checking and the portable tests also work on
Linux. The first invocation downloads the pinned `yaml` parser from npm; subsequent cached
invocations need no network access from the runner. Scripts may still use the network.

To use the CLI from another repository, compile it on your Mac:

```sh
deno task compile
cd /path/to/your/repository
/path/to/mci/dist/mci check .github/workflows/local-ci.yml --job check
/path/to/mci/dist/mci run .github/workflows/local-ci.yml --job check
```

Compilation may download Deno's compilation runtime. The compiled binary uses the same
permissions and version source as the source CLI. The `mci` permission set in `deno.json`
supplies source, test, and compilation permissions.

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

```sh
deno task verify
```

This runs formatting, linting, type checking and real subprocess tests. On macOS it also
runs the CLI success/SIGINT test skipped on Linux. The source is organized as pure
workflow validation, process supervision and a small CLI. There are no application
classes, inheritance, expression engine or plugin system. Typed results carry failures;
exception handling is limited to library and OS boundaries.

Read [docs/design.md](docs/design.md) for module responsibilities, recovery rules, and
release ownership. The local workflow lives in `ci/local-ci.yml` and uses the current
checkout and installed Deno. The hosted workflow lives in `.github/workflows/ci.yml` and
installs its pinned Deno runtime before checks. Hosted CI checks Linux, Apple Silicon
macOS, and Intel macOS. Configured checks do not establish passing hosted results until
GitHub executes the workflow.

The CLI identifies the host, runtime, and resolved Bash executable. Installed commands and
the inherited environment remain inputs to each local run. A local pass does not establish
a clean commit, toolchain reproducibility, hosted-image parity, or results for unselected
jobs.

## References

- [act native host runners](https://nektosact.com/usage/runners.html)
- [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [Deno subprocess API](https://docs.deno.com/api/deno/subprocess/)
- [YAML parser](https://github.com/eemeli/yaml)
