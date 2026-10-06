# Start and stop mci

## Objective

`deno task start` starts the daemon and menu bar monitor, then returns. `deno task stop`
stops both components and waits for shutdown.

## Constraints

Work stays on local main. The completed change receives one local commit. The user owns
pushes. The pre-commit hook remains the only automatic CI trigger.

Start and stop do not submit CI. Stop cancels active requests and drops queued requests.
Expected failures use the existing Result type. Tests use public functions and simple
capability records.

## Direction and evidence

The daemon already handles SIGTERM through graceful shutdown in `src/daemon.ts`. The
monitor installer already builds, signs, installs, registers, and opens the app. The
monitor installer exposes capabilities for opening, quitting, and checking the app. Deno
supports detached children and `unref()`. These features let start return without leaving
terminal output connected.

The live daemon snapshot identifies the daemon process. Process inspection can detect a
changed process identity before signaling.

## Plan

I will add a source lifecycle script and two Deno tasks. Start reuses a responding daemon
or launches a detached source daemon with saved output. Start registers the checkout and
opens the installed monitor. If the monitor is absent, start installs it. Start waits for
daemon and monitor readiness. Failure rolls back only components started by this
invocation.

Stop disables a matching Homebrew service before signaling the daemon, so the service
cannot restart it. Stop quits the monitor and waits for daemon termination. Repeated stop
succeeds when both components are absent. Stop reports failures from both components
instead of skipping cleanup after one failure.

I will update README commands and add public behavior tests. I will run focused tests, a
subprocess smoke check, the full repository gate, and the pre-commit hook.

## Current status

The Deno tasks, lifecycle script, README commands, and behavior tests are complete. Start
reuses the daemon and reopens the shared monitor for the selected state directory. The
source record uses an atomic write. Stop can terminate an unresponsive source daemon when
its saved identity matches.

The host has a monitor with the former installer name, `meeci`. Commit `d0ae999` confirms
that mci previously used this name. Start will migrate this recognized app through the
existing installer. The installer keeps a backup until startup succeeds and validates the
previous signature before replacement. All 27 installer tests pass, including migration,
rollback, and invalid-signature refusal.

The host has a loaded Homebrew service named `sh.brew.mci` and a separate source daemon.
Default stop must disable that service even when the responding daemon has a different
PID. The main agent owns integration, verification, the local commit, and the final
report.

## Verification

The main agent ran the checks on this macOS host. `deno task verify` passed with 274
tests, one platform test skipped, and 252 native checks. The import checks and suppression
checks passed. The lifecycle suite contains 20 public behavior tests.

An isolated subprocess check confirmed that the source daemon survives the start command's
exit. Stop removed that daemon process and socket. Repeated stop succeeded. A second check
removed the socket before stop. Stop terminated the daemon through its matching saved
identity. A symlink check preserved the target file and stopped the new daemon after
record rejection. The recording script stays gitignored in `demos/service-smoke.ts`.

Native start migrated the previous monitor and registered this checkout. Repeated start
succeeded. Native stop removed the source daemon, the monitor, and the loaded Homebrew
daemon. Homebrew reported no running or loaded mci service. A fresh source start restored
the daemon and monitor.

The native checks establish process startup and shutdown. These checks do not establish
menu appearance or startup at the next login.

The user owns routine start and stop commands and any later repository backup.
