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
cancellation reasons at the boundary. Expose ProcessRecord with pid, started, and script
fields. Expose optional onStart(record) and onFinish() callbacks that return Result
values. Use ps -ww with a fixed locale and require PID equals PGID. Compare exact start
text and the unique script path immediately before each recovery signal. Recovery remains
best effort because inspection and signaling are separate OS operations. If the leader is
absent but its group exists, preserve the journal and require manual recovery. If a
command changes after exec, preserve the journal and require manual recovery. Treat an
already-reaped short process as complete when identity capture finds no leader. Keep the
existing two-second termination grace period as policy, not a measured capacity estimate.
Test native supervision and injected OS failures through the public process API with small
capability records.

## Workspace lifecycle

Own workspace exclusion, private scripts, and recovery in src/workspace.ts. Keep a
permanent .mci/lock inode and hold a nonblocking exclusive Deno file lock for the entire
run. Store private scripts beneath .mci/run-* and store one atomic journal in
.mci/run.json. Persist version, runDir, and process: null before script creation or
process launch. Clear the process record only after group cleanup and direct-child reaping
succeed. Reject a competing run before it performs workflow effects. On the next run,
recover the recorded process through recoverProcess and remove abandoned private script
directories. Validate journal data and restrict removal to immediate run-* directories
beneath the canonical state directory. Do not silently discard an uncertain process
identity or failed recovery. Expose acquireWorkspace(workspace) returning a lease with
directory, record(ProcessRecord | null), and close() Result methods. The lease also
exposes prepare(step, index) for contained directory resolution and private script
creation. The runner records each launched process and closes the lease on every handled
return. Retain recovery evidence when recovery or cleanup fails. Release the file lock
last, including after an uncertain cleanup failure. Preserve the primary result and append
process, journal, directory, and lock cleanup errors in stable order. Document the
unavoidable interval between process creation and journal persistence. Document advisory
locking and the ability of trusted scripts to replace the lock inode.

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
