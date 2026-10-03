import Foundation

public enum DisplayColor: String, Equatable, Sendable {
    case green, red, orange, blue, gray
}

public enum DisplayKind: String, CaseIterable, Equatable, Sendable {
    case noRuns, pass, fail, cancelled, running, interrupted, error, missing

    public var label: String {
        switch self {
        case .noRuns: "NO RUNS"
        case .pass: "PASS"
        case .fail: "FAIL"
        case .cancelled: "CANCELLED"
        case .running: "RUNNING"
        case .interrupted: "INTERRUPTED"
        case .error: "ERROR"
        case .missing: "MISSING"
        }
    }

    public var symbol: String {
        switch self {
        case .noRuns: "minus.circle"
        case .pass: "checkmark.circle.fill"
        case .fail: "xmark.circle.fill"
        case .cancelled: "stop.circle.fill"
        case .running: "arrow.triangle.2.circlepath"
        case .interrupted: "exclamationmark.triangle.fill"
        case .error: "exclamationmark.triangle.fill"
        case .missing: "folder.badge.questionmark"
        }
    }

    public var color: DisplayColor {
        switch self {
        case .noRuns: .gray
        case .pass: .green
        case .fail: .red
        case .cancelled: .orange
        case .running: .blue
        case .interrupted: .orange
        case .error: .red
        case .missing: .red
        }
    }

    /// Lower values are more urgent.
    public var urgency: Int {
        switch self {
        case .error: 0
        case .missing: 1
        case .interrupted: 2
        case .fail: 3
        case .running: 4
        case .cancelled: 5
        case .pass: 6
        case .noRuns: 7
        }
    }

    public var needsAttention: Bool {
        switch self {
        case .error, .missing, .interrupted, .fail: true
        case .running, .cancelled, .pass, .noRuns: false
        }
    }
}

public struct RowState: Equatable, Sendable {
    public let workspace: String
    public let name: String
    public let kind: DisplayKind
    public let lastRun: Date?
    public let code: Int?
    public let duration: TimeInterval?
    public let detail: String?

    public init(
        workspace: String, kind: DisplayKind, lastRun: Date? = nil, code: Int? = nil,
        duration: TimeInterval? = nil, detail: String? = nil
    ) {
        self.workspace = workspace
        self.name = repositoryName(workspace)
        self.kind = kind
        self.lastRun = lastRun
        self.code = code
        self.duration = duration
        self.detail = detail
    }
}

public func repositoryName(_ workspace: String) -> String {
    let name = workspace.split(separator: "/").last.map(String.init) ?? ""
    return name.isEmpty ? "mci" : name
}

private func completedRow(workspace: String, status: CiStatus) -> RowState {
    let started = parseTimestamp(status.started)
    let finished = status.finished.flatMap(parseTimestamp)
    let duration = started.flatMap { start in finished.map { $0.timeIntervalSince(start) } }
    let length = duration.map(durationText)
    let kind: DisplayKind
    let detail: String?
    switch status.state {
    case .pass:
        kind = .pass
        detail = length
    case .fail, .cancelled:
        kind = status.state == .fail ? .fail : .cancelled
        detail = [status.code.map { "exit \($0)" }, length].compactMap { $0 }
            .joined(separator: " \u{00B7} ")
    case .running:
        kind = .running
        detail = nil
    }
    return RowState(
        workspace: workspace, kind: kind, lastRun: finished ?? started, code: status.code,
        duration: duration, detail: detail)
}

private func runningRow(
    workspace: String, status: CiStatus, inspection: Result<ProcessIdentity?, MonitorError>
) -> RowState {
    let started = parseTimestamp(status.started)
    func row(_ kind: DisplayKind, _ detail: String) -> RowState {
        RowState(workspace: workspace, kind: kind, lastRun: started, detail: detail)
    }
    switch inspection {
    case .failure(let error):
        return row(.error, "Logger inspection failed: \(error.message)")
    case .success(let identity):
        if identity != nil && status.logger == nil {
            return row(.error, "Logger identity is unavailable")
        }
        if let identity, let logger = status.logger, identity.pid == status.pid,
            identity.started == logger.started, identity.command == logger.command
        {
            return RowState(workspace: workspace, kind: .running, lastRun: started)
        }
        return row(.interrupted, "The recorded CI logger is no longer running.")
    }
}

private func isDirectory(_ path: String) -> Bool {
    var directory: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &directory)
        && directory.boolValue
}

/// Port of the display rules of `scripts/monitor.ts`, plus the missing-workspace rule.
public func rowState(workspace: String, inspector: any ProcessInspector) async -> RowState {
    guard isDirectory(workspace) else {
        return RowState(
            workspace: workspace, kind: .missing,
            detail: "The repository folder is missing or is not a folder.")
    }
    switch readCiStatus(workspace: workspace) {
    case .failure(let error):
        return RowState(
            workspace: workspace, kind: .error, detail: "\(error.category): \(error.message)")
    case .success(nil):
        return RowState(workspace: workspace, kind: .noRuns)
    case .success(let status?):
        guard status.state == .running else {
            return completedRow(workspace: workspace, status: status)
        }
        let inspection = await inspector.inspect(pid: status.pid)
        return runningRow(workspace: workspace, status: status, inspection: inspection)
    }
}

public struct CombinedState: Equatable, Sendable {
    public let kind: DisplayKind
    public let attention: Int
}

public func combinedState(_ rows: [RowState]) -> CombinedState {
    let kind = rows.map(\.kind).min { $0.urgency < $1.urgency } ?? .noRuns
    return CombinedState(kind: kind, attention: rows.filter { $0.kind.needsAttention }.count)
}
