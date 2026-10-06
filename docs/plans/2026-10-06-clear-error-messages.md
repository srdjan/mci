# Clear messages in the menu bar

## Scope

Add a Clear pill to the daemon, action, and login-item error banners. Clear hides the
current message. The app keeps daemon availability and repository status unchanged.
Repeated daemon polls keep the same cleared message hidden. A changed message or a new
failure after recovery appears again. A new action can report the same error again.

## Existing work

The checkout already contains edits for hook inspection and installation. Some of those
edits affect MonitorModel.swift and PanelView.swift. This change must preserve those edits
and keep them outside its local commit.

## Plan and ownership

The main agent owns message state, banner integration, public behavior checks,
installation, and the local commit. The ErrorNotice worker owns the reusable pill
component. I will check the native build and public message behavior before installing the
app. I will run the repository checks and the local pre-commit hook. The user owns the
final visual check in the menu bar.

## Results

The user selected error banners only. The repository error details remain visible. The
native build and all eight checks for message clearing passed. An isolated snapshot of the
Clear change passed 260 native checks without the existing hook edits. The current
checkout passed `deno task verify`: 279 tests passed, one platform test was skipped, and
293 native checks passed.

The installer replaced and opened the monitor app. The app still monitors this checkout.
The visual appearance and mouse interaction require the user's menu bar check. The main
agent owns the local commit. The user owns the next visual check and repository backups.
