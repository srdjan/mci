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
        chooser.message = "Choose a repository folder. mci creates missing CI configuration from defined standard Deno tasks: fmt:check, lint, check, and test. Repository YAML selects optional build or browser tasks. Setup replaces pre-push with pre-commit CI for the selected worktree."
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
