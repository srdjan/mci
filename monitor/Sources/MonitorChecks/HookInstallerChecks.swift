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

private let legacySourceHook = """
    #!/usr/bin/env bash
    set -euo pipefail

    repo_root="$(git rev-parse --show-toplevel)"
    cd "$repo_root"
    exec deno task ci
    """ + "\n"

private let managedHook = """
    #!/usr/bin/env bash
    set -euo pipefail

    repo_root="$(git rev-parse --show-toplevel)"
    cd "$repo_root"
    exec deno task mci:ci
    """ + "\n"

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

@MainActor private func waitForFile(_ path: String) async -> Bool {
    let deadline = ContinuousClock.now + .milliseconds(300)
    while ContinuousClock.now < deadline {
        if FileManager.default.fileExists(atPath: path) { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return false
}

private actor InstallationCompletion {
    private var error: HookInstallError??

    func record(_ result: Result<Void, HookInstallError>) {
        error = hookError(result)
    }

    func observedError() -> HookInstallError?? {
        error
    }
}

private actor StartGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var isOpen = false

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { continuation = $0 }
    }

    func open() {
        isOpen = true
        continuation?.resume()
        continuation = nil
    }
}

@MainActor func checkHookInstaller() async {
    var status = HookStatus(readiness: .required("The effective pre-commit hook is absent."))
    status.recordInstallation(.failure(.failed(exitCode: 23, stderr: "installation failed\n")))
    equal(
        status.displayedReadiness,
        .required("The hook installer exited with status 23: installation failed"),
        "installation failure replaces the observed readiness")
    status.recordInspection(.checkFailed("Git could not inspect the hook."))
    equal(
        status.displayedReadiness,
        .required("The hook installer exited with status 23: installation failed"),
        "failed inspection preserves the installation failure")
    status.recordInspection(.required("The effective pre-commit hook is absent."))
    equal(
        status.displayedReadiness,
        .required("The hook installer exited with status 23: installation failed"),
        "required inspection preserves the installation failure")
    status.recordInspection(.installed)
    equal(status.displayedReadiness, .installed, "installed inspection clears the installation failure")
    status.recordInstallation(.failure(.timedOut))
    status.recordInstallation(.success(()))
    equal(status.displayedReadiness, nil, "successful installation clears the installation failure")

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
        "hooks\nsetup\n\(repository)\n--replace-pre-push\n--timeout-ms\n1000\n",
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

    let olderCLI = root + "/older installer"
    let olderMutation = root + "/older mutation"
    makeExecutable(olderCLI, """
        #!/bin/sh
        if [ "$#" -ne 4 ]; then
            printf 'unknown option: --timeout-ms\n' >&2
            exit 64
        fi
        printf 'mutated' > '\(olderMutation)'
        """)
    equal(
        hookError(await HookInstaller(
            executablePaths: [olderCLI], timeoutMilliseconds: 41
        ).install(repository: repository)),
        .failed(exitCode: 64, stderr: "unknown option: --timeout-ms\n"),
        "an older installer rejects the timeout argument")
    check(
        !FileManager.default.fileExists(atPath: olderMutation),
        "an older installer rejects the argument before mutation")

    let timeout = root + "/child timed out installer"
    makeExecutable(timeout, """
        #!/bin/sh
        trap '' TERM
        sleep 0.15
        printf 'forward operation timed out; restoration completed\n' >&2
        exit 124
        """)
    let start = ContinuousClock.now
    let timeoutResult = await HookInstaller(
        executablePaths: [timeout], timeoutMilliseconds: 30
    ).install(repository: repository)
    equal(
        hookError(timeoutResult),
        .failed(
            exitCode: 124,
            stderr: "forward operation timed out; restoration completed\n"),
        "installer preserves the child-owned timeout diagnostic")
    check(
        start.duration(to: .now) >= .milliseconds(140),
        "the monitor does not enforce the forwarded installation timeout")
    check(start.duration(to: .now) < .seconds(1), "timeout completes in under one second")

    let cancelledExecutable = root + "/cancelled installer"
    let cancelledPID = root + "/cancelled pid"
    let helperPIDPath = root + "/helper pid"
    let cancellationGate = root + "/cancellation gate"
    let termReceived = root + "/term received"
    makeExecutable(cancelledExecutable, """
        #!/bin/sh
        printf '%s' "$$" > '\(cancelledPID)'
        cancelled=0
        trap 'cancelled=1; printf "received\\n" >> "\(termReceived)"' TERM
        /bin/sh -c 'trap "" TERM; while [ ! -f "\(cancellationGate)" ]; do sleep 0.01; done' &
        helper="$!"
        printf '%s' "$helper" > '\(helperPIDPath)'
        while kill -0 "$helper" 2>/dev/null; do
            wait "$helper" || true
        done
        if [ "$cancelled" -eq 1 ]; then
            printf 'restoration failed: preserved diagnostic\n' >&2
            exit 143
        fi
        """)
    let cancelledInstaller = HookInstaller(
        executablePaths: [cancelledExecutable], timeoutMilliseconds: 1_000)
    let cancelledStart = StartGate()
    let alreadyCancelled = Task {
        await cancelledStart.wait()
        return await cancelledInstaller.install(repository: repository)
    }
    alreadyCancelled.cancel()
    await cancelledStart.open()
    equal(hookError(await alreadyCancelled.value), .cancelled, "cancelled installation does not launch")
    check(!FileManager.default.fileExists(atPath: cancelledPID), "cancelled installation creates no process")

    let cancellationStart = ContinuousClock.now
    let runningInstallation = Task { await cancelledInstaller.install(repository: repository) }
    let installationPID = await waitForProcess(cancelledPID)
    let helperPID = await waitForProcess(helperPIDPath)
    runningInstallation.cancel()
    check(await waitForFile(termReceived), "installation cancellation sends TERM")
    let completion = InstallationCompletion()
    let completionTask = Task { await completion.record(await runningInstallation.value) }
    try? await Task.sleep(for: .milliseconds(150))
    check(
        await completion.observedError() == nil,
        "installation cancellation waits for the active helper and restoration")
    writeFile(cancellationGate, "release")
    await completionTask.value
    equal(
        await completion.observedError()!,
        .failed(exitCode: 143, stderr: "restoration failed: preserved diagnostic\n"),
        "running installation preserves the restoration diagnostic")
    equal(
        try? String(contentsOfFile: termReceived, encoding: .utf8),
        "received\n",
        "installation cancellation sends TERM once")
    checkReaped(installationPID, "cancelled installer process is terminated and reaped")
    checkReaped(helperPID, "cancelled installer helper is terminated and reaped")
    check(cancellationStart.duration(to: .now) < .seconds(1), "installation cancellation completes in under one second")

    let lateSuccess = root + "/late success installer"
    let latePIDPath = root + "/late success pid"
    let lateGate = root + "/late success gate"
    let lateTerm = root + "/late success term"
    makeExecutable(lateSuccess, """
        #!/bin/sh
        printf '%s' "$$" > '\(latePIDPath)'
        trap 'printf "received\\n" >> "\(lateTerm)"' TERM
        while [ ! -f '\(lateGate)' ]; do sleep 0.01; done
        exit 0
        """)
    let lateInstaller = HookInstaller(
        executablePaths: [lateSuccess], timeoutMilliseconds: 1_000)
    let lateStart = ContinuousClock.now
    let lateInstallation = Task { await lateInstaller.install(repository: repository) }
    let latePID = await waitForProcess(latePIDPath)
    lateInstallation.cancel()
    check(await waitForFile(lateTerm), "late cancellation sends TERM")
    try? await Task.sleep(for: .milliseconds(150))
    writeFile(lateGate, "release")
    check(
        hookError(await lateInstallation.value) == nil,
        "a committed installer result succeeds after late cancellation")
    check(
        lateStart.duration(to: .now) < .seconds(1),
        "late-success cancellation completes in under one second")
    equal(
        try? String(contentsOfFile: lateTerm, encoding: .utf8),
        "received\n",
        "late cancellation sends TERM once")
    checkReaped(latePID, "late-success installer process is reaped")

    try? FileManager.default.removeItem(atPath: cancelledPID)
    let cancellationRepository = root + "/cancellation repository"
    try? FileManager.default.createDirectory(atPath: cancellationRepository, withIntermediateDirectories: true)
    let cancelledInspector = HookInstaller(gitExecutablePath: cancelledExecutable)
    let inspectionStartGate = StartGate()
    let alreadyCancelledInspection = Task {
        await inspectionStartGate.wait()
        return await cancelledInspector.inspect(repository: cancellationRepository)
    }
    alreadyCancelledInspection.cancel()
    await inspectionStartGate.open()
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
    let noisyCompleted = root + "/noisy completed"
    makeExecutable(noisy, """
        #!/bin/sh
        head -c 70000 /dev/zero | tr '\\0' x >&2
        sleep 0.15
        printf completed > '\(noisyCompleted)'
        printf '\nFINAL-DIAGNOSTIC\n' >&2
        exit 23
        """)
    let noisyStart = ContinuousClock.now
    let noisyResult = hookError(await HookInstaller(
        executablePaths: [noisy], timeoutMilliseconds: 2_000
    ).install(repository: repository))
    if case .failed(let exitCode, let stderr) = noisyResult {
        equal(exitCode, 23, "oversized installer output preserves the exit status")
        check(
            stderr.utf8.count <= 64 * 1_024,
            "oversized installer diagnostics have a bounded tail")
        check(
            stderr.hasSuffix("\nFINAL-DIAGNOSTIC\n"),
            "oversized installer diagnostics preserve the final detail")
    } else {
        check(false, "oversized installer output returns a bounded failure")
    }
    check(
        FileManager.default.fileExists(atPath: noisyCompleted),
        "oversized installer output does not terminate installation")
    check(
        noisyStart.duration(to: .now) < .seconds(1),
        "oversized installer output completes in under one second")

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
    writeFile(activeHook, legacySourceHook)
    _ = chmod(activeHook, 0o755)
    writeFile(inspected + "/deno.json", #"{"tasks":{"ci":"deno task verify"}}"#)
    equal(
        await inspector.inspect(repository: inspected),
        .required("The effective pre-commit hook is not supported by mci."),
        "source hook is unsupported")
    writeFile(inspected + "/deno.json", "{")
    equal(
        await inspector.inspect(repository: inspected),
        .required("The effective pre-commit hook is not supported by mci."),
        "source hook stays unsupported with invalid configuration")

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

    writeFile(inspected + "/deno.json", "{")
    checkFailed(await stableInspector.inspect(repository: inspected), "managed hook reports invalid configuration")
    try? managedConfig?.write(to: URL(fileURLWithPath: inspected + "/deno.json"))
    _ = chmod(managedHooks + "/pre-commit", 0o644)
    required(await stableInspector.inspect(repository: inspected), "managed hook must be executable")
    _ = chmod(managedHooks + "/pre-commit", 0o755)

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
