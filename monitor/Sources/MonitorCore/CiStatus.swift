import Foundation

public enum CiState: String, Equatable, Sendable {
    case running, pass, fail, cancelled
}

public struct LoggerIdentity: Equatable, Sendable {
    public let started: String
    public let command: String

    public init(started: String, command: String) {
        self.started = started
        self.command = command
    }
}

public struct CiStatus: Equatable, Sendable {
    public let version: Int
    public let logger: LoggerIdentity?
    public let state: CiState
    public let pid: Int
    public let started: String
    public let finished: String?
    public let code: Int?

    public init(
        version: Int = 1, logger: LoggerIdentity?, state: CiState, pid: Int,
        started: String, finished: String?, code: Int?
    ) {
        self.version = version
        self.logger = logger
        self.state = state
        self.pid = pid
        self.started = started
        self.finished = finished
        self.code = code
    }
}

private let maxSafeInteger = 9_007_199_254_740_991.0

/// A JSON number. A JSON boolean is not a number, as in `typeof value === "number"`.
private func number(_ value: Any?) -> Double? {
    guard let candidate = value as? NSNumber,
        CFGetTypeID(candidate) != CFBooleanGetTypeID()
    else { return nil }
    return candidate.doubleValue
}

private func safeInteger(_ value: Any?) -> Int? {
    guard let candidate = number(value), candidate.isFinite,
        candidate == candidate.rounded(), abs(candidate) <= maxSafeInteger
    else { return nil }
    return Int(candidate)
}

private func isNull(_ value: Any?) -> Bool { value is NSNull }

private func daysInMonth(year: Int, month: Int) -> Int {
    switch month {
    case 2: (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28
    case 4, 6, 9, 11: 30
    default: 31
    }
}

/// Days from 1970-01-01 to a proleptic Gregorian date.
private func daysSinceEpoch(year: Int, month: Int, day: Int) -> Int {
    let shifted = month <= 2 ? year - 1 : year
    let era = (shifted >= 0 ? shifted : shifted - 399) / 400
    let yearOfEra = shifted - era * 400
    let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
    let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
    return era * 146_097 + dayOfEra - 719_468
}

/// The date of a canonical `toISOString()` text, or nil for any other text.
/// The calendar check equals the round trip of `new Date(Date.parse(text)).toISOString()`.
public func parseTimestamp(_ text: String) -> Date? {
    let shape = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
    guard text.utf8.count == 24, text.range(of: shape, options: .regularExpression) != nil
    else { return nil }
    let digits = Array(text.utf8)
    func field(_ start: Int, _ length: Int) -> Int {
        digits[start..<start + length].reduce(0) { $0 * 10 + Int($1) - 48 }
    }
    let year = field(0, 4), month = field(5, 2), day = field(8, 2)
    let hour = field(11, 2), minute = field(14, 2), second = field(17, 2)
    let millis = field(20, 3)
    guard (1...12).contains(month), day >= 1, day <= daysInMonth(year: year, month: month),
        hour < 24, minute < 60, second < 60
    else { return nil }
    let seconds = daysSinceEpoch(year: year, month: month, day: day) * 86400
        + hour * 3600 + minute * 60 + second
    return Date(timeIntervalSince1970: Double(seconds) + Double(millis) / 1000)
}

private func timestamp(_ value: Any?) -> String? {
    guard let text = value as? String, parseTimestamp(text) != nil else { return nil }
    return text
}

private func decodeLogger(_ value: Any?) -> Result<LoggerIdentity?, StatusError> {
    guard let value, !isNull(value) else { return .success(nil) }
    guard let object = value as? [String: Any], object.count == 2,
        let started = object["started"] as? String, started.utf16.count == 24,
        let command = object["command"] as? String, !command.isEmpty
    else { return .failure(.logger) }
    return .success(LoggerIdentity(started: started, command: command))
}

private func ciState(_ value: Any?) -> CiState? {
    (value as? String).flatMap(CiState.init(rawValue:))
}

/// Port of `decodeStatus` in `src/ci.ts`. The order of the checks decides the error category.
public func decodeStatus(_ value: Any) -> Result<CiStatus, StatusError> {
    guard let object = value as? [String: Any],
        object.count == 6 || (object.count == 7 && object["logger"] != nil),
        number(object["version"]) == 1,
        let state = ciState(object["state"]),
        let pid = safeInteger(object["pid"]), pid >= 1,
        let started = timestamp(object["started"])
    else { return .failure(.shape) }

    let logger: LoggerIdentity?
    switch decodeLogger(object["logger"]) {
    case .failure(let error): return .failure(error)
    case .success(let decoded): logger = decoded
    }

    if state == .running {
        guard isNull(object["finished"]), isNull(object["code"]) else {
            return .failure(.state)
        }
        return .success(
            CiStatus(
                logger: logger, state: state, pid: pid, started: started, finished: nil,
                code: nil))
    }
    guard let finished = timestamp(object["finished"]),
        let code = safeInteger(object["code"]), code >= 0
    else { return .failure(.state) }
    if (state == .pass && code != 0) || (state != .pass && code == 0) {
        return .failure(.exitCode)
    }
    return .success(
        CiStatus(
            logger: logger, state: state, pid: pid, started: started, finished: finished,
            code: code))
}

public func decodeStatus(data: Data) -> Result<CiStatus, StatusError> {
    do {
        let parsed = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return decodeStatus(parsed)
    } catch {
        return .failure(.json(error.localizedDescription))
    }
}

public func statusPath(workspace: String) -> String {
    let trimmed = workspace.hasSuffix("/") ? String(workspace.dropLast()) : workspace
    return trimmed + "/.mci/ci/status.json"
}

/// Port of `readCiStatus`. A missing file is no record (`nil`).
public func readCiStatus(workspace: String) -> Result<CiStatus?, StatusError> {
    let path = statusPath(workspace: workspace)
    var info = stat()
    if lstat(path, &info) != 0 {
        if errno == ENOENT { return .success(nil) }
        return .failure(.read(String(cString: strerror(errno))))
    }
    guard (info.st_mode & S_IFMT) == S_IFREG else { return .failure(.notFile) }
    let data: Data
    do {
        data = try Data(contentsOf: URL(fileURLWithPath: path))
    } catch {
        return .failure(.read(error.localizedDescription))
    }
    return decodeStatus(data: data).map { Optional($0) }
}
