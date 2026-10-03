# Native menu bar monitor plan

## Context

The SwiftBar monitor needs an external app and has a plain look. The user chose a native
menu bar app in this repository (2026-10-03). It replaces the SwiftBar plugin. User
decisions: one combined menu bar icon for all repositories, a SwiftUI popover panel, and
the app's build and checks inside `deno task verify`.

Only this repository used SwiftBar. On 2026-10-03, with user approval, SwiftBar was
uninstalled (`brew uninstall --zap --cask swiftbar`), and its plugin and support folders
were removed. The SwiftBar code leaves the repository before the app work starts, so the
app needs no migration logic.

The rules from `AGENTS.md` stay: the monitor reads saved results, opens logs and
repositories, and never starts CI. Saved files stay under each workspace's `.mci/ci/`.

## Measured facts (2026-10-03, macOS 26.6.2, Command Line Tools only, Swift 6.4)

- A Swift package builds an AppKit or SwiftUI menu bar executable without Xcode.
- A SwiftUI `MenuBarExtra` with `.menuBarExtraStyle(.window)` runs from an ad-hoc signed
  `.app` bundle with `LSUIElement`. `codesign --sign -` and `codesign --verify` pass.
- Cold release build: 44 s. Warm build with no change: about 1 s. Test build after one
  changed file: about 17 s.
- Swift Testing `@Test` failed in 10 of 22 warm runs: "plugin for module 'TestingMacros'
  not found", also with `--disable-sandbox`. The Command Line Tools ship no XCTest.
- A plain check executable without macros passed 10 of 10 runs, at about 1.3 s warm.

Not yet established: log-window and directory-picker presentation from the packaged app,
and `SMAppService` login registration for an ad-hoc signed app. Verification covers both.

## Architecture

`monitor/` holds one Swift package (`monitor/Package.swift`, tools version 6.0, macOS 14):

- `MonitorCore` (library, pure logic): the status decoder, display state, combined state,
  registry format and validation, `ps` output parsing, relative time and duration text,
  and the ANSI SGR parser. Effects go through small protocols (`ProcessInspector`,
  `FileReader`) with native implementations in the app.
- `MonitorApp` (executable): the SwiftUI `MenuBarExtra` panel, file watching, the log
  window, registry editing, and the launch-at-login toggle.
- `MonitorChecks` (executable): plain checks over `MonitorCore` and the shared fixtures.
  It prints one line for each failure and exits 1 on any failure.

### Status decoder (port of `decodeStatus`, `src/ci.ts:58-101`)

The decoder accepts exactly what `readCiStatus` accepts:

- version 1;
- six keys, or seven keys when one is `logger`;
- `state` in running, pass, fail, cancelled;
- `pid` a safe integer of at least 1;
- `started` and `finished` in canonical `toISOString()` form (24 characters,
  `YYYY-MM-DDTHH:MM:SS.mmmZ`), with a round-trip check;
- `logger` null, absent, or exactly `{started: 24 characters, command: non-empty}`;
- `running` with null `finished` and `code`;
- `pass` with code 0, `fail` and `cancelled` with a nonzero code.

A missing file is "no record". A symlink or non-file is an error. Error categories:
`not-file`, `json`, `shape`, `logger`, `state`, `exit-code`, `read`.

### Display state (port of `scripts/monitor.ts:45-140`)

- No record: NO RUNS. Decoder error: ERROR with the category and reason.
- `pass`: PASS. `fail`: FAIL with "exit N". `cancelled`: CANCELLED with "exit N". Each
  completed row shows its duration.
- `running`: inspect the logger with `/bin/ps -ww -o pid=,pgid=,lstart=,command= -p <pid>`
  under `LC_ALL=C`. The deadline is 2 s, as in `src/process.ts`. Exit status nonzero with
  empty stdout means absent. A nonzero status with output, a timeout, a launch failure, or
  unparsable output is an inspection error.
  - Inspection error: ERROR with the reason.
  - A live process and `logger` null: ERROR ("Logger identity is unavailable").
  - PID, start text and command all match: RUNNING.
  - Otherwise: INTERRUPTED.
- A registered workspace that no longer exists, or is not a directory: MISSING.

The app inspects every saved `running` record on each refresh, including records that the
last refresh showed as ERROR.

Combined icon: the most urgent state wins: ERROR, MISSING, INTERRUPTED, FAIL, RUNNING,
CANCELLED, PASS, NO RUNS. The icon is the state's SF Symbol in its color. A count appears
when one or more repositories are in ERROR, MISSING, INTERRUPTED or FAIL.

### Shared fixtures (decoder drift guard)

The Deno adapter writes `status.json`, so the drift risk sits in the decoder.
`tests/fixtures/monitor/decode/*.json` hold `text` (raw file content) and `expected`:
either `{ "ok": <canonical decoded value> }` or `{ "error": "<category>" }`. Both
`MonitorChecks` and the Deno test `tests/monitor_fixtures_test.ts` assert every fixture,
so both decoders must agree. The Deno test maps `readCiStatus` messages to the same
categories. Fixtures cover every rule above, missing and extra keys, non-canonical
timestamps, a PID of 0, a negative code, and a malformed logger.

Display expectations live only in `MonitorChecks`, because Swift is the only display
implementation after migration. Those checks use a fake `ProcessInspector` for match,
absent, changed start, changed command, timeout, launch failure and malformed output. They
use temporary directories for the missing file, symlink, non-file and missing workspace
cases.

### Registry

`~/Library/Application Support/meeci/monitor.json`:
`{ "version": 1, "workspaces": ["/abs/path", ...] }`.

- Writers hold an exclusive `flock` on `monitor.json.lock` in the same directory around
  read, validate, modify, and rename. Deno uses `FsFile.lock`, and Swift uses `flock(2)`.
- A writer canonicalizes each new path (`realPath`), requires a directory, and removes
  duplicates.
- A malformed or unknown-version registry is left unchanged, and the writer reports an
  error.
- Writers: `deno task monitor:install [workspace]`, the panel's "Add repository…", and the
  row action "Remove from monitor".

### Updates

- The app watches the registry's parent directory, not the file, because writers replace
  the file by rename.
- It watches each workspace's `.mci/ci/` directory with a `DispatchSource` vnode source.
- On a delete, rename or revoke event, the app cancels the source, closes the descriptor,
  and recreates the watch.
- A 5 s timer refreshes the following:
  - relative times;
  - the RUNNING logger identity, because the death of the logger changes no file;
  - workspaces that are missing or that have no `.mci/ci/` yet;
  - all watches.
- Timing: a status change in a watched directory shows within 1 s. The first CI run in a
  workspace without `.mci/ci/` shows within 5 s.

### Panel (SwiftUI)

- **Header:** "mci local CI".
- **One row for each repository:** a colored state symbol, the repository name, the state
  word, and a relative time ("2 min ago") or the running time. A second line shows the
  detail for FAIL and CANCELLED ("exit N · duration") and the reason for ERROR,
  INTERRUPTED and MISSING.
- **Row actions:** View log, Open repository (in Finder), Remove from monitor.
- **Footer:** Add repository…, Launch at login, Quit.

Windows and panels from an accessory app:

- The log window is a retained `NSWindowController` that hosts SwiftUI content. It calls
  `NSApp.activate()` and `makeKeyAndOrderFront`. The same window is reused for each log.
- "Add repository…" first closes the menu panel. It then activates the app and presents a
  retained `NSOpenPanel` with `begin`, which handles a cancel.

Launch at login:

- The toggle shows the real `SMAppService.mainApp.status` (enabled, requires approval, not
  registered, not found). It refreshes each time the panel opens.
- A registration error appears in the panel.
- The installer never changes the registration.

### Log window

- **Reading:** "View log" reads `.mci/ci/latest.log` only when it is a regular file and
  not a symlink. It reads the last 256 KiB and decodes UTF-8 with replacement characters.
  A missing or invalid log shows a message instead.
- **SGR codes applied:** 0, 1, 22, 30-37, 39, 90-97, and 38;5;n with n in 0-255. Compound
  parameters are supported.
- **Consumed without effect:** 38;2;r;g;b as one unit, other SGR codes, and other CSI
  sequences.
- **Other sequences:** OSC is consumed up to BEL or ST. A malformed escape is dropped up
  to the next printable character.
- **The file on disk stays raw.** This implements Decision 3 (keep the log raw) with a
  better display than `less -R`.

## Deno side

`scripts/install-monitor.ts` (rewrite) uses injected capabilities:

- bundle destination;
- app quit and app open;
- the clock.

Tests pass temporary paths and no-op app actions. The installer has no preference lookup
or plugin directories. The install order:

1. Check that `swift` exists, before any change.
2. Run `swift build -c release --package-path monitor`.
3. Assemble the bundle in a staging directory next to the destination.
   - Write `Info.plist` with `LSUIElement`, bundle id `dev.meeci.monitor`, the version
     from `deno.json`, and the ownership key `MCIInstaller = meeci`.
   - Ad-hoc sign the staged bundle and run `codesign --verify`.
4. Replace `~/Applications/mci Monitor.app` only if the destination is not a symlink and
   its `Info.plist` carries `MCIInstaller = meeci` and the expected executable.
   - Quit the running app first (`pkill` on the bundle's executable path).
   - Rename the old bundle to a backup, rename the staged bundle into place, then remove
     the backup.
   - When a step fails, restore the backup.
5. Add the requested workspace to the registry.
6. Open the app and confirm that its process runs.

Other changes:

- **`scripts/app-check.ts`:**
  - On macOS, it runs `swift build -c release --package-path monitor`, then
    `swift run -c release --package-path monitor MonitorChecks`. It runs once in each
    `verify`.
  - On other systems, it prints that the native app was not validated.
  - A missing `swift` on macOS fails the check.
- **`deno.json`:**
  - `verify` ends with `deno task app:check`.
  - `app:check` runs with `--allow-run=swift`.
  - `monitor:install` gets read and write access, `HOME`, and run access limited to
    `swift`, `/usr/bin/codesign`, `/usr/bin/open`, `/usr/bin/pkill` and `/usr/bin/pgrep`.
- **New Deno tests cover:**
  - the registry lock, canonicalization, deduplication and malformed-file refusal;
  - the bundle replacement guard and rollback;
  - the decoder fixtures.
- **`.gitignore`:** add `monitor/.build/`.

## Documents

- `README.md`: the monitor section.
- `docs/design.md`: the module table and the monitor section.
- `VERIFICATION.md`: add the cold-build cost and the measured hook time.
- `AGENTS.md`: replace "SwiftBar monitor" with "menu bar app", and keep the rule that the
  monitor never starts CI.

## Execution

Step 0 (Opus, before the parts): remove `scripts/monitor.ts`,
`scripts/install-monitor.ts`, `tests/monitor_test.ts`, the `monitor` and `monitor:install`
tasks, and the SwiftBar text in the documents. Commit it separately.

Opus then dispatches three Sonnet parts:

- **Part A:** the Swift package (core, checks, app panel) and the decoder fixtures.
- **Part B:** the Deno installer, `app:check`, task changes, registry and tests. Parts B
  and C start after Part A and run in parallel, because they change separate files.
- **Part C:** the log window and the SGR parser.

Opus reviews each diff, runs the checks, and commits each part separately. The install
into `~/Applications` and the login-item test each need user approval before they run.

## Verification

1. `deno task verify` passes, including `app:check`. Record the hook time, both warm and
   after a Swift change. `MonitorChecks` passes 10 of 10 separate runs, for stability
   evidence only.
2. Installer tests use temporary destinations and no-op app actions. They cover staging,
   signing failure, rollback, ownership refusal, and the registry update.
3. With approval, install for meeci and check the following:
   - The app starts, and the panel shows meeci with its current state.
   - A CI run moves the row to RUNNING and back within 1 s of each status change.
   - Killing a running logger shows INTERRUPTED within 5 s.
   - Deleting and recreating `.mci/ci/` recovers the watch.
4. Windows in the packaged app:
   - The log window opens, closes and reopens.
   - The directory picker opens and accepts a folder, and a cancel leaves the registry
     unchanged.
   - The log shows colors, and the file stays unchanged.
5. With approval: enable launch at login, read the status, rebuild and reinstall, and read
   the status again. The user confirms the behavior at the next login.
