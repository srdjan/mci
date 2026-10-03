import Foundation

/// The workspace list in `<directory>/monitor.json`, guarded by `<directory>/monitor.json.lock`.
public struct Registry: Sendable {
    public let directory: String

    public init(directory: String = Registry.defaultDirectory) {
        self.directory = directory
    }

    public static var defaultDirectory: String {
        NSHomeDirectory() + "/Library/Application Support/meeci"
    }

    public var file: String { directory + "/monitor.json" }
    private var lockFile: String { directory + "/monitor.json.lock" }

    /// A missing file is an empty registry. Malformed content is an error.
    public func load() -> Result<[String], MonitorError> {
        let data: Data
        do {
            data = try Data(contentsOf: URL(fileURLWithPath: file))
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return .success([])
        } catch {
            return .failure(.registry("Cannot read the registry: \(error.localizedDescription)"))
        }
        return Registry.decode(data)
    }

    public func add(_ path: String) -> Result<[String], MonitorError> {
        guard path.hasPrefix("/") else {
            return .failure(.registry("The repository path must be absolute."))
        }
        guard let real = canonicalDirectory(path) else {
            return .failure(.registry("The repository path is not a folder: \(path)"))
        }
        return update { workspaces in
            workspaces.contains(real) ? workspaces : workspaces + [real]
        }
    }

    public func remove(_ path: String) -> Result<[String], MonitorError> {
        let real = canonicalDirectory(path)
        return update { workspaces in
            workspaces.filter { $0 != path && $0 != real }
        }
    }

    static func decode(_ data: Data) -> Result<[String], MonitorError> {
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            return .failure(.registry("The registry is not valid JSON."))
        }
        guard let object = parsed as? [String: Any], object.count == 2,
            let version = object["version"] as? NSNumber,
            CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
            let workspaces = object["workspaces"] as? [Any]
        else { return .failure(.registry("The registry has an unknown format or version.")) }
        var paths: [String] = []
        for entry in workspaces {
            guard let path = entry as? String, path.hasPrefix("/") else {
                return .failure(.registry("The registry holds an entry that is not a path."))
            }
            paths.append(path)
        }
        return .success(paths)
    }

    private func encode(_ workspaces: [String]) -> Result<Data, MonitorError> {
        let object: [String: Any] = ["version": 1, "workspaces": workspaces]
        do {
            let data = try JSONSerialization.data(
                withJSONObject: object,
                options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            return .success(data + Data("\n".utf8))
        } catch {
            return .failure(.registry("Cannot encode the registry."))
        }
    }

    /// Lock, read and validate, change, write a temporary file, rename it over the registry.
    private func update(_ change: ([String]) -> [String]) -> Result<[String], MonitorError> {
        do {
            try FileManager.default.createDirectory(
                atPath: directory, withIntermediateDirectories: true)
        } catch {
            return .failure(.registry("Cannot create the registry folder: \(error.localizedDescription)"))
        }
        let descriptor = open(lockFile, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else {
            return .failure(.registry("Cannot open the registry lock: \(errnoText())"))
        }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else {
            return .failure(.registry("Cannot lock the registry: \(errnoText())"))
        }
        defer { flock(descriptor, LOCK_UN) }

        let current: [String]
        switch load() {
        case .failure(let error): return .failure(error)
        case .success(let workspaces): current = workspaces
        }
        let updated = change(current)
        if updated == current {
            return .success(current)
        }
        let data: Data
        switch encode(updated) {
        case .failure(let error): return .failure(error)
        case .success(let encoded): data = encoded
        }
        let temporary = directory + "/monitor.json.\(getpid()).\(UUID().uuidString).tmp"
        do {
            try data.write(to: URL(fileURLWithPath: temporary))
        } catch {
            return .failure(.registry("Cannot write the registry: \(error.localizedDescription)"))
        }
        guard rename(temporary, file) == 0 else {
            let reason = errnoText()
            unlink(temporary)
            return .failure(.registry("Cannot replace the registry: \(reason)"))
        }
        return .success(updated)
    }
}

private func errnoText() -> String { String(cString: strerror(errno)) }

/// The real path of an existing directory, or nil.
func canonicalDirectory(_ path: String) -> String? {
    guard let resolved = realpath(path, nil) else { return nil }
    defer { free(resolved) }
    let real = String(cString: resolved)
    var info = stat()
    guard stat(real, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else { return nil }
    return real
}
