# Native menu bar monitor design

## Context

The user chose a native menu bar app on 2026-10-03. The app replaced the earlier SwiftBar
monitor.

With user approval, SwiftBar and its local support files were removed. Git history keeps
the earlier implementation.

The monitor observes local CI for all registered repositories. The monitor never starts or
cancels CI.

## Current authority

The shared daemon owns repository registration, active requests, queues, and completed
results. `MonitorCore` decodes the exact version 1 daemon snapshot.

The app requests current status through the private Unix socket. The request has a
one-second deadline and a four MiB response limit.

When the daemon is unavailable, the app reads `snapshot.json`. It shows completed history
from that file and discards stale active and queued data.

The app watches the daemon state directory. It coalesces filesystem events for 100 ms and
refreshes every five seconds.

## Repository actions

The Add repository action sends a register request to the daemon. The app does not edit a
separate registry.

The Unregister repository action sends the stable repository identifier. The daemon
refuses removal while that repository has accepted work.

Open repository uses Finder. Log actions read the selected spool file without changing the
file.

## Display behavior

Each repository row shows one primary state. The possible states are DAEMON UNAVAILABLE,
ERROR, MISSING, INTERRUPTED, FAIL, RUNNING, QUEUED, CANCELLED, PASS, and NO RUNS.

An active request gives the row its RUNNING state. The row also shows the queue count when
queued requests exist.

The latest completed result remains visible below an active request. A separate control
opens that completed result's log.

The main log control opens the active log when a request runs. Otherwise, it opens the
latest completed log.

The combined icon uses the most urgent state. The attention count includes unavailable,
error, missing, interrupted, and failed repositories.

Visible text describes repository states and user actions. The panel does not expose
socket, snapshot, protocol, or storage details.

## Log window

The log window reads only a regular file and refuses symbolic links. It reads the last 256
KiB and replaces invalid UTF-8 sequences.

The parser applies common ANSI SGR foreground colors and bold text. It consumes
unsupported control sequences without showing raw escape text.

The file on disk stays unchanged. The window supports reload, Finder reveal, copying, and
reuse after close.

## Installation and login

The Homebrew package stores the signed app under the formula's `libexec` directory.
`mci setup` copies that app to `~/Applications/mci Monitor.app`.

The installer replaces only an app owned by the mci installer. It restores the prior app
when replacement fails.

The Launch at login control uses `SMAppService.mainApp`. The installer does not change the
user's login preference.

The source installer remains available through `deno task monitor:install`. It requires a
running daemon because registration uses the daemon.

## Historical measurements

On 2026-10-03, the Command Line Tools supplied Swift 6.4. A cold release build took 22-44
seconds across recorded runs.

Warm `deno task verify` took 11 seconds in one recorded run. `MonitorChecks` passed 342
checks in 10 consecutive runs.

Swift Testing macros failed in 10 of 22 runs on that toolchain. The plain check executable
remained the selected test method.

The packaged app passed an ad-hoc signature check. A second source installation replaced
the first app and started it again.

The user checked the panel, colored log window, reload, Finder reveal, copying, window
reuse, Add repository, and Remove.

The user enabled Launch at login and confirmed that reinstall kept the enabled state. A
start at the next login remains unconfirmed.

The earlier manual record did not establish exact update latency, interrupted-state
latency, deleted-watch recovery, or picker cancellation.

## Current verification boundary

The final verification passed 155 Deno tests and 309 native checks. One opposite-platform
test was ignored.

The packaged app passed its signature check and opened after repeated setup. Its native
socket client read results from two concurrent repositories.

The current app still needs a visual and VoiceOver check. No current screenshot
establishes the final panel appearance.

The repository maintainer owns the remaining packaged-app checks. The next user-owned
action is confirmation after the next login.
