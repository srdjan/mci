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
                if case .failure(let error) = await hookInstaller.install(repository: path) {
                    actionError = "Repository registered. Hook installation failed: \(error.message)"
                    actionUncertain = false
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
                case .failure: rows = []
                }
            }
        } while refreshAgain
        refreshing = false
    }

    private func use(snapshot: DaemonSnapshot, daemonAvailable: Bool) {
        self.daemonAvailable = daemonAvailable
        daemonError = daemonAvailable ? nil : daemonError
        rows = snapshot.repositories.map {
            rowState(repository: $0, daemonAvailable: daemonAvailable)
        }
    }
}
