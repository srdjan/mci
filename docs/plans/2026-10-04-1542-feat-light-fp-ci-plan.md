---
title: Light-FP in Local CI - Plan
type: feat
date: 2026-10-04
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Light-FP in Local CI - Plan

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
will not substitute for domain enforcement.

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

**Decision 3: Existing diagnostics.** The recommendation is responsibility-based layer
declarations and limited corrections. Pure modules remain in the domain layer. Effectful
modules may receive adapter declarations with explicit reasons. `src/result.ts` may use
the prelude declaration because it converts exceptions into Result values. Any necessary
new helper must directly support a reported violation and preserve the public API.

### Evidence and Deferred Measurements

The installed Deno version is 2.9.7. The configured hook path is `.githooks`. The
published package version is 0.7.5. No Light-FP run occurs during planning. The diagnostic
count and execution duration need measurement during implementation.

`src/workflow.ts` contains `try` around third-party YAML parsing. `src/daemon.ts` contains
mutable runtime records and OS operations. These observations identify review targets, not
a measured diagnostic list.

## Implementation Units

### U1. Enable Light-FP in the existing gate

**Goal:** Satisfy R1 through R4 with one complete change.

**Dependencies:** None.

**Files:** `deno.json`, `deno.lock` if dependency resolution changes it, and `README.md`.
Source candidates are `src/result.ts`, `src/workflow.ts`, `src/protocol.ts`,
`src/daemon.ts`, `src/daemon-store.ts`, `src/process.ts`, `src/runner.ts`,
`src/runtime.ts`, `src/worker.ts`, and `src/workspace.ts`. Existing tests for changed
public behavior belong to the same unit. Any new helper or test file needs a documented
connection to an actual diagnostic.

**Approach:** Register the pinned plugin, then measure diagnostics from the repository
root. Classify each affected module before selecting a correction. Apply only the
corrections required by Decision 3. Document the plugin and its existing CI path in the
development section of `README.md`.

**Execution note:** Start with a sub-minute lint check before attempting the complete CI
pipeline. Use a temporary domain file to prove enforcement, then remove that file before
committing.

**Test scenarios:** A domain file with an explicit throw produces a named Light-FP
diagnostic and a nonzero lint exit. The same file makes local CI fail through the existing
workflow. After removal, lint and complete CI pass. If a correction changes logic,
existing public API tests must preserve its behavior. Add a focused behavior test only
when existing tests cannot establish that preservation. Configuration and declaration
changes need runtime evidence, not tests that duplicate configuration text.

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
existing pre-commit hook. No probe file or recording artifact enters the commit.

## Definition of Done

Light-FP loads from the pinned published package. The negative check proves that a domain
violation blocks local CI. The cleaned repository passes the complete existing gate. The
README describes the active check. The implementation receives one local commit on `main`;
the user owns any push.

## Sources

Repository evidence comes from `deno.json`, `ci/local-ci.yml`, `.githooks/pre-commit`,
`README.md`, and the source candidates above. The
[published package documentation](https://jsr.io/@srdjan/light-fp-lint) defines
configuration and layer behavior.
