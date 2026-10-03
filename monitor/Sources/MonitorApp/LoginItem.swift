import Observation
import ServiceManagement

/// The toggle is always enabled. An app that was never registered reports `.notFound`, and
/// `register()` still works for the installed, ad-hoc signed bundle. A failed registration
/// shows its error.
@MainActor @Observable
final class LoginItem {
    private(set) var status: SMAppService.Status = SMAppService.mainApp.status
    private(set) var error: String?

    var isOn: Bool { status == .enabled }

    var note: String? {
        status == .requiresApproval ? "Approve in System Settings > General > Login Items" : nil
    }

    /// A status change removes an earlier error, for example after an approval in System
    /// Settings.
    func refresh() {
        let current = SMAppService.mainApp.status
        if current != status { error = nil }
        status = current
    }

    /// Changes the registration. Only the toggle calls this. The error of this attempt stays
    /// visible even when the status changes.
    func set(_ on: Bool) {
        var failure: String?
        do {
            if on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            failure = error.localizedDescription
        }
        status = SMAppService.mainApp.status
        error = failure
    }
}
