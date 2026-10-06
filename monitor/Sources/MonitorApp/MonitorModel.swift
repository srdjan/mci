import AppKit
import MonitorCore
import Observation

private enum HookPhase { case inspection, installation }

private struct HookOperation {
    let phase: HookPhase
    let task: Task<Void, Never>
}

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
    @ObservationIgnored private var hookReadiness: [String: HookReadiness] = [:]
    private var hookOperations: [String: HookOperation] = [:]

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
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(100))
            guard !Task.isCancelled else { return }
            self?.refresh()
        }
    }

    func add(path: String) {
        Task { [weak self] in
            guard let self else { return }
            switch await client.register(path: path) {
            case .failure(let error):
                await apply(.failure(error))
            case .success(let snapshot):
                actionError = nil
                actionUncertain = false
                use(snapshot: snapshot, daemonAvailable: true)
                let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
                if let row = rows.first(where: { $0.workspace == canonical }) {
                    retryHookInstallation(row)
                }
            }
        }
    }

    func remove(_ row: RowState) {
        Task { [weak self] in
            guard let self else { return }
            await apply(await client.unregister(repository: row.repositoryID))
        }
    }

    func open(_ row: RowState) {
        NSWorkspace.shared.open(URL(fileURLWithPath: row.workspace, isDirectory: true))
    }

    func checkingHook(_ row: RowState) -> Bool {
        hookOperations[row.repositoryID] != nil
    }

    func installingHook(_ row: RowState) -> Bool {
        hookOperations[row.repositoryID]?.phase == .installation
    }

    func retryHookCheck(_ row: RowState) {
        guard daemonAvailable,
            let repository = repositories.first(where: { $0.id == row.repositoryID && $0.path == row.workspace })
        else { return }
        inspectHook(repository)
    }

    func retryHookInstallation(_ row: RowState) {
        guard daemonAvailable, !installingHook(row),
            containsRepository(id: row.repositoryID, path: row.workspace)
        else { return }
        hookOperations.removeValue(forKey: row.repositoryID)?.task.cancel()
        let installer = hookInstaller
        let task = Task { [weak self] in
            let result = await installer.install(repository: row.workspace)
            guard let self, !Task.isCancelled,
                containsRepository(id: row.repositoryID, path: row.workspace)
            else { return }
            hookOperations.removeValue(forKey: row.repositoryID)
            switch result {
            case .success:
                hookReadiness.removeValue(forKey: row.repositoryID)
            case .failure(let error):
                hookReadiness[row.repositoryID] = .required(error.message)
            }
            renderRows()
            refresh()
        }
        hookOperations[row.repositoryID] = HookOperation(
            phase: .installation, task: task)
    }

    private func apply(_ result: Result<DaemonSnapshot, DaemonClientError>) async {
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
                actionError = "The request returned no result. Reload status before you try again."
            }
            refresh()
        }
    }

    private func tick() {
        watcher?.ensureActive()
        refresh()
    }

    func refresh() {
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
            switch await client.status() {
            case .success(let snapshot):
                if actionUncertain {
                    actionError = nil
                    actionUncertain = false
                }
                use(snapshot: snapshot, daemonAvailable: true)
            case .failure(let error):
                daemonAvailable = false
                daemonError = error.message
                let path = client.snapshotPath
                let persisted = await Task.detached(priority: .utility) {
                    readSnapshot(path: path)
                }.value
                switch persisted {
                case .success(let snapshot): use(snapshot: snapshot, daemonAvailable: false)
                case .failure:
                    for operation in hookOperations.values { operation.task.cancel() }
                    hookOperations.removeAll()
                    hookReadiness.removeAll()
                    repositories = []
                    rows = []
                }
            }
        } while refreshAgain
        refreshing = false
    }

    private func use(snapshot: DaemonSnapshot, daemonAvailable: Bool) {
        let paths = Dictionary(uniqueKeysWithValues: snapshot.repositories.map { ($0.id, $0.path) })
        for repository in repositories where paths[repository.id] != repository.path {
            hookOperations.removeValue(forKey: repository.id)?.task.cancel()
            hookReadiness.removeValue(forKey: repository.id)
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
            rowState(repository: $0, daemonAvailable: daemonAvailable, hookReadiness: hookReadiness[$0.id])
        }
    }

    private func inspectHook(_ repository: DaemonRepository) {
        guard hookOperations[repository.id] == nil else { return }
        let installer = hookInstaller
        let task = Task { [weak self] in
            let readiness = await installer.inspect(repository: repository.path)
            guard let self, !Task.isCancelled,
                let current = repositories.first(where: { $0.id == repository.id && $0.path == repository.path })
            else { return }
            hookOperations.removeValue(forKey: repository.id)
            guard hookReadiness[repository.id] != readiness else { return }
            hookReadiness[repository.id] = readiness
            rows = rows.map {
                $0.repositoryID == repository.id
                    ? rowState(repository: current, daemonAvailable: daemonAvailable, hookReadiness: readiness) : $0
            }
        }
        hookOperations[repository.id] = HookOperation(
            phase: .inspection, task: task)
    }
}
