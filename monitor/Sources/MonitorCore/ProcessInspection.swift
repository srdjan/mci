import Foundation

public struct ProcessIdentity: Equatable, Sendable {
    public let pid: Int
    public let pgid: Int
    public let started: String
    public let command: String

    public init(pid: Int, pgid: Int, started: String, command: String) {
        self.pid = pid
        self.pgid = pgid
        self.started = started
        self.command = command
    }
}

public protocol ProcessInspector: Sendable {
    /// `.success(nil)` means that no such process exists.
    func inspect(pid: Int) async -> Result<ProcessIdentity?, MonitorError>
}

private let identityPattern = try? NSRegularExpression(
    pattern: "^\\s*([0-9]+)\\s+([0-9]+)\\s+(.{24})\\s+(.*)$")

/// Port of `parseIdentity` in `src/process.ts`.
public func parseIdentity(pid: Int, output: String) -> Result<ProcessIdentity?, MonitorError> {
    let lines = output.split(separator: "\n", omittingEmptySubsequences: false)
    guard let line = lines.first(where: {
        !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }) else { return .success(nil) }
    let failure = Result<ProcessIdentity?, MonitorError>.failure(
        .inspection("Unable to parse process identity for \(pid)"))
    let text = String(line)
    guard let identityPattern,
        let match = identityPattern.firstMatch(
            in: text, range: NSRange(text.startIndex..., in: text)),
        match.numberOfRanges == 5
    else { return failure }
    func group(_ index: Int) -> String? {
        Range(match.range(at: index), in: text).map { String(text[$0]) }
    }
    guard let first = group(1).flatMap({ Int($0) }), let second = group(2).flatMap({ Int($0) }),
        let started = group(3), let command = group(4)
    else { return failure }
    return .success(ProcessIdentity(pid: first, pgid: second, started: started, command: command))
}

private final class Deadline: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false

    func fire() {
        lock.lock()
        fired = true
        lock.unlock()
    }

    var didFire: Bool {
        lock.lock()
        defer { lock.unlock() }
        return fired
    }
}

/// Port of `inspectProcessIdentity` in `src/process.ts`, with the same 2 s deadline.
public struct NativeProcessInspector: ProcessInspector {
    public let timeout: TimeInterval

    public init(timeout: TimeInterval = 2) {
        self.timeout = timeout
    }

    public func inspect(pid: Int) async -> Result<ProcessIdentity?, MonitorError> {
        let limit = timeout
        return await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: runPs(pid: pid, timeout: limit))
            }
        }
    }
}

private func runPs(pid: Int, timeout: TimeInterval) -> Result<ProcessIdentity?, MonitorError> {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-ww", "-o", "pid=,pgid=,lstart=,command=", "-p", String(pid)]
    process.environment = ["LC_ALL": "C"]
    process.standardInput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    let pipe = Pipe()
    process.standardOutput = pipe
    do {
        try process.run()
    } catch {
        return .failure(
            .inspection("Unable to inspect process \(pid): \(error.localizedDescription)"))
    }
    let child = process.processIdentifier
    let deadline = Deadline()
    let stop = DispatchWorkItem {
        deadline.fire()
        kill(child, SIGKILL)
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: stop)
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    stop.cancel()
    if deadline.didFire {
        return .failure(.inspection("Unable to inspect process \(pid): ps timed out"))
    }
    let output = String(decoding: data, as: UTF8.self)
    if process.terminationStatus != 0 {
        if output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .success(nil) }
        return .failure(
            .inspection(
                "Unable to inspect process \(pid): ps exited \(process.terminationStatus)"))
    }
    return parseIdentity(pid: pid, output: output)
}
