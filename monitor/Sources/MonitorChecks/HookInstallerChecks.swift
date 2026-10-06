import Darwin
import Foundation
import MonitorCore

private func makeExecutable(_ path: String, _ source: String) {
    writeFile(path, source)
    _ = chmod(path, 0o755)
}

private func hookError(_ result: Result<Void, HookInstallError>) -> HookInstallError? {
    if case .failure(let error) = result { return error }
    return nil
}

private let sourceHook = """
    #!/usr/bin/env bash
    set -euo pipefail

    repo_root="$(git rev-parse --show-toplevel)"
    cd "$repo_root"
    exec deno task ci
    """ + "\n"

private let managedHook = sourceHook.replacingOccurrences(of: "exec deno task ci\n", with: "exec deno task mci:ci\n")

private func shellQuote(_ value: String) -> String {
    "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
}

@MainActor private func runGit(_ repository: String, _ arguments: String...) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["-C", repository] + arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try? process.run()
    process.waitUntilExit()
    check(process.terminationStatus == 0, "Git fixture command succeeds")
}

@MainActor private func required(_ readiness: HookReadiness, _ message: String) {
    if case .required(let detail) = readiness {
        check(!detail.isEmpty, "\(message) has a detail")
    } else {
        check(false, message)
    }
}

@MainActor private func checkFailed(_ readiness: HookReadiness, _ message: String) {
    if case .checkFailed(let detail) = readiness {
        check(!detail.isEmpty, "\(message) has a detail")
    } else {
        check(false, message)
    }
}

@MainActor private func waitForProcess(_ path: String) async -> Int32? {
    let deadline = ContinuousClock.now + .milliseconds(300)
    while ContinuousClock.now < deadline {
        if let text = try? String(contentsOfFile: path, encoding: .utf8),
            let pid = Int32(text)
        { return pid }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return nil
}

@MainActor private func checkReaped(_ pid: Int32?, _ message: String) {
    guard let pid else {
        check(false, "The cancellation fixture records its process identifier")
        return
    }
    errno = 0
    check(kill(pid, 0) == -1 && errno == ESRCH, message)
}

@MainActor func checkHookInstaller() async {
    let root = makeScratch()
    defer { removeScratch(root) }

    let success = root + "/successful installer"
    let arguments = root + "/arguments"
    makeExecutable(success, """
        #!/bin/sh
        IFS= read -r ignored
        if [ "$?" -ne 1 ]; then exit 24; fi
        printf '%s\\n' "$@" > '\(arguments)'
        """)
    let repository = root + "/repo with spaces and apostrophe's"
    let successResult = await HookInstaller(
        executablePaths: [success], timeoutMilliseconds: 1_000
    ).install(repository: repository)
    check(hookError(successResult) == nil, "installer succeeds")
    equal(
        try? String(contentsOfFile: arguments, encoding: .utf8),
        "hooks\ninstall\n\(repository)\n--workflow\nci/local-ci.yml\n--job\ncheck\n",
        "installer passes exact arguments")

    let missingBeforeSuccess = root + "/missing before success"
    let fallbackResult = await HookInstaller(
        executablePaths: [missingBeforeSuccess, success], timeoutMilliseconds: 1_000
    ).install(repository: repository)
    check(hookError(fallbackResult) == nil, "installer uses the next executable path")

    let failure = root + "/failing installer"
    makeExecutable(failure, """
        #!/bin/sh
        printf 'specific stderr\\n' >&2
        exit 23
        """)
    equal(
        hookError(await HookInstaller(executablePaths: [failure]).install(repository: repository)),
        .failed(exitCode: 23, stderr: "specific stderr\n"),
        "installer preserves exit status and stderr")

    let missing = root + "/missing"
    equal(
        hookError(await HookInstaller(executablePaths: [missing]).install(repository: repository)),
        .executableNotFound([missing]),
        "installer reports an absent executable")

    let invalid = root + "/invalid executable"
    makeExecutable(invalid, "not an executable format")
    let invalidResult = await HookInstaller(executablePaths: [invalid]).install(
        repository: repository)
    if case .failure(.launch(let detail)) = invalidResult {
        check(!detail.isEmpty, "launch failure has a detail")
    } else {
        check(false, "installer reports a launch failure")
    }

    let timeout = root + "/timed out installer"
    let timeoutPID = root + "/timeout pid"
    makeExecutable(timeout, """
        #!/bin/sh
        printf '%s' "$$" > '\(timeoutPID)'
        trap '' TERM
        while :; do :; done
        """)
    let start = ContinuousClock.now
    let timeoutResult = await HookInstaller(
        executablePaths: [timeout], timeoutMilliseconds: 250
    ).install(repository: repository)
    equal(
        hookError(timeoutResult),
        .timedOut,
        "installer reports a timeout")
    check(start.duration(to: .now) < .seconds(1), "timeout completes in under one second")
    let pidText = try? String(contentsOfFile: timeoutPID, encoding: .utf8)
    if let pidText, let pid = Int32(pidText) {
        errno = 0
        check(kill(pid, 0) == -1 && errno == ESRCH, "timeout process is terminated and reaped")
    } else {
        check(false, "timeout fixture records its process identifier")
    }

    let cancelledExecutable = root + "/cancelled installer"
    let cancelledPID = root + "/cancelled pid"
    makeExecutable(cancelledExecutable, """
        #!/bin/sh
        printf '%s' "$$" > '\(cancelledPID)'
        trap '' TERM
        while :; do :; done
        """)
    let cancelledInstaller = HookInstaller(
        executablePaths: [cancelledExecutable], timeoutMilliseconds: 1_000)
    let alreadyCancelled = Task { await cancelledInstaller.install(repository: repository) }
    alreadyCancelled.cancel()
    equal(hookError(await alreadyCancelled.value), .cancelled, "cancelled installation does not launch")
    check(!FileManager.default.fileExists(atPath: cancelledPID), "cancelled installation creates no process")

    let cancellationStart = ContinuousClock.now
    let runningInstallation = Task { await cancelledInstaller.install(repository: repository) }
    let installationPID = await waitForProcess(cancelledPID)
    runningInstallation.cancel()
    equal(hookError(await runningInstallation.value), .cancelled, "running installation reports cancellation")
    checkReaped(installationPID, "cancelled installer process is terminated and reaped")
    check(cancellationStart.duration(to: .now) < .seconds(1), "installation cancellation completes in under one second")

    try? FileManager.default.removeItem(atPath: cancelledPID)
    let cancellationRepository = root + "/cancellation repository"
    try? FileManager.default.createDirectory(atPath: cancellationRepository, withIntermediateDirectories: true)
    let cancelledInspector = HookInstaller(gitExecutablePath: cancelledExecutable)
    let alreadyCancelledInspection = Task { await cancelledInspector.inspect(repository: cancellationRepository) }
    alreadyCancelledInspection.cancel()
    equal(await alreadyCancelledInspection.value, .checkFailed("The hook inspection was cancelled."), "cancelled inspection does not launch")
    check(!FileManager.default.fileExists(atPath: cancelledPID), "cancelled inspection creates no process")

    let inspectionStart = ContinuousClock.now
    let runningInspection = Task { await cancelledInspector.inspect(repository: cancellationRepository) }
    let inspectionPID = await waitForProcess(cancelledPID)
    runningInspection.cancel()
    equal(await runningInspection.value, .checkFailed("The Git worktree root could not be read: The hook inspection was cancelled."), "running inspection reports cancellation")
    checkReaped(inspectionPID, "cancelled Git process is terminated and reaped")
    check(inspectionStart.duration(to: .now) < .seconds(1), "inspection cancellation completes in under one second")

    let noisy = root + "/noisy installer"
    makeExecutable(noisy, """
        #!/bin/sh
        while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >&2; done
        """)
    equal(
        hookError(await HookInstaller(
            executablePaths: [noisy], timeoutMilliseconds: 2_000
        ).install(repository: repository)),
        .outputLimitExceeded,
        "installer limits error output")

    let inspected = root + "/inspected repository"
    try? FileManager.default.createDirectory(atPath: inspected, withIntermediateDirectories: true)
    runGit(inspected, "init", "--quiet")
    let inspector = HookInstaller(executablePaths: [success], timeoutMilliseconds: 1_000)

    equal(
        await inspector.inspect(repository: inspected),
        .required("The effective pre-commit hook is absent."),
        "missing hook explains why installation is required")

    let nested = inspected + "/nested"
    try? FileManager.default.createDirectory(atPath: nested, withIntermediateDirectories: true)
    equal(
        await inspector.inspect(repository: nested),
        .required("The registered path must be the Git worktree root."),
        "nested repository path explains the required correction")

    runGit(inspected, "config", "core.hooksPath", ".githooks")
    let activeHook = inspected + "/.githooks/pre-commit"
    writeFile(activeHook, sourceHook)
    _ = chmod(activeHook, 0o755)
    writeFile(inspected + "/deno.json", #"{"tasks":{"ci":"deno task verify"}}"#)
    equal(await inspector.inspect(repository: inspected), .installed, "source hook is installed")

    writeFile(inspected + "/deno.json", #"{"tasks":{}}"#)
    required(await inspector.inspect(repository: inspected), "source hook requires its task")
    writeFile(inspected + "/deno.json", #"{"tasks":{"ci":7}}"#)
    required(await inspector.inspect(repository: inspected), "source hook rejects a nonstring task")
    writeFile(inspected + "/deno.json", #"{"tasks":{"ci":"deno task verify"}}"#)
    _ = chmod(activeHook, 0o644)
    required(await inspector.inspect(repository: inspected), "source hook must be executable")
    _ = chmod(activeHook, 0o755)
    writeFile(inspected + "/deno.json", "{")
    checkFailed(await inspector.inspect(repository: inspected), "invalid JSON fails inspection")

    let stableDirectory = root + "/formula's files/bin"
    let stableExecutable = stableDirectory + "/mci"
    makeExecutable(stableExecutable, "#!/bin/sh\nexit 0\n")
    let stableInspector = HookInstaller(
        executablePaths: [stableExecutable], timeoutMilliseconds: 1_000)
    let managedHooks = root + "/formula's files/libexec/hooks"
    runGit(inspected, "config", "core.hooksPath", managedHooks)
    writeFile(managedHooks + "/pre-commit", managedHook)
    _ = chmod(managedHooks + "/pre-commit", 0o755)
    let workflow = "ci/custom flow's.yml"
    let job = "job's check"
    writeFile(inspected + "/" + workflow, "version: 1\n")
    let managedTask = "\(shellQuote(stableExecutable)) ci \(shellQuote(workflow)) --job \(shellQuote(job))"
    let managedConfig = try? JSONSerialization.data(
        withJSONObject: ["tasks": ["mci:ci": managedTask]], options: [.sortedKeys])
    try? managedConfig?.write(to: URL(fileURLWithPath: inspected + "/deno.json"))
    equal(
        await stableInspector.inspect(repository: inspected), .installed,
        "managed hook accepts quoted custom workflow and job")

    let formulaAlias = root + "/stable formula"
    let formulaDirectory = (stableDirectory as NSString).deletingLastPathComponent
    try? FileManager.default.createSymbolicLink(atPath: formulaAlias, withDestinationPath: formulaDirectory)
    let aliasExecutable = formulaAlias + "/bin/mci"
    runGit(inspected, "config", "core.hooksPath", formulaAlias + "/libexec/hooks")
    let aliasTask = "\(shellQuote(aliasExecutable)) ci \(shellQuote(workflow)) --job \(shellQuote(job))"
    let aliasConfig = try? JSONSerialization.data(withJSONObject: ["tasks": ["mci:ci": aliasTask]])
    try? aliasConfig?.write(to: URL(fileURLWithPath: inspected + "/deno.json"))
    equal(
        await HookInstaller(executablePaths: [aliasExecutable]).inspect(repository: inspected), .installed,
        "managed hook recognizes the stable Homebrew symlink")
    runGit(inspected, "config", "core.hooksPath", managedHooks)

    let wrongTask = "'/wrong/mci' ci \(shellQuote(workflow)) --job \(shellQuote(job))"
    let wrongConfig = try? JSONSerialization.data(
        withJSONObject: ["tasks": ["mci:ci": wrongTask]], options: [])
    try? wrongConfig?.write(to: URL(fileURLWithPath: inspected + "/deno.json"))
    required(await stableInspector.inspect(repository: inspected), "managed hook rejects a wrong binary")
    writeFile(inspected + "/deno.json", #"{"tasks":{"mci:ci":"malformed"}}"#)
    required(await stableInspector.inspect(repository: inspected), "managed hook rejects a malformed task")

    let nonGit = root + "/not git"
    try? FileManager.default.createDirectory(atPath: nonGit, withIntermediateDirectories: true)
    checkFailed(await inspector.inspect(repository: nonGit), "non-Git directory fails inspection")

    let slowGit = root + "/slow git"
    makeExecutable(slowGit, "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n")
    checkFailed(
        await HookInstaller(
            executablePaths: [success], timeoutMilliseconds: 100,
            inspectionTimeoutMilliseconds: 100,
            gitExecutablePath: slowGit
        ).inspect(repository: inspected),
        "Git timeout fails inspection")

    let noisyGit = root + "/noisy git"
    makeExecutable(noisyGit, "#!/bin/sh\nwhile :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >&2; done\n")
    checkFailed(
        await HookInstaller(
            executablePaths: [success], timeoutMilliseconds: 1_000,
            gitExecutablePath: noisyGit
        ).inspect(repository: inspected),
        "Git output limit fails inspection")
}
