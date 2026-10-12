import AppKit

/// Presents one retained open panel. A cancel does nothing.
@MainActor
final class AddRepositoryPresenter {
    private var panel: NSOpenPanel?

    func present(onChoose: @escaping @MainActor (String) -> Void) {
        if let panel {
            panel.makeKeyAndOrderFront(nil)
            return
        }
        NSApp.keyWindow?.orderOut(nil)
        NSApp.activate()
        let chooser = NSOpenPanel()
        chooser.canChooseDirectories = true
        chooser.canChooseFiles = false
        chooser.allowsMultipleSelection = false
        chooser.prompt = "Add"
        chooser.message = "Choose a repository folder. The monitor registers it with the daemon."
        panel = chooser
        chooser.begin { [weak self] response in
            MainActor.assumeIsolated {
                let path = response == .OK ? chooser.url?.path : nil
                self?.panel = nil
                if let path { onChoose(path) }
            }
        }
    }
}
