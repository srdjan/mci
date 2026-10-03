import AppKit
import MonitorCore
import Observation

@MainActor @Observable
final class MonitorModel {
    private(set) var rows: [RowState] = []
    private(set) var registryError: String?
    private(set) var actionError: String?

    /// One line for a registry or action failure.
    var message: String? { registryError ?? actionError }

    var combined: CombinedState { combinedState(rows) }

    @ObservationIgnored private let registry: Registry
    @ObservationIgnored private let inspector: any ProcessInspector
    @ObservationIgnored private var workspaces: [String] = []
    @ObservationIgnored private var registryWatcher: DirectoryWatcher?
    @ObservationIgnored private var workspaceWatchers: [String: DirectoryWatcher] = [:]
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var pending: Task<Void, Never>?
    @ObservationIgnored private var timer: Timer?

    init(registry: Registry = Registry(), inspector: any ProcessInspector = NativeProcessInspector()) {
        self.registry = registry
        self.inspector = inspector
    }

    func start() {
        registryWatcher = DirectoryWatcher(path: registry.directory) { [weak self] in
            self?.schedule()
        }
        registryWatcher?.ensureActive()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        refresh()
    }

    /// Coalesces a burst of file events into one refresh.
    func schedule() {
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(100))
            guard !Task.isCancelled else { return }
            self?.refresh()
        }
    }

    func add(path: String) {
        apply(registry.add(path))
    }

    func remove(path: String) {
        apply(registry.remove(path))
    }

    func open(_ row: RowState) {
        NSWorkspace.shared.open(URL(fileURLWithPath: row.workspace, isDirectory: true))
    }

    private func apply(_ result: Result<[String], MonitorError>) {
        switch result {
        case .success: actionError = nil
        case .failure(let error): actionError = error.message
        }
        refresh()
    }

    /// Retries missing watches, then refreshes. It also re-inspects running records.
    private func tick() {
        registryWatcher?.ensureActive()
        for watcher in workspaceWatchers.values { watcher.ensureActive() }
        refresh()
    }

    func refresh() {
        if refreshing {
            refreshAgain = true
            return
        }
        refreshing = true
        Task { await self.runRefresh() }
    }

    private func runRefresh() async {
        repeat {
            refreshAgain = false
            switch registry.load() {
            case .success(let loaded):
                workspaces = loaded
                registryError = nil
            case .failure(let error):
                registryError = error.message
            }
            syncWatchers()
            rows = await Self.compute(workspaces, inspector: inspector)
        } while refreshAgain
        refreshing = false
    }

    private func syncWatchers() {
        for (path, watcher) in workspaceWatchers where !workspaces.contains(path) {
            watcher.cancel()
            workspaceWatchers[path] = nil
        }
        for path in workspaces where workspaceWatchers[path] == nil {
            let watcher = DirectoryWatcher(path: path + "/.mci/ci") { [weak self] in
                self?.schedule()
            }
            workspaceWatchers[path] = watcher
        }
        for watcher in workspaceWatchers.values { watcher.ensureActive() }
    }

    private nonisolated static func compute(
        _ workspaces: [String], inspector: any ProcessInspector
    ) async -> [RowState] {
        await withTaskGroup(of: (Int, RowState).self) { group in
            for (index, workspace) in workspaces.enumerated() {
                group.addTask { (index, await rowState(workspace: workspace, inspector: inspector)) }
            }
            var collected: [(Int, RowState)] = []
            for await item in group { collected.append(item) }
            return collected.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }
}
