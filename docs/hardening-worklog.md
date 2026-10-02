# Architecture hardening worklog

## Current objective

Execute docs/hardening-plan.md and resolve all actionable findings from the architecture
review.

## Evidence

The starting tree is clean on local main at 7a0ab4c. Deno 2.9.7 runs on Apple Silicon
macOS. The baseline passes formatting, linting, type checking, and 18 tests; the
Linux-only test is skipped. A native probe confirms that tryLock rejects a competing
holder and succeeds after the first holder closes its file. The advisor preflight cannot
identify the parent runtime, so the advisor route is unavailable.

## Accepted scope

The user authorized all fixes. Whole-document YAML checks and trusted host execution
remain explicit product boundaries. Intel and minimum macOS compatibility remain evidence
limits until those systems execute the checks.

## Current work

The plan review accepted the direction and required explicit journal states, recovery
limits, and compound diagnostics. The plan now includes those corrections. Two public
runner regressions failed as expected before implementation. A competing run changed the
same workspace, and cleanup failure hid exit 23. The regression patch is saved outside the
repository until runner integration. Delegate independent process and configuration units
with exclusive file ownership. Delegate workspace lifecycle after the process API is
committed. The main agent owns integration, documentation, verification, review, and
commits.

## Next action

Review delegated changes, integrate the runner, and test workspace exclusion and recovery.
