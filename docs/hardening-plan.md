# Architecture hardening plan

## Objective

Address actionable findings from the architecture review without changing trusted local
execution or the selected-job workflow contract.

## Constraints

Work on local main, commit each complete unit, and never push. Use gpt-5.6-sol with high
effort for delegated work. Keep expected failures in Result values and never use the any
type. Keep whole-document YAML validation because malformed YAML has no reliable
selected-job boundary. Do not claim Intel, minimum macOS, hosted, or reproducibility
evidence without execution results.

## Process supervision

Bound child reaping after termination and retain every cleanup error. Normalize
cancellation reasons at the boundary. Register process identity for recovery through an
optional onStart callback. Expose ProcessRecord with pid, started, and script fields. Use
native ps output to record and compare the process start identity and command. Recover
only a matching process group leader whose command contains the recorded private script
path. Treat uncertain identity as an explicit recovery failure and never signal an
unrelated process. Keep the existing two-second termination grace period as policy, not a
measured capacity estimate. Test native supervision and injected OS failures through the
public process API with small capability records.

## Workspace lifecycle

Own workspace exclusion, private scripts, and recovery in src/workspace.ts. Keep a
permanent .mci/lock inode and hold a nonblocking exclusive Deno file lock for the entire
run. Store private scripts beneath .mci/run-* and store one atomic journal in
.mci/run.json. Reject a competing run before it performs workflow effects. On the next
run, recover the recorded process through recoverProcess and remove abandoned private
script directories. Validate journal data and restrict removal to immediate run-*
directories beneath the canonical state directory. Do not silently discard an uncertain
process identity or failed recovery. Expose acquireWorkspace(workspace) returning a lease
with directory, record(ProcessRecord), and close() Result methods. The runner records each
launched process and closes the lease on every handled return. Retain recovery evidence
when recovery or cleanup fails. Document the unavoidable interval between process creation
and journal persistence.

## Configuration and hosted checks

Read CLI version from deno.json and centralize source and compilation permissions in one
executable configuration module. Use that module in task launchers and CLI subprocess
tests. Keep local workflow YAML outside .github/workflows and add a complete hosted
workflow with checkout and pinned Deno installation. Run verification and compiled smoke
checks on Linux, Apple Silicon macOS, and Intel macOS. Keep actual execution evidence
separate from configured checks. Test help, version, missing workflow, missing Bash,
timeout limits, and global YAML validation boundaries.

## Integration and evidence

Reduce runner responsibility by moving script preparation and lifecycle operations to the
workspace lease. Retain the primary execution detail when temporary cleanup also fails.
Run focused regressions before the full verification suite. Compile and execute the native
binary, run the demo, and measure concurrent and crash recovery behavior. Record exact
host and runtime evidence in VERIFICATION.md. Describe maintainer responsibility for
release acceptance, compatibility evidence, and dependency updates. Document local tool
variability and the limits of host execution. Review every changed line and complete an
independent code review before the final report.
