import Observation
import ServiceManagement

@MainActor @Observable
final class LoginItem {
    private(set) var status: SMAppService.Status = SMAppService.mainApp.status
    private(set) var error: String?

    var isOn: Bool { status == .enabled }

    var note: String? {
        switch status {
        case .requiresApproval: "Approve in System Settings > General > Login Items"
        case .enabled, .notRegistered, .notFound: nil
        @unknown default: nil
        }
    }

    /// An app that was never registered reports `.notFound`, and `register()` still works
    /// for the installed, ad-hoc signed bundle. A failed registration shows its error.
    var canToggle: Bool { true }

    func refresh() {
        status = SMAppService.mainApp.status
    }

    /// Changes the registration. Only the toggle calls this.
    func set(_ on: Bool) {
        do {
            if on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        refresh()
    }
}
