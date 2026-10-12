---
title: Pin the commit gate to the packaged daemon before large source edits
date: 2026-10-12
module: daemon
component: development_workflow
problem_type: workflow_issue
severity: high
applies_when:
  - "A refactor changes src/ across several commits while the pre-commit gate runs"
  - "The daemon that answers the default service socket was started from this checkout"
  - "A change touches the worker input, the worker control record, or the CLI import graph"
tags: [commit-gate, daemon, worker, homebrew, measurement]
---

# Pin the commit gate to the packaged daemon before large source edits

## Context

The pre-commit hook submits `ci/local-ci.yml`, job `check`, to the daemon that answers the
default service socket. During the 2026-10-11 re-base, that daemon was a source daemon
from the checkout, started five days earlier. The Homebrew package on the host was an
older release, and its service was not running.

A source daemon starts each worker through the Deno executable with the checkout's
`src/main.ts` (`src/daemon.ts:325`, `src/runtime.ts:19-20`). The daemon process keeps the
code that it loaded at start. Each worker loads the current working tree. The worker input
decoder is strict (`src/worker.ts:60`). So a change to the worker input shape, or an
import error in the tree, makes the next worker fail in a daemon that still sends the old
shape. Every commit then fails until the daemon restarts.

The plan validation found this before any source edit. The fix was a P0 phase.

## Guidance

Before a multi-commit change to `src/`, make the gate run on a fixed build:

```sh
deno task package
cp dist/tap/Formula/mci.rb "$(brew --repo local/meeci)/Formula/mci.rb"
# Stop any source daemon that answers the default socket first.
brew reinstall local/meeci/mci
mci setup            # starts the Homebrew service when no daemon answers
mci status
ps -axo command | grep '[m]ci daemon'   # expect /opt/homebrew/opt/mci/bin/mci daemon
```

Then make one small commit to prove that the gate passes on the package. After the change,
package and install again, then make one more commit on the new build.

For development, run a source daemon only with an isolated `MCI_HOME`, as `README.md`
describes in "Development". That daemon never answers the gate.

## Why This Matters

A gate that loads code from the tree under edit does not check the change. It also runs
it. A half-done refactor can block every commit, and the cause looks like a test failure,
not a stale daemon.

Three measurement traps showed up in the same work:

- CI steps run Bash with `pipefail`. A loop such as
  `for i in 1 2 3; do checks | grep FAIL; done` stops at the first failing run. Add
  `|| true` to each run, or the loop reports fewer runs than it claims.
- `kill -9 $!` after a background shell function kills the subshell, not the daemon. The
  first crash test "passed" because the daemon never died. Start the daemon command
  directly in the background, and confirm that the PID names the daemon before the kill.
- A flaky native timing check was first blamed on launchd scheduling. A 10-run probe of
  the old checks showed 1 failure under the service and 2 in a terminal. The checks
  themselves were flaky. Measure both environments before a cause enters a plan.

## When to Apply

Apply the guidance when a change spans several commits and touches daemon, worker, CLI, or
protocol code. A documentation-only change does not need it. Check the effective daemon
first: `ps -axo pid,lstart,command | grep '[m]ci.*daemon'`.

## Examples

On 2026-10-11 the gate daemon was `deno run ... src/main.ts daemon`, pid 19884. P0 ran
`deno task stop` (now removed), `brew reinstall`, and `mci setup`. The plan commit then
passed the gate on `/opt/homebrew/opt/mci/bin/mci daemon` and its packaged workers. The P1
to P8 commits could not reach the gate through source edits. P9 installed the final build
in the same way. The first commit on that build also passed the gate.
