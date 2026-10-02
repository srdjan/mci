# Architecture hardening worklog

## Objective and constraints

Resolve all actionable findings from the architecture review and execute
`docs/hardening-plan.md`. Work on local main, commit each complete unit, and never push.
Use gpt-5.6-sol with high effort for delegated work. Keep expected failures in Result
values and keep the trusted local execution contract.

The user now requires GitHub only as a repository backup service. Automatic CI runs only
through the local Git pre-commit hook. This direction replaces the earlier hosted checks.
The correction removes the hosted workflow and installs the tracked hook locally.
Repository instructions now bind future agents to this rule.

## Active monitor work

The user accepted SwiftBar and requested direct Deno task calls from CI YAML. The user
also authorized installation and configuration of SwiftBar on this Mac. The current tree
starts clean at c17bbc1 with version 0.1.1. `docs/ci-monitor-plan.md` defines saved logs,
status, menu actions, installation, cancellation, and verification. GitHub remains a
backup service, and the pre-commit hook remains the only automatic CI trigger. The advisor
route is unavailable because the preflight cannot identify the parent runtime.

Root owns integration and app configuration. The CI and monitor implementations use fresh
Sol workers with high effort and exclusive file ownership. Native execution is the
selected engine. Root reviewed the CI files and corrected status validation, saved
diagnostics, and exit ordering during the implementation review.

The CI logging unit is committed at f8cb8f2. Its hook passed 62 tests with one platform
test ignored. The hook saved pass status and its full output beneath `.mci/ci/`. Native
probes confirmed that task parent or logger SIGKILL stops the workflow and clears its
journal. The CI correction unit is committed at 7ccec05. Its hook passed all 80 active
tests and saved the logger identity with pass status.

SwiftBar 2.1.1 is installed with a dedicated plugin folder at
`~/Library/Application Support/meeci/SwiftBar`. Root installed the updated executable
plugin and confirmed PASS output with an empty environment and restricted PATH. App
startup remains incomplete under native inspection. Visual menu confirmation remains
pending. The user owns that confirmation after opening SwiftBar.

## Monitor review and correction evidence

The simplification reviews considered reuse, quality, and efficiency. Root removed
duplicate cancellation state and duplicate exit correction. Root retained private helpers,
explicit presentation values, and input ordering. Those alternatives add cross-adapter
coupling or change observable failure order without a material benefit. Native measurement
confirmed that `Deno.kill` requires unrestricted run permission for another process. The
final monitor uses bounded `/bin/ps` inspection with narrow permission and reuses the
existing process identity parser.

The independent review covers the complete change from c17bbc1. Seven Sol reviewers
completed correctness, standards, testing, maintainability, security, reliability, and
adversarial checks. No reviewer failed. The report completed at
`/tmp/compound-engineering-501/ce-code-review/20261002-133409-6e101b7d/review.json`. The
validator confirmed five functional defects. Root applied all five corrections.

A log symlink could truncate an unrelated file and change its mode. The adapter now
rejects symlinks and atomically replaces regular logs with private new files. Public
regressions confirm preservation of symlink targets and other hard links. The adapter
publishes running status before replacing the previous log. A publication failure now
preserves that log and launches no child.

Cancellation could return zero and save an unreadable cancelled record. The adapter now
converts a cancelled zero exit to the interruption code. A public regression confirms
cancelled state and exit 143. Nonzero child exits retain their original codes.

Repository commas could split the monitor's read grant. The generated plugin now enters
the quoted repository path and uses `--allow-read=.`. A copied source fixture confirms
plugin execution from a path with commas and shell punctuation.

A reused PID could make an interrupted logger appear active. Status now records the
logger's native start text and command. The monitor requires those values to match. Public
tests confirm rejection of changed identities and unconfirmed legacy running records.
Completed legacy records remain readable.

The added adapter lifecycle test closes the review's testing gap. Killing a disposable
parent cancels the workflow, clears the journal, records cancellation, and permits another
writer. An additional installer test confirms refusal of the internal cache through a
parent symlink. Root corrected test cleanup after lint rejected throws within finally.

Root reviewed the actual changes and ran all 80 tests with one Linux-only test ignored.
Formatting, linting, type checking, layer checks, suppression checks, and native
compilation pass. The compiled binary reports 0.1.1 and passes example validation and
execution. Every new test completed within one second.

Root retained separate supervision adapters and private URL helpers. Both adapters have
public lifecycle coverage; moving the helpers would expand this feature into CLI cleanup.
The review's concurrent plugin replacement limit remains: another writer can change the
target after ownership inspection. The installer checks ownership twice and preserves
ordinary foreign collisions, but it cannot coordinate an unrelated writer.

Raw logs retain workflow output by design. Private directories and files protect the
records within the accepted local account contract. The plugin executes repository source
by design, so source updates change its behavior without another installation. The
completion advisor route remains unavailable because the parent runtime is unidentified.
Root retains responsibility for final checks and acceptance.

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

The trigger correction adds `.githooks/pre-commit` and `deno task hooks:install`. The
local Git configuration selects `.githooks`. The main agent reviewed the hook and task
changes and checked the shell syntax. A temporary repository with spaces confirmed that
failed checks block commits and passing checks permit commits. The installed hook also
passed all 54 active tests when invoked from `src/`.

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

## Architecture hardening evidence and limits

The architecture hardening suite passed 54 tests with no failures and one Linux-only test
ignored. Formatting, linting, type checking, local workflow execution, the demo, and
native compilation pass. The compiled CLI passes validation and execution, including a
separate workspace with spaces. `VERIFICATION.md` records the host, commands, and
compatibility limits.

Recovery remains best effort because inspection and signaling are separate operations.
Current Linux, Intel macOS, minimum macOS, and binary distribution results remain
unavailable. Additional compatibility checks run locally on any claimed systems. Hosted
checks are outside the accepted scope. All commits remain local; the main agent did not
push.

## Next action

Git runs local CI before the next normal commit. The repository maintainer owns local
commits, repository backups, and any additional local compatibility evidence before
release acceptance.
