import Foundation

public enum SnapshotError: Error, Equatable, Sendable {
    case json
    case shape(String)
    case notFile
    case read(String)

    public var message: String {
        switch self {
        case .json: "The daemon snapshot is not valid JSON."
        case .shape(let detail): detail
        case .notFile: "The daemon snapshot is not a regular file."
        case .read(let detail): "Cannot read the daemon snapshot: \(detail)"
        }
    }
}

public enum TerminalKind: String, Equatable, Sendable {
    case success, failure, timeout, cancelled, interrupted
}

public struct DaemonTerminal: Equatable, Sendable {
    public let id: String
    public let repositoryID: String
    public let workflow: String
    public let job: String
    public let started: String
    public let finished: String
    public let kind: TerminalKind
    public let code: Int
    public let completed: Int
    public let total: Int
    public let detail: String
    public let log: String
}

public struct DaemonActive: Equatable, Sendable {
    public let id: String
    public let workflow: String
    public let job: String
    public let started: String
    public let step: String?
    public let log: String
}

public struct DaemonRepository: Equatable, Sendable {
    public let id: String
    public let path: String
    public let queued: Int
    public let active: DaemonActive?
    public let latest: DaemonTerminal?
    public let blocked: String?

    public init(
        id: String, path: String, queued: Int, active: DaemonActive?,
        latest: DaemonTerminal?, blocked: String?
    ) {
        self.id = id
        self.path = path
        self.queued = queued
        self.active = active
        self.latest = latest
        self.blocked = blocked
    }
}

public struct DaemonSnapshot: Equatable, Sendable {
    public let version: Int
    public let instance: String
    public let pid: Int
    public let updated: String
    public let repositories: [DaemonRepository]
}

public enum DaemonErrorTag: String, Equatable, Sendable {
    case invalid, unavailable, unregistered, busy, storage
}

public enum DaemonResponse: Equatable, Sendable {
    case ok(DaemonSnapshot)
    case error(DaemonErrorTag, String)
}

private let snapshotMaxSafeInteger = 9_007_199_254_740_991.0

private func snapshotNumber(_ value: Any?) -> Double? {
    guard let candidate = value as? NSNumber,
        CFGetTypeID(candidate) != CFBooleanGetTypeID()
    else { return nil }
    return candidate.doubleValue
}

private func snapshotInteger(_ value: Any?) -> Int? {
    guard let candidate = snapshotNumber(value), candidate.isFinite,
        candidate == candidate.rounded(), candidate >= 0,
        candidate <= snapshotMaxSafeInteger
    else { return nil }
    return Int(candidate)
}

private func snapshotString(_ value: Any?) -> String? {
    guard let text = value as? String, !text.contains("\0") else { return nil }
    return text
}

private func snapshotNonempty(_ value: Any?) -> String? {
    guard let text = snapshotString(value), !text.isEmpty else { return nil }
    return text
}

private func exactKeys(_ object: [String: Any], _ keys: Set<String>) -> Bool {
    object.count == keys.count && Set(object.keys) == keys
}

private func decodeActive(_ value: Any) -> DaemonActive? {
    guard let object = value as? [String: Any],
        exactKeys(object, ["id", "workflow", "job", "started", "step", "log"]),
        let id = snapshotNonempty(object["id"]),
        let workflow = snapshotNonempty(object["workflow"]),
        let job = snapshotNonempty(object["job"]),
        let started = snapshotString(object["started"]), parseTimestamp(started) != nil,
        let log = snapshotNonempty(object["log"]), log.hasPrefix("/")
    else { return nil }

    let step: String?
    if object["step"] is NSNull {
        step = nil
    } else if let text = snapshotString(object["step"]) {
        step = text
    } else {
        return nil
    }
    return DaemonActive(
        id: id, workflow: workflow, job: job, started: started, step: step, log: log)
}

private func decodeTerminal(_ value: Any) -> DaemonTerminal? {
    let fields: Set<String> = [
        "id", "repositoryId", "workflow", "job", "started", "finished", "kind", "code",
        "completed", "total", "detail", "log",
    ]
    guard let object = value as? [String: Any], exactKeys(object, fields),
        let id = snapshotNonempty(object["id"]),
        let repositoryID = snapshotNonempty(object["repositoryId"]),
        let workflow = snapshotNonempty(object["workflow"]),
        let job = snapshotNonempty(object["job"]),
        let started = snapshotString(object["started"]), parseTimestamp(started) != nil,
        let finished = snapshotString(object["finished"]), parseTimestamp(finished) != nil,
        finished >= started,
        let kindText = snapshotString(object["kind"]),
        let kind = TerminalKind(rawValue: kindText),
        let code = snapshotInteger(object["code"]),
        let completed = snapshotInteger(object["completed"]),
        let total = snapshotInteger(object["total"]), completed <= total,
        let detail = snapshotString(object["detail"]),
        let log = snapshotNonempty(object["log"]), log.hasPrefix("/"),
        (kind == .success && code == 0) || (kind != .success && code != 0)
    else { return nil }
    return DaemonTerminal(
        id: id, repositoryID: repositoryID, workflow: workflow, job: job, started: started,
        finished: finished, kind: kind, code: code, completed: completed, total: total,
        detail: detail, log: log)
}

/// Decodes the exact version 1 snapshot shape from `src/protocol.ts`.
public func decodeSnapshot(_ value: Any) -> Result<DaemonSnapshot, SnapshotError> {
    let fields: Set<String> = ["version", "instance", "pid", "updated", "repositories"]
    guard let object = value as? [String: Any], exactKeys(object, fields),
        snapshotNumber(object["version"]) == 1,
        let instance = snapshotNonempty(object["instance"]),
        let pid = snapshotInteger(object["pid"]), pid >= 1,
        let updated = snapshotString(object["updated"]), parseTimestamp(updated) != nil,
        let values = object["repositories"] as? [Any]
    else { return .failure(.shape("Invalid daemon snapshot.")) }

    var repositories: [DaemonRepository] = []
    var ids = Set<String>()
    var paths = Set<String>()
    let repositoryFields: Set<String> = ["id", "path", "queued", "active", "latest", "blocked"]
    for value in values {
        guard let repository = value as? [String: Any],
            exactKeys(repository, repositoryFields),
            let id = snapshotNonempty(repository["id"]),
            let path = snapshotNonempty(repository["path"]), path.hasPrefix("/"),
            let queued = snapshotInteger(repository["queued"])
        else { return .failure(.shape("Invalid repository snapshot.")) }

        let active: DaemonActive?
        if repository["active"] is NSNull {
            active = nil
        } else if let decoded = decodeActive(repository["active"]!) {
            active = decoded
        } else {
            return .failure(.shape("Invalid active record."))
        }

        let latest: DaemonTerminal?
        if repository["latest"] is NSNull {
            latest = nil
        } else if let decoded = decodeTerminal(repository["latest"]!) {
            latest = decoded
        } else {
            return .failure(.shape("Invalid terminal record."))
        }

        let blocked: String?
        if repository["blocked"] is NSNull {
            blocked = nil
        } else if let text = snapshotString(repository["blocked"]) {
            blocked = text
        } else {
            return .failure(.shape("Invalid blocked reason."))
        }

        guard ids.insert(id).inserted, paths.insert(path).inserted else {
            return .failure(.shape("Duplicate repository."))
        }
        guard latest?.repositoryID == nil || latest?.repositoryID == id else {
            return .failure(.shape("A result belongs to another repository."))
        }
        repositories.append(
            DaemonRepository(
                id: id, path: path, queued: queued, active: active, latest: latest,
                blocked: blocked))
    }
    return .success(
        DaemonSnapshot(
            version: 1, instance: instance, pid: pid, updated: updated,
            repositories: repositories))
}

public func decodeSnapshot(data: Data) -> Result<DaemonSnapshot, SnapshotError> {
    do {
        let value = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return decodeSnapshot(value)
    } catch {
        return .failure(.json)
    }
}

public func decodeDaemonResponse(data: Data) -> Result<DaemonResponse, SnapshotError> {
    let parsed: Any
    do {
        parsed = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    } catch {
        return .failure(.json)
    }
    guard let object = parsed as? [String: Any], snapshotNumber(object["version"]) == 1 else {
        return .failure(.shape("Invalid daemon response."))
    }
    if object["type"] as? String == "ok",
        exactKeys(object, ["version", "type", "snapshot"])
    {
        return decodeSnapshot(object["snapshot"]!).map(DaemonResponse.ok)
    }
    if object["type"] as? String == "error",
        exactKeys(object, ["version", "type", "tag", "detail"]),
        let tagText = snapshotString(object["tag"]),
        let tag = DaemonErrorTag(rawValue: tagText),
        let detail = snapshotString(object["detail"])
    {
        return .success(.error(tag, detail))
    }
    return .failure(.shape("Invalid daemon response."))
}

/// Reads a persisted snapshot without following a symbolic link.
public func readSnapshot(path: String) -> Result<DaemonSnapshot, SnapshotError> {
    var info = stat()
    if lstat(path, &info) != 0 {
        return errno == ENOENT ? .failure(.read("The file does not exist."))
            : .failure(.read(String(cString: strerror(errno))))
    }
    guard (info.st_mode & S_IFMT) == S_IFREG else { return .failure(.notFile) }
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else {
        return errno == ELOOP ? .failure(.notFile)
            : .failure(.read(String(cString: strerror(errno))))
    }
    defer { close(descriptor) }
    guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
        return .failure(.notFile)
    }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    do {
        return decodeSnapshot(data: try handle.readToEnd() ?? Data())
    } catch {
        return .failure(.read(error.localizedDescription))
    }
}
