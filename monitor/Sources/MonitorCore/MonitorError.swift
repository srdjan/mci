public enum StatusError: Error, Equatable, Sendable {
    case notFile
    case json(String)
    case shape
    case logger
    case state
    case exitCode
    case read(String)

    /// Category names shared with the Deno fixtures.
    public var category: String {
        switch self {
        case .notFile: "not-file"
        case .json: "json"
        case .shape: "shape"
        case .logger: "logger"
        case .state: "state"
        case .exitCode: "exit-code"
        case .read: "read"
        }
    }

    /// Message text equal to the messages of `readCiStatus` in `src/ci.ts`.
    public var message: String {
        switch self {
        case .notFile: "CI status must be a real file"
        case .json(let reason): "invalid CI status JSON: \(reason)"
        case .shape: "invalid CI status shape"
        case .logger: "invalid CI logger identity"
        case .state: "invalid CI status state"
        case .exitCode: "invalid CI status exit code"
        case .read(let reason): reason
        }
    }
}
