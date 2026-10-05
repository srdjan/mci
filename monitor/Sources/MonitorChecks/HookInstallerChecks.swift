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
}
