# Architecture hardening worklog

## Objective and constraints

Resolve all actionable findings from the architecture review and execute
`docs/hardening-plan.md`. Work on local main, commit each complete unit, and never push.
Use gpt-5.6-sol with high effort for delegated work. Keep expected failures in Result
values and keep the trusted local execution contract.

## Starting evidence

The starting tree was clean at 7a0ab4c. The Apple Silicon macOS baseline passed
formatting, linting, type checking, and 18 tests. One Linux-only test was ignored. A
native probe confirmed that a competing holder cannot acquire the file lock. Closing the
first holder released that lock.

## Completed work

Local commits contain bounded process supervision, workspace exclusion, private scripts,
recovery journals, runner integration, shared configuration, and separate local and hosted
workflows. The design document records journal states, recovery limits, diagnostics, and
release ownership. Whole-document YAML validation remains necessary before job selection.

Two runner regressions failed before their fixes. A competing run modified the same
workspace. A cleanup failure hid exit code 23. Both public behavior tests now pass.

The independent review used six personas and confirmed four findings. The user required
Sol agents, so an independent adversarial reviewer replaced the alternate-provider review.
The review completed without failed reviewers. Its receipt resides at
`/tmp/compound-engineering-501/ce-code-review/20261002-114148-3deaf535/review.json`.

The task parent could die after SIGKILL while its CLI continued and held the workspace
lock. The CLI now detects task parent death and cancels through its cleanup path. A native
public CLI test confirms cleanup and a successful next run. Named Deno permissions now
supply source, test, and compilation permissions without an application launcher.

Recovery lacked an isolated test for a changed command with matching PID, group, and start
identity. The new public test confirms refusal without any signal. Failed registration
could retain a stale process record after confirmed cleanup. The process module now clears
that record only after group cleanup and reaping succeed. The tests retain registration
and finish diagnostics together.

Native ps capture could wait without a deadline and retain the workspace lock. The capture
module now bounds inspection, pipe closure, and reaping. Its timeout test confirms forced
termination. Added public tests cover completed children without identities and finish
registration failure after exit code 23.

An independent focused review confirmed closure of all four findings. The main agent
reviewed every follow-up change and ran the complete verification suite.

## Review decisions

Reuse and quality reviews removed duplicate diagnostics and shared ordered workspace
cleanup. The efficiency review proposed fewer recovery inspections and streamed directory
enumeration. Those changes alter identity failure timing or permit partial cleanup before
enumeration fails. The main agent retained the existing safety behavior.

The maintainability review proposed separate capability types but established no material
defect or maintenance failure. The main agent rejected that preference. The existing
design document records the recovery reasoning, so another solution document would
duplicate it.

The advisor preflight could not identify the parent runtime at initiation or completion.
The advisor route remained unavailable. The main agent retained ownership of verification
and acceptance.

## Final evidence and limits

The full suite passes 54 tests with no failures and one Linux-only test ignored.
Formatting, linting, type checking, local workflow execution, the demo, and native
compilation pass. The compiled CLI passes validation and execution, including a separate
workspace with spaces. `VERIFICATION.md` records the host, commands, and compatibility
limits.

Recovery remains best effort because inspection and signaling are separate operations.
Current Linux, Intel macOS, hosted CI, minimum macOS, and binary distribution results
remain unavailable. Configured hosted checks do not establish passing results. All commits
remain local; the main agent did not push.

## Next action

The repository maintainer owns pushing the local commits, observing hosted checks, and
collecting the remaining compatibility evidence before release acceptance.
