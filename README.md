# mci

A minimal local CI runner for macOS, written in Deno and light functional TypeScript. It
reads a small GitHub Actions YAML subset and runs one selected job against your current
working tree.

**Status: initial v0.1.0 implementation.** The portable core has been tested on Linux with
Deno 2.9.7. Native macOS execution still needs the included macOS test. See
[VERIFICATION.md](VERIFICATION.md) for exact evidence and limitations.

## Quick start

Install [Deno](https://docs.deno.com/runtime/getting_started/installation/) 2.9.7 or newer
and make Bash available on `PATH`. No Node installation, Docker, VM or GitHub account is
needed. Run these commands from the extracted repository root:

```sh
deno task mci check examples/basic.yml --job check
deno task demo
deno task mci run .github/workflows/local-ci.yml --job check
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

Compilation may download Deno's compilation runtime. Native compilation and the resulting
executable have not been verified in this initial package. Use the source CLI first. To
make a source checkout from the ZIP, run `git init` in its root.

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

Other jobs are reported but not scheduled or semantically validated. YAML syntax,
duplicate keys, aliases, explicit tags, merge keys and non-string keys are checked across
the entire document. An ordinary shell expansion such as `$NAME` is allowed; GitHub
`${{ ... }}` expressions are not.

## Environment and process behavior

The invoking environment is inherited. Workflow/job/step values overlay it, and the runner
sets `CI=true` and `MCI_LOCAL=true`. `BASH_ENV`, `ENV`, `GITHUB_*` and `RUNNER_*` are
removed from inherited state and rejected in workflow env. `CI` and `MCI_LOCAL` cannot be
overridden by workflow configuration. Environment values must be strings; variable names
use shell identifier syntax.

The first failed step stops the job. A timeout, SIGINT or SIGTERM reaches the active
process group, followed by SIGKILL after a two-second grace period if needed. Same-group
background processes are cleaned up after every step, even success; they cannot act as
services for later steps. Temporary scripts are removed on handled exits. There is no
persistent run database.

| Exit      | Meaning                                                  |
| --------- | -------------------------------------------------------- |
| 0         | Selected job passed                                      |
| 1         | Step, process launch, cleanup or runtime failure         |
| 2         | Invalid invocation, invalid workflow or failed preflight |
| 124       | Job timed out                                            |
| 130 / 143 | Cancelled by SIGINT / SIGTERM                            |

Run only trusted workflows. Commands can change files and access your local credentials.
Deno permissions do not sandbox child programs. There is no secret masking,
environment-file protocol or workflow-command parser. Commands that detach from their
group and runner SIGKILL recovery are outside the contract. Concurrent runs share your
working tree; use separate worktrees when needed.

## Develop and validate

```sh
deno task verify
```

This runs formatting, linting, type checking and real subprocess tests. On macOS it also
runs the CLI success/SIGINT test skipped on Linux. The source is organized as pure
workflow validation, process supervision and a small CLI. There are no application
classes, inheritance, expression engine or plugin system. Typed results carry failures;
exception handling is limited to library and OS boundaries.

Read [docs/design.md](docs/design.md) for the implementation contract. Put shared checks
in `ci/check.sh`; a separate hosted workflow can check out the repository, install tools
and call that script. The supplied `local-ci.yml` assumes a local checkout and installed
Deno; it is not a complete hosted workflow.

## References

- [act native host runners](https://nektosact.com/usage/runners.html)
- [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [Deno subprocess API](https://docs.deno.com/api/deno/subprocess/)
- [YAML parser](https://github.com/eemeli/yaml)
