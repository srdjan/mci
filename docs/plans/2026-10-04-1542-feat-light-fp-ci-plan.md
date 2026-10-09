---
title: Light-FP in Local CI - Plan
type: feat
date: 2026-10-04
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
source_baseline: 44044f93a657d5cef644e020a427eb663f971ab7
---

# Light-FP in Local CI - Plan

Status: retired on 2026-10-09 without execution. `deno.json` has no `lint.plugins` entry.
The CI path that this plan describes changed later: `ci/local-ci.yml` now calls each task
directly, and the maintainer's checkout selects the packaged hook. A new plan is required
to adopt Light-FP lint.

## Goal Capsule

**Objective:** Local CI blocks commits when domain code violates Light-FP rules.

**Means:** Activate the published plugin through the existing Deno lint configuration.

**Authority:** The user requests a plan before implementation. Repository instructions
require local commits on `main` and prohibit pushes. Implementation starts after the user
accepts this plan.

**Stop conditions:** A required behavioral change or architectural redesign needs a
revised plan. A command that exceeds two minutes needs user confirmation before further
execution.

## Product Contract

### Summary

The existing local CI gate will enforce Light-FP alongside Deno's built-in lint rules.
Existing checks will continue through the same pre-commit hook.

### Problem Frame

`deno.json` does not register Light-FP. The current `@light-fp adapter` comments therefore
do not activate its rules. Some unmarked modules contain effects or exception boundaries
that need classification or corrections.

### Requirements

**Enforcement**

- R1. `deno lint` must load Light-FP and retain Deno's existing built-in lint checks.
- R2. A Light-FP violation in domain code must fail `deno task ci` and block the existing
  pre-commit hook.

**Compatibility**

- R3. Layer declarations must reflect module responsibilities, and corrections must
  preserve existing public behavior.
- R4. The pre-commit hook remains the sole automatic trigger; no additional hook or remote
  CI is introduced.

### Scope Boundaries

This work covers plugin activation, necessary layer declarations, limited lint
corrections, documentation, and local verification. Broad refactors, dependency upgrades
unrelated to Light-FP, and changes to daemon or monitor behavior remain outside scope.
Blanket adapter declarations, file exclusions, rule disabling, and a violation baseline
will not substitute for domain enforcement. The accepted migration limits in
`plans/hardening-pruning-list.md` remain outside this lint integration. These limits cover
a concurrent legacy adapter and file replacement between the log check and copy.

## Planning Contract

### Technical Decisions

**Decision 1: Package source.** The recommendation is the published
`jsr:@srdjan/light-fp-lint@0.7.5` plugin. A local checkout path would make CI depend on a
sibling repository. A copied implementation would create a second rule source. The
published package documents activation through `lint.plugins`.

**Decision 2: Integration point.** The recommendation is configuration in `deno.json`. A
separate command or hook would duplicate the existing gate. The current path is
`.githooks/pre-commit` to `deno task ci`, then `ci/local-ci.yml` to `deno task verify`.
The `verify` task already runs `deno lint`.

**Decision 3: Existing diagnostics.** The recommendation is explicit layer declarations
based on current module responsibilities. A parser refactor would expand this integration.
The declarations preserve the synchronous public API and existing behavior.

`src/daemon-store.ts`, `src/daemon.ts`, `src/process.ts`, `src/runner.ts`,
`src/runtime.ts`, `src/worker.ts`, and `src/workspace.ts` receive adapter declarations.
These modules own filesystem, process, clock, signal, or runtime operations.
`tests/helpers.ts` receives an adapter declaration because it owns test effects. Its
filename does not match the plugin's automatic test suffixes.

`src/result.ts` receives the prelude declaration because it converts exceptions into
Result values. `src/protocol.ts` remains domain code. Any correction to that module must
preserve its decoding behavior.

`src/workflow.ts` receives an adapter declaration because it adapts the third-party YAML
parser through exception handling and visitor callbacks. This declaration also exempts
validation functions in the same file. Extracting those functions into a separate domain
module remains outside scope. Any new helper must directly support a measured diagnostic
and preserve the public API.

### Evidence and Deferred Measurements

The installed Deno version is 2.9.7. The configured hook path is `.githooks`. The
published package version is 0.7.5. No Light-FP run occurs during planning. The diagnostic
count and execution duration need measurement during implementation.

The reviewed source baseline is `44044f9`. The CI configuration matches the original plan.
The source review includes directory validation before missing-log creation.

`src/workflow.ts` contains parser exception handling, visitor callbacks, discarded calls,
and a primitive cast. `src/protocol.ts` has a discarded collection update.
`tests/helpers.ts` contains filesystem operations, timers, and exceptions. These
observations guide classification; they are not measured diagnostics.

### Behavior to Preserve

The current legacy migration validates request directories before creating a missing
`latest.log`. It then copies that empty log into the immutable request log and publishes
`latest.json`. Finished legacy records retain their terminal result. Running records
become interrupted.

A directory or symbolic link at `latest.log` blocks the repository. The error identifies
the blocking path. The block leaves `latest.json` absent and preserves `status.json`. Lint
corrections must preserve these outcomes. Fixing the accepted copy race remains outside
scope.

A symbolic-link `.mci` blocks migration before log creation. The daemon creates neither
`latest.log` nor `latest.json` through that link.

`planWorkflow` remains synchronous and returns validation failures as Result values. The
`attempt` and `message` helpers retain their existing error conversion behavior.

## Implementation Units

### U1. Enable Light-FP in the existing gate

**Goal:** Satisfy R1 through R4 with one complete change.

**Dependencies:** None.

**Files:** `deno.json`, `deno.lock` if dependency resolution changes it, and `README.md`.
Source candidates are `src/result.ts`, `src/workflow.ts`, `src/protocol.ts`,
`src/daemon.ts`, `src/daemon-store.ts`, `src/process.ts`, `src/runner.ts`,
`src/runtime.ts`, `src/worker.ts`, `src/workspace.ts`, and `tests/helpers.ts`. Existing
coverage includes `tests/daemon_test.ts`, `tests/workflow_test.ts`,
`tests/protocol_test.ts`, `tests/command_test.ts`, `tests/process_test.ts`, and
`tests/workspace_test.ts`. Tests change only when a logic correction needs additional
public API coverage. Any new helper or test file needs a documented connection to an
actual diagnostic.

**Approach:** Register the pinned plugin, then measure diagnostics from the repository
root. Apply the layer choices in Decision 3 before selecting a logic correction. Apply
only corrections required by remaining diagnostics. Document the plugin and its existing
CI path in the development section of `README.md`.

**Execution note:** Start with a sub-minute lint check before attempting the complete CI
pipeline. Use a temporary domain file to prove enforcement, then remove that file before
committing.

**Test scenarios:** A domain file with an explicit throw produces a named Light-FP
diagnostic and a nonzero lint exit. The same file makes local CI fail through the existing
workflow. After removal, lint and complete CI pass. If a correction changes logic,
existing public API tests must preserve its behavior. Add a focused behavior test only
when existing tests cannot establish that preservation. Configuration and declaration
changes need runtime evidence, not tests that duplicate configuration text.

**Preservation coverage:** The missing-log test in `tests/daemon_test.ts` covers finished
and running records. It requires empty request and compatibility logs, plus `latest.json`.
The non-regular-log test covers directories and symbolic links. It requires a blocking
error with the exact log path, no `latest.json`, and an unchanged `status.json`. The
symbolic-link `.mci` test requires blocking without a log or result in the link target.
The YAML tests in `tests/workflow_test.ts` protect parsing and validation Results. The
decoder tests in `tests/protocol_test.ts` protect domain corrections.

**Verification:** Inspect every changed line, confirm the negative check identifies
Light-FP, and confirm the cleaned repository passes the existing gate.

## Verification Contract

The first check uses `deno lint` from the repository root. The negative check uses a
temporary file within the existing lint scope. Both `deno lint` and `deno task ci` must
reject that file because of Light-FP. The CI failure must identify the lint diagnostic
rather than an unavailable daemon or unregistered checkout.

After temporary file removal, `deno task ci` must pass formatting, lint, type checks,
tests, and the monitor check. The daemon must run, and this checkout must be registered
before CI evidence is collected. The local implementation commit must also pass the
existing pre-commit hook. The compatibility tests identified in U1 must retain their
current outcomes. Historical counts in `VERIFICATION.md` do not establish a Light-FP
baseline. No probe file or recording artifact enters the commit.

## Definition of Done

Light-FP loads from the pinned published package. The negative check proves that a domain
violation blocks local CI. The cleaned repository passes the complete existing gate. The
README describes the active check. The implementation receives one local commit on `main`;
the user owns any push.

## Sources

Repository evidence comes from `deno.json`, `ci/local-ci.yml`, `.githooks/pre-commit`,
`README.md`, and the source candidates above. Current migration behavior and evidence
appear in `docs/design.md`, `tests/daemon_test.ts`, and `VERIFICATION.md`.
`plans/hardening-pruning-list.md` records the accepted migration limits. The
[published package documentation](https://jsr.io/@srdjan/light-fp-lint) defines
configuration and layer behavior.
