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
        case .notFound: "Available after install"
        case .enabled, .notRegistered: nil
        @unknown default: nil
        }
    }

    var canToggle: Bool { status != .notFound }

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
