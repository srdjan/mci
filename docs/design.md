# Implementation design

This repository implements the initial macOS local CI design in Deno, as requested. The
earlier document proposed Go; TypeScript and native Deno APIs replace that implementation
choice. The workflow scope remains intentionally small.

## Boundaries

| Module        | Owns                                                       | Does not own                         |
| ------------- | ---------------------------------------------------------- | ------------------------------------ |
| `workflow.ts` | Parse YAML, validate subset, produce an ordered plan       | Filesystem, process launch, triggers |
| `process.ts`  | One isolated process group and its cleanup                 | Workflow syntax, scheduling          |
| `runner.ts`   | Workspace resolution, step loop, environment, job deadline | Git operations, actions              |
| `cli.ts`      | Arguments, macOS gate, diagnostics and OS signal listeners | A daemon or API server               |
| `result.ts`   | Typed success/failure and boundary exception conversion    | Exceptions as domain control flow    |

The only external package is `yaml@2.8.1`, pinned with integrity in `deno.lock`. Its
document AST allows aliases, tags and non-string keys to be rejected without misreading
shell script text. YAML 1.2 core schema preserves `on` as a string. Parser errors include
source locations; semantic errors include a workflow path.

## Execution contract

1. Load a single workflow and select one job. Validate the full selected job and shared
   configuration before performing any workflow effects.
2. Resolve Bash from the original invocation PATH once. Resolve the workspace to a
   canonical absolute directory.
3. For each step, resolve its working directory at execution time. Require it to exist and
   remain inside the canonical workspace. A prior step may create it.
4. Write the run text to a private temporary script. Launch native `Deno.Command` with
   `detached: true`, closed stdin, inherited output and the explicit merged environment.
   On POSIX, the detached child leads a separate process group; `Deno.kill(-pid, signal)`
   addresses that group.
5. Await exit or cancellation, then clean up the group before advancing. An ordinary
   failure stops remaining steps. Remove temporary scripts on the handled return path.

The job timer starts immediately before the first process launch and remains active
between steps and through normal process cleanup. Cancellation is checked before every
launch. Timeout ends execution but cleanup can add two seconds plus OS scheduling/reaping
time. This is not a hard real-time deadline. The first abort reason wins; an
already-observed failing exit remains a failure. Cleanup errors are reported as execution
failures rather than success.

Process supervision is internally POSIX-compatible to allow Linux regression tests. The
public CLI refuses `run` on other platforms and does not provide a platform override flag.
There is no Node runtime or native helper.

## Small clarifications to the original document

- Require Deno 2.9.7 or newer, matching the verified runtime; older releases are not
  claimed to support this implementation's detached-process API.
- Cap job timeouts at 35791 minutes to fit JavaScript's timer range.
- Reject all explicit YAML tags, including standard tags, to avoid coercion surprises.
  Unused anchors are harmless, but aliases are rejected.
- Report the actual OS kernel release, architecture and resolved shell. A runner label
  does not claim that a particular GitHub-hosted macOS image is reproduced.
- Failed preflight, including missing Bash, uses exit 2. Missing commands inside a step
  are execution failures and use exit 1.
- `completed` counts steps whose shell exited, including a failing step; cancellation does
  not count its interrupted step as completed.

## Deliberate limits

This is trusted local execution. Path validation prevents accidental directory
configuration escapes; scripts can still access the rest of the host. Detached or
daemonized descendants can escape cleanup. SIGKILL of the runner may leave processes and
temporary files. There are no snapshots, locks, recovery journal, secret masking, outputs,
caches or cleanup of project-generated files.

The shell and installed tools are part of the local environment. A local pass does not
certify a clean commit, toolchain reproducibility, hosted-image parity or results for
unselected jobs. If those become requirements, revisit the product boundary before
extending the interpreter.
