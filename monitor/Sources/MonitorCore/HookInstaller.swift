import Darwin
import Foundation

public enum HookInstallError: Error, Equatable, Sendable {
    case executableNotFound([String])
    case launch(String)
    case failed(exitCode: Int32, stderr: String)
    case timedOut
    case outputLimitExceeded

    public var message: String {
        switch self {
        case .executableNotFound:
            return "The mci executable was not found in a supported Homebrew location."
        case .launch(let detail):
            return "The mci executable could not start: \(detail)"
        case .failed(let exitCode, let stderr):
            let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return detail.isEmpty
                ? "The hook installer exited with status \(exitCode)."
                : "The hook installer exited with status \(exitCode): \(detail)"
        case .timedOut:
            return "The hook installer timed out."
        case .outputLimitExceeded:
            return "The hook installer produced too much error output."
        }
    }
}

public struct HookInstaller: Sendable {
    public static let defaultExecutablePaths = [
        "/opt/homebrew/opt/mci/bin/mci",
        "/usr/local/opt/mci/bin/mci",
    ]

    private let executablePaths: [String]
    private let timeoutMilliseconds: Int

    public init(
        executablePaths: [String] = HookInstaller.defaultExecutablePaths,
        timeoutMilliseconds: Int = 120_000
    ) {
        self.executablePaths = executablePaths
        self.timeoutMilliseconds = min(max(timeoutMilliseconds, 1), 120_000)
    }

    public func install(repository: String) async -> Result<Void, HookInstallError> {
        let paths = executablePaths
        let timeout = timeoutMilliseconds
        return await Task.detached(priority: .utility) {
            installHook(repository: repository, executablePaths: paths, timeoutMilliseconds: timeout)
        }.value
    }
}

private func installHook(
    repository: String, executablePaths: [String], timeoutMilliseconds: Int
) -> Result<Void, HookInstallError> {
    guard let executable = executablePaths.first(where: FileManager.default.isExecutableFile) else {
        return .failure(.executableNotFound(executablePaths))
    }

    let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(
        "mci-hook-installer-\(UUID().uuidString)", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: false)
    } catch {
        return .failure(.launch(error.localizedDescription))
    }
    defer { try? FileManager.default.removeItem(at: scratch) }

    let errorURL = scratch.appendingPathComponent("stderr")
    guard FileManager.default.createFile(atPath: errorURL.path, contents: nil),
        let errorFile = try? FileHandle(forWritingTo: errorURL),
        let nullInput = FileHandle(forReadingAtPath: "/dev/null"),
        let nullOutput = FileHandle(forWritingAtPath: "/dev/null")
    else {
        return .failure(.launch("The installer output files could not open."))
    }
    defer {
        try? errorFile.close()
        try? nullInput.close()
        try? nullOutput.close()
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = [
        "hooks", "install", repository,
        "--workflow", "ci/local-ci.yml",
        "--job", "check",
    ]
    process.standardInput = nullInput
    process.standardOutput = nullOutput
    process.standardError = errorFile

    do {
        try process.run()
    } catch {
        return .failure(.launch(error.localizedDescription))
    }

    let deadline = DispatchTime.now() + .milliseconds(timeoutMilliseconds)
    while process.isRunning, DispatchTime.now() < deadline {
        if fileSize(errorURL) > 64 * 1_024 {
            stop(process)
            return .failure(.outputLimitExceeded)
        }
        usleep(10_000)
    }
    if process.isRunning {
        stop(process)
        return .failure(.timedOut)
    }
    process.waitUntilExit()
    try? errorFile.synchronize()

    if fileSize(errorURL) > 64 * 1_024 {
        return .failure(.outputLimitExceeded)
    }
    guard process.terminationStatus == 0 else {
        let data = (try? Data(contentsOf: errorURL, options: .mappedIfSafe)) ?? Data()
        return .failure(.failed(
            exitCode: process.terminationStatus,
            stderr: String(decoding: data, as: UTF8.self)))
    }
    return .success(())
}

private func fileSize(_ url: URL) -> UInt64 {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.size] as? NSNumber)?.uint64Value ?? 0
}

private func stop(_ process: Process) {
    process.terminate()
    let grace = DispatchTime.now() + .milliseconds(100)
    while process.isRunning, DispatchTime.now() < grace { usleep(10_000) }
    if process.isRunning { _ = kill(process.processIdentifier, SIGKILL) }
    let killed = DispatchTime.now() + .seconds(1)
    while process.isRunning, DispatchTime.now() < killed { usleep(10_000) }
    if !process.isRunning { process.waitUntilExit() }
}
