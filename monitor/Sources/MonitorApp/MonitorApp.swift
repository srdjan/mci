import AppKit
import MonitorCore
import SwiftUI

@MainActor final class MonitorApplicationDelegate: NSObject, NSApplicationDelegate {
    weak var model: MonitorModel?
    private var terminationPending = false

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminationPending { return .terminateLater }
        guard let model else { return .terminateNow }
        let deferred = model.requestTermination {
            sender.reply(toApplicationShouldTerminate: true)
        }
        terminationPending = deferred
        return deferred ? .terminateLater : .terminateNow
    }
}

@main
struct MonitorApp: App {
    @NSApplicationDelegateAdaptor(MonitorApplicationDelegate.self) private var delegate
    // The command line tools ship no SwiftUIMacros plugin, so the app avoids `@State`.
    // `App` is created once, so plain stored properties keep these objects alive.
    // MCI_MONITOR_DAEMON_DIR points a test run at a temporary daemon folder.
    private let model = MonitorModel(
        client: DaemonClient(
            directory: ProcessInfo.processInfo.environment["MCI_MONITOR_DAEMON_DIR"]
                ?? ProcessInfo.processInfo.environment["MCI_MONITOR_REGISTRY_DIR"]
                ?? DaemonClient.defaultDirectory))
    private let loginItem = LoginItem()
    private let presenter = AddRepositoryPresenter()
    private let logPresenter = LogWindowPresenter()

    init() {
        NSApplication.shared.setActivationPolicy(.accessory)
        delegate.model = model
        model.start()
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView(
                model: model, loginItem: loginItem, presenter: presenter,
                logPresenter: logPresenter)
        } label: {
            MenuBarLabel(combined: model.combined)
        }
        .menuBarExtraStyle(.window)
    }
}

struct MenuBarLabel: View {
    let combined: CombinedState

    var body: some View {
        HStack(spacing: 2) {
            Image(nsImage: coloredSymbol(combined.kind))
            if combined.attention > 0 {
                Text("\(combined.attention)")
            }
        }
    }
}
