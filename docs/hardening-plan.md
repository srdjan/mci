# Architecture hardening plan

## Objective

Address actionable findings from the architecture review without changing trusted local
execution or the selected-job workflow contract.

## Constraints

Work on local main, commit each complete unit, and never push. Use gpt-5.6-sol with high
effort for delegated work. Keep expected failures in Result values and never use the any
type. Keep whole-document YAML validation because malformed YAML has no reliable
selected-job boundary. GitHub serves only as a repository backup service. Automatic CI
runs only through the local Git pre-commit hook. Do not claim Intel, minimum macOS, or
reproducibility evidence without execution results.

## Process supervision

Bound child reaping after termination and retain every cleanup error. Normalize
cancellation reasons at the boundary. Bound native process inspection, output capture,
pipe closure, and inspection child reaping. Expose ProcessRecord with pid, started, and
script fields. Expose optional onStart(record) and onFinish() callbacks that return Result
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

## Configuration and local checks

Read CLI version from deno.json and centralize source and compilation permissions in one
named Deno permission set. Source tasks, compilation, and CLI subprocess tests select that
set. Run tasks directly without an application launcher. The mci task marks its CLI child
for parent supervision. If that task parent exits, the CLI cancels the active job and
cleans the workspace. Standalone execution keeps its existing parent-independent behavior.
Keep the task marker out of workflow environments. Keep local workflow YAML in `ci/`.
Remove the hosted workflow because GitHub provides repository backups only. Install a
tracked pre-commit hook that calls the local CI task. Provide a local installation task
for each clone. Confirm that failed checks block commits and passing checks permit
commits. Keep actual execution evidence separate from intended coverage. Test help,
version, missing workflow, missing Bash, timeout limits, and global YAML validation
boundaries.

## Integration and evidence

Reduce runner responsibility by moving script preparation and lifecycle operations to the
workspace lease. Retain the primary execution detail when temporary cleanup also fails.
Run focused regressions before the full verification suite. Compile and execute the native
binary, run the demo, and measure concurrent and crash recovery behavior. Record exact
host and runtime evidence in VERIFICATION.md. Describe maintainer responsibility for
release acceptance, compatibility evidence, and dependency updates. Document local tool
variability and the limits of host execution. Review every changed line and complete an
independent code review before the final report.

## Accepted follow-up from code review

The complete independent review retained four findings. The task path must stop its CLI
child after parent SIGKILL. Recovery command identity needs an isolated refusal test.
Confirmed cleanup after failed registration must clear stale state. Native ps inspection
must bound capture, termination, and reaping. The process tests also cover already-reaped
launches and finish registration failures. A native probe confirmed that removing the
application launcher alone does not stop a Deno task child after parent SIGKILL.

## Accepted trigger correction

The user replaced hosted checks with automatic CI through the local Git pre-commit hook.
GitHub serves only as a repository backup service. Additional compatibility evidence comes
from local execution on any system that the maintainer intends to support.
