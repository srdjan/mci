import AppKit
import MonitorCore
import Observation

@MainActor @Observable
final class MonitorModel {
    private(set) var rows: [RowState] = []
    private(set) var daemonAvailable = false
    private(set) var daemonError: String? {
        didSet { daemonNotice.update(daemonError) }
    }
    private(set) var actionError: String? {
        didSet { actionNotice = ErrorMessage(actionError) }
    }
    private var daemonNotice = ErrorMessage()
    private var actionNotice = ErrorMessage()

    var message: String? { actionNotice.visibleText ?? daemonNotice.visibleText }

    func clearErrors() {
        daemonNotice.clear()
        actionNotice.clear()
    }
    var combined: CombinedState { combinedState(rows, daemonAvailable: daemonAvailable) }

    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let hookInstaller: HookInstaller
    @ObservationIgnored private var watcher: DirectoryWatcher?
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var pending: Task<Void, Never>?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var actionUncertain = false
    @ObservationIgnored private var repositories: [DaemonRepository] = []
    @ObservationIgnored private var hookRegistrations: [String: UUID] = [:]
    @ObservationIgnored private var hookStatuses: [String: HookStatus] = [:]
    @ObservationIgnored private var pendingHookInstallations: [String: UUID] = [:]
    private var hookInspections: [String: Task<Void, Never>] = [:]
    private let hookLifecycle = HookLifecycle()
    @ObservationIgnored private var closing = false

    init(client: DaemonClient = DaemonClient(), hookInstaller: HookInstaller = HookInstaller()) {
        self.client = client
        self.hookInstaller = hookInstaller
    }

    func start() {
        watcher = DirectoryWatcher(path: client.directory) { [weak self] in self?.schedule() }
        watcher?.ensureActive()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        refresh()
    }

    func schedule() {
        guard !closing else { return }
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(100))
            guard !Task.isCancelled else { return }
            self?.refresh()
        }
    }

    func add(path: String) {
        guard !closing else { return }
        Task { [weak self] in
            guard let self else { return }
            switch await client.register(path: path) {
            case .failure(let error):
                await apply(.failure(error))
            case .success(let snapshot):
                guard !closing else { return }
                actionError = nil
                actionUncertain = false
                use(snapshot: snapshot, daemonAvailable: true)
                let canonical = canonicalPath(path) ?? path
                if let row = rows.first(where: { $0.workspace == canonical }) {
                    if installingHook(row), let registration = hookRegistrations[row.repositoryID] {
                        pendingHookInstallations[row.repositoryID] = registration
                    } else {
                        retryHookInstallation(row)
                    }
                }
            }
        }
    }

    func remove(_ row: RowState) {
        guard !closing else { return }
        hookInspections.removeValue(forKey: row.repositoryID)?.cancel()
        hookLifecycle.cancel(repository: row.repositoryID)
        pendingHookInstallations.removeValue(forKey: row.repositoryID)
        Task { [weak self] in
            guard let self else { return }
            await apply(await client.unregister(repository: row.repositoryID))
        }
    }

    func open(_ row: RowState) {
        NSWorkspace.shared.open(URL(fileURLWithPath: row.workspace, isDirectory: true))
    }

    func checkingHook(_ row: RowState) -> Bool {
        hookInspections[row.repositoryID] != nil || installingHook(row)
    }

    func installingHook(_ row: RowState) -> Bool {
        hookLifecycle.contains(repository: row.repositoryID)
    }

    func retryHookCheck(_ row: RowState) {
        guard !closing, daemonAvailable,
            let repository = repositories.first(where: { $0.id == row.repositoryID && $0.path == row.workspace })
        else { return }
        inspectHook(repository)
    }

    func retryHookInstallation(_ row: RowState) {
        guard !closing, daemonAvailable, !installingHook(row),
            let registration = hookRegistrations[row.repositoryID],
            containsRepository(id: row.repositoryID, path: row.workspace)
        else { return }
        pendingHookInstallations.removeValue(forKey: row.repositoryID)
        hookInspections.removeValue(forKey: row.repositoryID)?.cancel()
        let installer = hookInstaller
        hookLifecycle.start(repository: row.repositoryID, operation: {
            await installer.install(repository: row.workspace)
        }, completion: { [weak self] result in
            guard let self else { return }
            if hookRegistrations[row.repositoryID] == registration,
                containsRepository(id: row.repositoryID, path: row.workspace)
            {
                var status = hookStatuses[row.repositoryID] ?? HookStatus()
                status.recordInstallation(result)
                hookStatuses[row.repositoryID] = status
                renderRows()
            }
            if case .failure(let error) = result {
                actionUncertain = false
                actionError = "\(row.workspace): \(error.message)"
            }
            if let pendingRegistration = pendingHookInstallations.removeValue(forKey: row.repositoryID),
                hookRegistrations[row.repositoryID] == pendingRegistration,
                let current = rows.first(where: { $0.repositoryID == row.repositoryID })
            {
                retryHookInstallation(current)
            }
            refresh()
        })
    }

    func requestTermination(reply: @escaping @MainActor () -> Void) -> Bool {
        closing = true
        pendingHookInstallations.removeAll()
        timer?.invalidate()
        timer = nil
        pending?.cancel()
        pending = nil
        watcher?.cancel()
        watcher = nil
        cancelInspections()
        return hookLifecycle.requestTermination(reply: reply)
    }

    private func cancelInspections() {
        for task in hookInspections.values { task.cancel() }
        hookInspections.removeAll()
    }

    private func invalidateHookRegistration(repository: String) {
        hookInspections.removeValue(forKey: repository)?.cancel()
        hookLifecycle.cancel(repository: repository)
        pendingHookInstallations.removeValue(forKey: repository)
        hookRegistrations.removeValue(forKey: repository)
    }

    private func apply(_ result: Result<DaemonSnapshot, DaemonClientError>) async {
        guard !closing else { return }
        switch result {
        case .success(let snapshot):
            actionError = nil
            actionUncertain = false
            use(snapshot: snapshot, daemonAvailable: true)
        case .failure(let error):
            switch error {
            case .daemon:
                actionUncertain = false
                actionError = error.message
            case .unavailable, .invalidResponse:
                actionUncertain = true
                actionError = "The request returned no result. Wait for the status to refresh, then try again."
            }
            refresh()
        }
    }

    private func tick() {
        watcher?.ensureActive()
        refresh()
    }

    func refresh() {
        guard !closing else { return }
        if refreshing {
            refreshAgain = true
            return
        }
        refreshing = true
        Task { await runRefresh() }
    }

    private func runRefresh() async {
        repeat {
            refreshAgain = false
            let result = await client.status()
            guard !closing else { break }
            switch result {
            case .success(let snapshot):
                if actionUncertain {
                    actionError = nil
                    actionUncertain = false
                }
                use(snapshot: snapshot, daemonAvailable: true)
            case .failure(let error):
                hookLifecycle.cancelAll()
                pendingHookInstallations.removeAll()
                cancelInspections()
                daemonAvailable = false
                daemonError = error.message
                let path = client.snapshotPath
                let persisted = await Task.detached(priority: .utility) {
                    readSnapshot(path: path)
                }.value
                switch persisted {
                case .success(let snapshot): use(snapshot: snapshot, daemonAvailable: false)
                case .failure:
                    hookStatuses.removeAll()
                    hookRegistrations.removeAll()
                    repositories = []
                    rows = []
                }
            }
        } while refreshAgain && !closing
        refreshing = false
    }

    private func use(snapshot: DaemonSnapshot, daemonAvailable: Bool) {
        guard !closing else { return }
        let paths = Dictionary(uniqueKeysWithValues: snapshot.repositories.map { ($0.id, $0.path) })
        for repository in repositories where paths[repository.id] != repository.path {
            invalidateHookRegistration(repository: repository.id)
            hookStatuses.removeValue(forKey: repository.id)
        }
        for repository in snapshot.repositories where hookRegistrations[repository.id] == nil {
            hookRegistrations[repository.id] = UUID()
        }
        repositories = snapshot.repositories
        self.daemonAvailable = daemonAvailable
        daemonError = daemonAvailable ? nil : daemonError
        renderRows()
        if daemonAvailable {
            for repository in repositories { inspectHook(repository) }
        }
    }

    private func containsRepository(id: String, path: String) -> Bool {
        repositories.contains { $0.id == id && $0.path == path }
    }

    private func renderRows() {
        rows = repositories.map {
            rowState(
                repository: $0, daemonAvailable: daemonAvailable,
                hookReadiness: hookStatuses[$0.id]?.displayedReadiness)
        }
    }

    private func inspectHook(_ repository: DaemonRepository) {
        guard !closing, hookInspections[repository.id] == nil,
            !hookLifecycle.contains(repository: repository.id),
            let registration = hookRegistrations[repository.id]
        else { return }
        let installer = hookInstaller
        let task = Task { [weak self] in
            let readiness = await installer.inspect(repository: repository.path)
            guard let self, !Task.isCancelled,
                hookRegistrations[repository.id] == registration,
                let current = repositories.first(where: { $0.id == repository.id && $0.path == repository.path })
            else { return }
            hookInspections.removeValue(forKey: repository.id)
            var status = hookStatuses[repository.id] ?? HookStatus()
            let previousReadiness = status.displayedReadiness
            status.recordInspection(readiness)
            hookStatuses[repository.id] = status
            guard previousReadiness != status.displayedReadiness else { return }
            rows = rows.map {
                $0.repositoryID == repository.id
                    ? rowState(
                        repository: current, daemonAvailable: daemonAvailable,
                        hookReadiness: status.displayedReadiness) : $0
            }
        }
        hookInspections[repository.id] = task
    }
}
