import Foundation

/// Watches one directory. The descriptor opens with `O_EVTONLY`, so it blocks no unmount.
@MainActor
final class DirectoryWatcher {
    private let path: String
    private let onChange: @MainActor () -> Void
    private var source: DispatchSourceFileSystemObject?

    init(path: String, onChange: @escaping @MainActor () -> Void) {
        self.path = path
        self.onChange = onChange
    }

    var isActive: Bool { source != nil }

    /// Opens the watch when it is not active. A missing directory leaves it inactive.
    func ensureActive() {
        guard source == nil else { return }
        let descriptor = open(path, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let watch = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .delete, .rename, .revoke, .extend, .attrib, .link],
            queue: .main)
        watch.setEventHandler { [weak self, weak watch] in
            guard let watch else { return }
            let events = watch.data
            MainActor.assumeIsolated { self?.handle(events, from: watch) }
        }
        watch.setCancelHandler { close(descriptor) }
        source = watch
        watch.resume()
    }

    func cancel() {
        source?.cancel()
        source = nil
    }

    private func handle(
        _ events: DispatchSource.FileSystemEvent, from watch: DispatchSourceFileSystemObject
    ) {
        guard source === watch else { return }
        if !events.isDisjoint(with: [.delete, .rename, .revoke]) {
            cancel()
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { self?.ensureActive() }
            }
        }
        onChange()
    }
}
