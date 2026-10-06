# General repository tasks

## Goal

mci supplies one setup policy for Deno repositories. Repository configuration selects the
tasks. mci contains no branch selected by a repository name or path.

## Accepted contract

`ci/local-ci.yml` is the only configuration for task selection. Setup preserves an
existing workflow byte for byte. Optional tasks, including build and browser checks,
remain explicit steps in that workflow. `deno.json` defines their commands.

When the workflow is absent, setup selects defined standard tasks in this order:
`fmt:check`, `lint`, `check`, and `test`. Setup creates one Bash step for each task. An
absent standard task is omitted. A selected task must be a nonempty string. Setup refuses
a repository with no standard task before changing files.

Setup validates every selected task and its Deno task dependencies. Recursive CI calls
remain refusal cases. Existing workflows keep their current validation.

All repositories use the packaged hook and the generated `mci:ci` task. Setup and
inspection no longer accept the tracked source hook as an exception. Unknown active
pre-commit hooks receive the same conflict result in every repository. The existing
pre-push replacement flag and worktree isolation remain unchanged.

The mci checkout will use the same packaged hook through worktree configuration. The
tracked source hook remains available for source development and future clones. The main
agent will change this local setting without adding a repository exception. The mci
workflow will select all four standard tasks and its optional `app:check` task. The mci
configuration will define `fmt:check` and `lint` as ordinary Deno tasks.

## Work and validation

The hooks worker owns `src/hooks.ts` and `tests/hooks_test.ts`. The monitor worker owns
hook inspection, chooser text, and native hook checks. The main agent owns CLI checks,
documentation, review, local commits, and installation.

Behavior checks cover partial standard sets, deterministic ordering, missing tasks,
invalid selected tasks, recursive dependencies, optional configured tasks, and custom
hooks. The main agent will run the focused checks and the complete local CI workflow. The
main agent will install the package and run an isolated actual commit test. Existing
configured repositories require no workflow regeneration.

## Decision evidence

The user accepted Deno task names with optional repository tasks in Decision 3. The
current YAML parser already supports multiple Bash steps. The current installer preserves
existing workflows and accepts configurable workflow paths. The advisor route is
unavailable because the parent runtime cannot be identified. The main agent owns the
resulting design and verification.
