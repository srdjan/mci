import Darwin
import Foundation

public enum HookReadiness: Equatable, Sendable {
    case installed
    case required(String)
    case checkFailed(String)
}

public enum HookInstallError: Error, Equatable, Sendable {
    case executableNotFound([String])
    case launch(String)
    case failed(exitCode: Int32, stderr: String)
    case timedOut
    case cancelled

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
        case .cancelled:
            return "The hook installation was cancelled."
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
    private let inspectionTimeoutMilliseconds: Int
    private let gitExecutablePath: String

    public init(
        executablePaths: [String] = HookInstaller.defaultExecutablePaths,
        timeoutMilliseconds: Int = 120_000,
        inspectionTimeoutMilliseconds: Int = 1_000,
        gitExecutablePath: String = "/usr/bin/git"
    ) {
        self.executablePaths = executablePaths
        self.timeoutMilliseconds = min(max(timeoutMilliseconds, 1), 120_000)
        self.inspectionTimeoutMilliseconds = min(max(inspectionTimeoutMilliseconds, 1), 1_000)
        self.gitExecutablePath = gitExecutablePath
    }

    public func install(repository: String) async -> Result<Void, HookInstallError> {
        guard !Task.isCancelled else { return .failure(.cancelled) }
        let paths = executablePaths
        let timeout = timeoutMilliseconds
        let worker = Task.detached(priority: .utility) {
            installHook(repository: repository, executablePaths: paths, timeoutMilliseconds: timeout)
        }
        return await withTaskCancellationHandler {
            await worker.value
        } onCancel: {
            worker.cancel()
        }
    }

    public func inspect(repository: String) async -> HookReadiness {
        guard !Task.isCancelled else { return .checkFailed("The hook inspection was cancelled.") }
        let paths = executablePaths
        let timeout = inspectionTimeoutMilliseconds
        let git = gitExecutablePath
        let worker = Task.detached(priority: .utility) {
            inspectHook(
                repository: repository,
                executablePaths: paths,
                gitExecutablePath: git,
                timeoutMilliseconds: timeout)
        }
        return await withTaskCancellationHandler {
            await worker.value
        } onCancel: {
            worker.cancel()
        }
    }
}

private let managedHook = """
    #!/usr/bin/env bash
    set -euo pipefail

    repo_root="$(git rev-parse --show-toplevel)"
    cd "$repo_root"
    exec deno task mci:ci
    """ + "\n"

private let outputLimit = UInt64(64 * 1_024)
private let configLimit = UInt64(1_024 * 1_024)

private enum CommandError: Error {
    case launch(String)
    case failed(exitCode: Int32, stderr: String)
    case timedOut
    case outputLimitExceeded
    case cancelled

    var inspectionMessage: String {
        switch self {
        case .launch(let detail): return detail
        case .failed(let code, let stderr):
            let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return detail.isEmpty ? "Git exited with status \(code)." : detail
        case .timedOut: return "Git timed out."
        case .outputLimitExceeded: return "Git produced too much output."
        case .cancelled: return "The hook inspection was cancelled."
        }
    }
}

private enum FileState {
    case missing
    case other
    case regular(size: UInt64, executable: Bool)
    case failed(String)
}

private func installHook(
    repository: String, executablePaths: [String], timeoutMilliseconds: Int
) -> Result<Void, HookInstallError> {
    guard let executable = executablePaths.first(where: FileManager.default.isExecutableFile) else {
        return .failure(.executableNotFound(executablePaths))
    }
    return runInstaller(
        executable: executable,
        arguments: [
            "hooks", "setup", repository, "--replace-pre-push",
            "--timeout-ms", String(timeoutMilliseconds),
        ])
}

private func runInstaller(
    executable: String,
    arguments: [String]
) -> Result<Void, HookInstallError> {
    guard !Task.isCancelled else { return .failure(.cancelled) }

    let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(
        "mci-hook-installation-\(UUID().uuidString)", isDirectory: true)
    guard mkdir(scratch.path, 0o700) == 0 else {
        return .failure(.launch(String(cString: strerror(errno))))
    }
    defer { try? FileManager.default.removeItem(at: scratch) }

    let outputURL = scratch.appendingPathComponent("stdout")
    let errorURL = scratch.appendingPathComponent("stderr")
    var outputDescriptor = open(outputURL.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    guard outputDescriptor >= 0 else {
        return .failure(.launch(
            "The command output file could not open: \(String(cString: strerror(errno)))."))
    }
    defer {
        if outputDescriptor >= 0 { _ = Darwin.close(outputDescriptor) }
    }
    var errorDescriptor = open(errorURL.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    guard errorDescriptor >= 0 else {
        return .failure(.launch(
            "The command error file could not open: \(String(cString: strerror(errno)))."))
    }
    defer {
        if errorDescriptor >= 0 { _ = Darwin.close(errorDescriptor) }
    }

    let outputFile = FileHandle(fileDescriptor: outputDescriptor, closeOnDealloc: false)
    let errorFile = FileHandle(fileDescriptor: errorDescriptor, closeOnDealloc: false)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = outputFile
    process.standardError = errorFile

    guard !Task.isCancelled else { return .failure(.cancelled) }
    do {
        try process.run()
    } catch {
        return .failure(.launch(error.localizedDescription))
    }

    var sentTermination = false
    while process.isRunning {
        if Task.isCancelled, !sentTermination {
            _ = kill(process.processIdentifier, SIGTERM)
            sentTermination = true
        }
        if process.isRunning { usleep(10_000) }
    }
    process.waitUntilExit()

    _ = Darwin.close(errorDescriptor)
    errorDescriptor = -1
    _ = Darwin.close(outputDescriptor)
    outputDescriptor = -1

    guard process.terminationStatus != 0 else { return .success(()) }
    let diagnostic: String
    do {
        diagnostic = try readTail(errorURL, maximumBytes: outputLimit)
    } catch {
        diagnostic = "The installer diagnostic could not be read: \(error.localizedDescription)"
    }
    return .failure(.failed(exitCode: process.terminationStatus, stderr: diagnostic))
}

private func readTail(_ url: URL, maximumBytes: UInt64) throws -> String {
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }

    let size = try file.seekToEnd()
    try file.seek(toOffset: size > maximumBytes ? size - maximumBytes : 0)
    let data = try file.readToEnd() ?? Data()
    return String(decoding: data, as: UTF8.self)
}

private func inspectHook(
    repository: String,
    executablePaths: [String],
    gitExecutablePath: String,
    timeoutMilliseconds: Int
) -> HookReadiness {
    let canonicalRepository: String
    guard let path = resolve(repository) else {
        return .checkFailed("The repository is not available.")
    }
    canonicalRepository = path

    let rootResult = gitLine(
        executable: gitExecutablePath,
        repository: canonicalRepository,
        arguments: ["rev-parse", "--show-toplevel"],
        timeoutMilliseconds: timeoutMilliseconds)
    let reportedRoot: String
    switch rootResult {
    case .success(let path): reportedRoot = path
    case .failure(let error):
        return .checkFailed("The Git worktree root could not be read: \(error.inspectionMessage)")
    }
    let canonicalRoot: String
    guard let rootPath = resolve(reportedRoot) else {
        return .checkFailed("The Git worktree root is not available.")
    }
    canonicalRoot = rootPath
    guard canonicalRepository == canonicalRoot else {
        return .required("The registered path must be the Git worktree root.")
    }

    let hookResult = gitLine(
        executable: gitExecutablePath,
        repository: canonicalRepository,
        arguments: ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"],
        timeoutMilliseconds: timeoutMilliseconds)
    let hookPath: String
    switch hookResult {
    case .success(let path): hookPath = path
    case .failure(let error):
        return .checkFailed("The effective pre-commit hook path could not be read: \(error.inspectionMessage)")
    }
    guard hookPath.hasPrefix("/") else {
        return .checkFailed("Git returned a nonabsolute pre-commit hook path.")
    }

    switch fileState(hookPath) {
    case .missing:
        return .required("The effective pre-commit hook is absent.")
    case .other:
        return .required("The effective pre-commit hook is not a regular file.")
    case .failed(let detail):
        return .checkFailed("The effective pre-commit hook could not be inspected: \(detail)")
    case .regular(let size, let executable):
        guard executable else {
            return .required("The effective pre-commit hook is not executable.")
        }
        guard size <= outputLimit else {
            return .required("The effective pre-commit hook is too large to be supported by mci.")
        }
    }

    let hookText: String
    switch readUTF8(hookPath, maximumBytes: outputLimit) {
    case .success(let text): hookText = text
    case .failure(let error):
        return .checkFailed("The effective pre-commit hook could not be read: \(error.inspectionMessage)")
    }
    guard hookText == managedHook else {
        return .required("The effective pre-commit hook is not supported by mci.")
    }

    let configPath = canonicalRepository + "/deno.json"
    switch fileState(configPath) {
    case .missing:
        return .required("The repository has no deno.json file.")
    case .other:
        return .required("The repository deno.json path is not a regular file.")
    case .failed(let detail):
        return .checkFailed("The repository deno.json file could not be inspected: \(detail)")
    case .regular(let size, _):
        guard size <= configLimit else {
            return .checkFailed("The repository deno.json file is too large to inspect.")
        }
    }
    let configData: Data
    do {
        configData = try Data(contentsOf: URL(fileURLWithPath: configPath), options: .mappedIfSafe)
    } catch {
        return .checkFailed("The repository deno.json file could not be read: \(error.localizedDescription)")
    }
    guard configData.count <= configLimit else {
        return .checkFailed("The repository deno.json file is too large to inspect.")
    }
    let json: Any
    do {
        json = try JSONSerialization.jsonObject(with: configData)
    } catch {
        return .checkFailed("The repository deno.json file is invalid: \(error.localizedDescription)")
    }
    guard let object = json as? [String: Any] else {
        return .checkFailed("The repository deno.json file must contain an object.")
    }
    let tasks = object["tasks"] as? [String: Any]
    guard let task = tasks?["mci:ci"] as? String else {
        return .required("The managed pre-commit hook requires the mci:ci task.")
    }
    guard let command = parseManagedTask(task) else {
        return .required("The mci:ci task is not a generated mci hook task.")
    }
    guard let executable = executablePaths.first(where: FileManager.default.isExecutableFile),
        command.executable == executable
    else {
        return .required("The mci:ci task does not use the selected stable mci executable.")
    }
    let prefix = (executable as NSString).deletingLastPathComponent as NSString
    let packagedHook = prefix.deletingLastPathComponent + "/libexec/hooks/pre-commit"
    guard let packagedPath = resolve(packagedHook), hookPath == packagedPath else {
        return .required("The managed pre-commit hook does not use the packaged hook path.")
    }
    guard validWorkflow(command.workflow), !command.job.isEmpty, !command.job.contains("\0") else {
        return .required("The mci:ci task has an invalid workflow or job.")
    }
    guard task == hookTask(
        executable: executable, workflow: command.workflow, job: command.job)
    else {
        return .required("The mci:ci task is not an exact generated mci hook task.")
    }

    switch fileState(canonicalRepository + "/" + command.workflow) {
    case .regular:
        return .installed
    case .missing:
        return .required("The mci:ci workflow file is absent.")
    case .other:
        return .required("The mci:ci workflow path is not a regular file.")
    case .failed(let detail):
        return .checkFailed("The mci:ci workflow file could not be inspected: \(detail)")
    }
}

private struct ManagedTask {
    let executable: String
    let workflow: String
    let job: String
}

private func parseManagedTask(_ source: String) -> ManagedTask? {
    let characters = Array(source)
    var index = 0
    guard let executable = parseShellQuote(characters, index: &index),
        consume(" ci ", in: characters, index: &index),
        let workflow = parseShellQuote(characters, index: &index),
        consume(" --job ", in: characters, index: &index),
        let job = parseShellQuote(characters, index: &index),
        index == characters.count
    else { return nil }
    return ManagedTask(executable: executable, workflow: workflow, job: job)
}

private func parseShellQuote(_ characters: [Character], index: inout Int) -> String? {
    guard index < characters.count, characters[index] == "'" else { return nil }
    index += 1
    var value = ""
    let escapedQuote: [Character] = ["'", "\"", "'", "\"", "'"]
    while index < characters.count {
        if characters[index] != "'" {
            value.append(characters[index])
            index += 1
            continue
        }
        if characters[index...].starts(with: escapedQuote) {
            value.append("'")
            index += escapedQuote.count
            continue
        }
        index += 1
        return value
    }
    return nil
}

private func consume(_ expected: String, in characters: [Character], index: inout Int) -> Bool {
    let expectedCharacters = Array(expected)
    guard characters[index...].starts(with: expectedCharacters)
    else { return false }
    index += expectedCharacters.count
    return true
}

private func validWorkflow(_ workflow: String) -> Bool {
    !workflow.isEmpty && !workflow.hasPrefix("/") && !workflow.contains("\0")
        && !workflow.split(separator: "/", omittingEmptySubsequences: false).contains("..")
}

private func hookTask(executable: String, workflow: String, job: String) -> String {
    "\(shellQuote(executable)) ci \(shellQuote(workflow)) --job \(shellQuote(job))"
}

private func shellQuote(_ value: String) -> String {
    "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
}

private func gitLine(
    executable: String,
    repository: String,
    arguments: [String],
    timeoutMilliseconds: Int
) -> Result<String, CommandError> {
    let result = runBounded(
        executable: executable,
        arguments: ["-C", repository] + arguments,
        timeoutMilliseconds: timeoutMilliseconds)
    switch result {
    case .failure(let error): return .failure(error)
    case .success(let output):
        guard var line = String(data: output, encoding: .utf8) else {
            return .failure(.launch("Git returned non-UTF-8 output."))
        }
        if line.hasSuffix("\n") { line.removeLast() }
        guard !line.isEmpty, !line.contains("\n"), !line.contains("\r"), !line.contains("\0") else {
            return .failure(.launch("Git returned an invalid path."))
        }
        return .success(line)
    }
}

private func runBounded(
    executable: String,
    arguments: [String],
    timeoutMilliseconds: Int
) -> Result<Data, CommandError> {
    guard !Task.isCancelled else { return .failure(.cancelled) }
    let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(
        "mci-hook-process-\(UUID().uuidString)", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: false)
    } catch {
        return .failure(.launch(error.localizedDescription))
    }
    defer { try? FileManager.default.removeItem(at: scratch) }

    let outputURL = scratch.appendingPathComponent("stdout")
    let errorURL = scratch.appendingPathComponent("stderr")
    guard FileManager.default.createFile(atPath: outputURL.path, contents: nil),
        FileManager.default.createFile(atPath: errorURL.path, contents: nil),
        let outputFile = try? FileHandle(forWritingTo: outputURL),
        let errorFile = try? FileHandle(forWritingTo: errorURL)
    else {
        return .failure(.launch("The command output files could not open."))
    }
    defer {
        try? errorFile.close()
        try? outputFile.close()
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = outputFile
    process.standardError = errorFile

    guard !Task.isCancelled else { return .failure(.cancelled) }
    do {
        try process.run()
    } catch {
        return .failure(.launch(error.localizedDescription))
    }

    let deadline = DispatchTime.now() + .milliseconds(timeoutMilliseconds)
    while process.isRunning, DispatchTime.now() < deadline {
        if Task.isCancelled {
            stop(process)
            return .failure(.cancelled)
        }
        if fileSize(errorFile) > outputLimit || fileSize(outputFile) > outputLimit {
            stop(process)
            return .failure(.outputLimitExceeded)
        }
        usleep(10_000)
    }
    if Task.isCancelled {
        if process.isRunning { stop(process) }
        else { process.waitUntilExit() }
        return .failure(.cancelled)
    }
    if process.isRunning {
        stop(process)
        return .failure(.timedOut)
    }
    process.waitUntilExit()
    try? errorFile.synchronize()
    try? outputFile.synchronize()

    if fileSize(errorFile) > outputLimit || fileSize(outputFile) > outputLimit {
        return .failure(.outputLimitExceeded)
    }
    let stderrData: Data
    let stdout: Data
    do {
        stderrData = try Data(contentsOf: errorURL, options: .mappedIfSafe)
        stdout = try Data(contentsOf: outputURL, options: .mappedIfSafe)
    } catch {
        return .failure(.launch("The command output could not be read: \(error.localizedDescription)"))
    }
    let stderr = String(decoding: stderrData, as: UTF8.self)
    guard process.terminationStatus == 0 else {
        return .failure(.failed(exitCode: process.terminationStatus, stderr: stderr))
    }
    return .success(stdout)
}

private func resolve(_ path: String) -> String? {
    guard let resolved = realpath(path, nil) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
}

private func fileState(_ path: String) -> FileState {
    var information = stat()
    guard lstat(path, &information) == 0 else {
        if errno == ENOENT || errno == ENOTDIR { return .missing }
        return .failed(String(cString: strerror(errno)))
    }
    guard information.st_mode & S_IFMT == S_IFREG else { return .other }
    return .regular(
        size: UInt64(max(information.st_size, 0)),
        executable: information.st_mode & 0o111 != 0)
}

private func readUTF8(_ path: String, maximumBytes: UInt64) -> Result<String, CommandError> {
    do {
        let data = try Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe)
        guard data.count <= maximumBytes else { return .failure(.outputLimitExceeded) }
        guard let text = String(data: data, encoding: .utf8) else {
            return .failure(.launch("The file is not UTF-8."))
        }
        return .success(text)
    } catch {
        return .failure(.launch(error.localizedDescription))
    }
}

private func fileSize(_ file: FileHandle) -> UInt64 {
    var information = stat()
    guard fstat(file.fileDescriptor, &information) == 0 else { return 0 }
    return UInt64(max(information.st_size, 0))
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
