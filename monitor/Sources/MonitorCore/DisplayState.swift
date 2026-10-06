import Foundation

public enum DisplayColor: String, Equatable, Sendable {
    case green, red, orange, blue, gray
}

public enum DisplayKind: String, CaseIterable, Equatable, Sendable {
    case noRuns, pass, fail, cancelled, queued, running, interrupted, error, missing, unavailable

    public var label: String {
        switch self {
        case .noRuns: "NO RUNS"
        case .pass: "PASS"
        case .fail: "FAIL"
        case .cancelled: "CANCELLED"
        case .queued: "QUEUED"
        case .running: "RUNNING"
        case .interrupted: "INTERRUPTED"
        case .error: "ERROR"
        case .missing: "MISSING"
        case .unavailable: "DAEMON UNAVAILABLE"
        }
    }

    public var symbol: String {
        switch self {
        case .noRuns: "minus.circle"
        case .pass: "checkmark.circle.fill"
        case .fail: "xmark.circle.fill"
        case .cancelled: "stop.circle.fill"
        case .queued: "clock.fill"
        case .running: "arrow.triangle.2.circlepath"
        case .interrupted: "exclamationmark.triangle.fill"
        case .error: "exclamationmark.triangle.fill"
        case .missing: "folder.badge.questionmark"
        case .unavailable: "bolt.slash.fill"
        }
    }

    public var color: DisplayColor {
        switch self {
        case .noRuns: .gray
        case .pass: .green
        case .fail: .red
        case .cancelled: .orange
        case .queued: .blue
        case .running: .blue
        case .interrupted: .orange
        case .error: .red
        case .missing: .red
        case .unavailable: .red
        }
    }

    /// Lower values are more urgent.
    public var urgency: Int {
        switch self {
        case .unavailable: 0
        case .error: 1
        case .missing: 2
        case .interrupted: 3
        case .fail: 4
        case .running: 5
        case .queued: 6
        case .cancelled: 7
        case .pass: 8
        case .noRuns: 9
        }
    }

    public var needsAttention: Bool {
        switch self {
        case .unavailable, .error, .missing, .interrupted, .fail: true
        case .running, .queued, .cancelled, .pass, .noRuns: false
        }
    }
}

public struct RowState: Equatable, Sendable {
    public let repositoryID: String
    public let workspace: String
    public let name: String
    public let kind: DisplayKind
    public let lastRun: Date?
    public let code: Int?
    public let duration: TimeInterval?
    public let detail: String?
    public let queued: Int
    public let active: DaemonActive?
    public let latest: DaemonTerminal?
    public let hookReadiness: HookReadiness?

    public init(
        workspace: String, kind: DisplayKind, lastRun: Date? = nil, code: Int? = nil,
        duration: TimeInterval? = nil, detail: String? = nil,
        hookReadiness: HookReadiness? = nil
    ) {
        self.repositoryID = workspace
        self.workspace = workspace
        self.name = repositoryName(workspace)
        self.kind = kind
        self.lastRun = lastRun
        self.code = code
        self.duration = duration
        self.detail = detail
        self.queued = 0
        self.active = nil
        self.latest = nil
        self.hookReadiness = hookReadiness
    }

    public init(
        repository: DaemonRepository, kind: DisplayKind, lastRun: Date?,
        duration: TimeInterval?, detail: String?, hookReadiness: HookReadiness? = nil
    ) {
        self.repositoryID = repository.id
        self.workspace = repository.path
        self.name = repositoryName(repository.path)
        self.kind = kind
        self.lastRun = lastRun
        self.code = repository.latest?.code
        self.duration = duration
        self.detail = detail
        self.queued = repository.queued
        self.active = repository.active
        self.latest = repository.latest
        self.hookReadiness = hookReadiness
    }

    public var selectedLog: String? { active?.log ?? latest?.log }
}

public func repositoryName(_ workspace: String) -> String {
    let name = workspace.split(separator: "/").last.map(String.init) ?? ""
    return name.isEmpty ? "mci" : name
}

private func isDirectory(_ path: String) -> Bool {
    var directory: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &directory)
        && directory.boolValue
}

public struct CombinedState: Equatable, Sendable {
    public let kind: DisplayKind
    public let attention: Int
}

public func combinedState(_ rows: [RowState], daemonAvailable: Bool = true) -> CombinedState {
    let kind = daemonAvailable
        ? rows.map(\.kind).min { $0.urgency < $1.urgency } ?? .noRuns : .unavailable
    let hookIssue = rows.contains { $0.hookReadiness?.needsAttention == true }
    let combinedKind = daemonAvailable && hookIssue && kind.urgency > DisplayKind.error.urgency
        ? .error : kind
    return CombinedState(
        kind: combinedKind,
        attention: rows.filter { $0.kind.needsAttention || $0.hookReadiness?.needsAttention == true }.count)
}

private func terminalDisplayKind(_ kind: TerminalKind) -> DisplayKind {
    switch kind {
    case .success: .pass
    case .failure: .fail
    case .timeout, .interrupted: .interrupted
    case .cancelled: .cancelled
    }
}

private func terminalDuration(_ terminal: DaemonTerminal) -> TimeInterval? {
    guard let started = parseTimestamp(terminal.started),
        let finished = parseTimestamp(terminal.finished)
    else { return nil }
    return finished.timeIntervalSince(started)
}

private func terminalDetail(_ terminal: DaemonTerminal, duration: TimeInterval?) -> String? {
    var parts: [String] = []
    if !terminal.detail.isEmpty { parts.append(terminal.detail) }
    if terminal.kind != .success { parts.append("exit \(terminal.code)") }
    if let duration { parts.append(durationText(duration)) }
    return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
}

/// Builds a row from daemon authority. A stale snapshot contributes completed history only.
public func rowState(
    repository: DaemonRepository, daemonAvailable: Bool, hookReadiness: HookReadiness? = nil
) -> RowState {
    let repository = daemonAvailable
        ? repository
        : DaemonRepository(
            id: repository.id, path: repository.path, queued: 0, active: nil,
            latest: repository.latest, blocked: nil)
    let latest = repository.latest
    let finished = latest.flatMap { parseTimestamp($0.finished) }
    let duration = latest.flatMap(terminalDuration)
    let latestDetail = latest.flatMap { terminalDetail($0, duration: duration) }

    if !isDirectory(repository.path) {
        return RowState(
            repository: repository, kind: .missing, lastRun: finished, duration: duration,
            detail: "The repository folder is missing or is not a folder.", hookReadiness: hookReadiness)
    }
    if !daemonAvailable {
        let kind = latest.map { terminalDisplayKind($0.kind) } ?? .unavailable
        return RowState(
            repository: repository, kind: kind, lastRun: finished, duration: duration,
            detail: latestDetail, hookReadiness: hookReadiness)
    }
    if let blocked = repository.blocked {
        return RowState(
            repository: repository, kind: .error, lastRun: finished, duration: duration,
            detail: blocked, hookReadiness: hookReadiness)
    }
    if let active = repository.active {
        return RowState(
            repository: repository, kind: .running, lastRun: parseTimestamp(active.started),
            duration: duration, detail: active.step, hookReadiness: hookReadiness)
    }
    if repository.queued > 0 {
        let noun = repository.queued == 1 ? "job" : "jobs"
        return RowState(
            repository: repository, kind: .queued, lastRun: finished, duration: duration,
            detail: "\(repository.queued) \(noun) queued", hookReadiness: hookReadiness)
    }
    if let latest {
        return RowState(
            repository: repository, kind: terminalDisplayKind(latest.kind), lastRun: finished,
            duration: duration, detail: latestDetail, hookReadiness: hookReadiness)
    }
    return RowState(
        repository: repository, kind: .noRuns, lastRun: nil, duration: nil, detail: nil,
        hookReadiness: hookReadiness)
}

public func terminalSummary(_ terminal: DaemonTerminal, now: Date) -> String {
    let result: String
    switch terminal.kind {
    case .success: result = "passed"
    case .failure: result = "failed"
    case .timeout: result = "timed out"
    case .cancelled: result = "cancelled"
    case .interrupted: result = "interrupted"
    }
    let when = parseTimestamp(terminal.finished).map { relativeTime(from: $0, now: now) }
    let duration = terminalDuration(terminal).map(durationText)
    let code = terminal.kind == .success ? nil : "exit \(terminal.code)"
    let parts: [String?] = [
        "Last run \(result)", when, terminal.detail.isEmpty ? nil : terminal.detail,
        code, duration,
    ]
    return parts.compactMap { $0 }.joined(separator: " \u{00B7} ")
}

extension HookReadiness {
    public var needsAttention: Bool {
        switch self {
        case .installed: false
        case .required, .checkFailed: true
        }
    }
}
