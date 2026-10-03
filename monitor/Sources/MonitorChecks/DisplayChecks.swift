import Foundation
import MonitorCore

private struct FakeInspector: ProcessInspector {
    let result: Result<ProcessIdentity?, MonitorError>

    func inspect(pid: Int) async -> Result<ProcessIdentity?, MonitorError> { result }
}

private let startedText = "2026-10-03T10:00:00.000Z"
private let finishedText = "2026-10-03T10:00:12.400Z"
private let loggerStarted = "Sat Oct  3 10:00:00 2026"
private let loggerCommand = "deno run src/main.ts ci"

private func loggerJSON(_ started: String = loggerStarted, _ command: String = loggerCommand)
    -> String
{
    "\"logger\":{\"started\":\"\(started)\",\"command\":\"\(command)\"}"
}

private func statusJSON(
    state: String, finished: String?, code: Int?, logger: String?
) -> String {
    let finishedText = finished.map { "\"\($0)\"" } ?? "null"
    let codeText = code.map(String.init) ?? "null"
    let extra = logger.map { "," + $0 } ?? ""
    return """
        {"version":1,"state":"\(state)","pid":4242,"started":"\(startedText)",\
        "finished":\(finishedText),"code":\(codeText)\(extra)}
        """
}

private func identity(
    pid: Int = 4242, started: String = loggerStarted, command: String = loggerCommand
) -> Result<ProcessIdentity?, MonitorError> {
    .success(ProcessIdentity(pid: pid, pgid: pid, started: started, command: command))
}

private func row(
    _ root: String, _ name: String, _ json: String?,
    inspection: Result<ProcessIdentity?, MonitorError> = .success(nil)
) async -> RowState {
    let workspace = root + "/" + name
    try? FileManager.default.createDirectory(atPath: workspace, withIntermediateDirectories: true)
    if let json { writeFile(workspace + "/.mci/ci/status.json", json) }
    return await rowState(workspace: workspace, inspector: FakeInspector(result: inspection))
}

@MainActor func checkDisplay() async {
    let root = makeScratch()
    defer { removeScratch(root) }
    let started = parseTimestamp(startedText)
    let running = { (logger: String?) in
        statusJSON(state: "running", finished: nil, code: nil, logger: logger)
    }

    let match = await row(root, "match", running(loggerJSON()), inspection: identity())
    equal(match.kind, .running, "running match")
    equal(match.lastRun, started, "running match last run")

    let absent = await row(root, "absent", running(loggerJSON()))
    equal(absent.kind, .interrupted, "running absent")
    equal(
        absent.detail, "The recorded CI logger is no longer running.", "interrupted detail")

    let changedStart = await row(
        root, "changed-start", running(loggerJSON()),
        inspection: identity(started: "Sat Oct  3 10:00:01 2026"))
    equal(changedStart.kind, .interrupted, "changed started")

    let changedCommand = await row(
        root, "changed-command", running(loggerJSON()), inspection: identity(command: "other"))
    equal(changedCommand.kind, .interrupted, "changed command")

    let failed = await row(
        root, "inspection-error", running(loggerJSON()),
        inspection: .failure(.inspection("ps timed out")))
    equal(failed.kind, .error, "inspection error")
    check(failed.detail?.contains("ps timed out") == true, "inspection error detail")

    let legacyLive = await row(root, "legacy-live", running(nil), inspection: identity())
    equal(legacyLive.kind, .error, "legacy live")
    equal(legacyLive.detail, "Logger identity is unavailable", "legacy live detail")

    let legacyAbsent = await row(root, "legacy-absent", running(nil))
    equal(legacyAbsent.kind, .interrupted, "legacy absent")

    let loggerNull = await row(root, "logger-null", running("\"logger\":null"))
    equal(loggerNull.kind, .interrupted, "logger null and absent")

    let pass = await row(
        root, "pass", statusJSON(state: "pass", finished: finishedText, code: 0, logger: nil))
    equal(pass.kind, .pass, "pass kind")
    equal(pass.code, 0, "pass code")
    equal(pass.detail, "12.4 s", "pass detail")
    equal(pass.lastRun, parseTimestamp(finishedText), "pass last run")
    check(abs((pass.duration ?? 0) - 12.4) < 0.001, "pass duration")

    let fail = await row(
        root, "fail", statusJSON(state: "fail", finished: finishedText, code: 1, logger: nil))
    equal(fail.kind, .fail, "fail kind")
    equal(fail.code, 1, "fail code")
    equal(fail.detail, "exit 1 \u{00B7} 12.4 s", "fail detail")

    let cancelled = await row(
        root, "cancelled",
        statusJSON(state: "cancelled", finished: finishedText, code: 130, logger: nil))
    equal(cancelled.kind, .cancelled, "cancelled kind")
    equal(cancelled.detail, "exit 130 \u{00B7} 12.4 s", "cancelled detail")

    let none = await row(root, "none", nil)
    equal(none.kind, .noRuns, "no status file")
    equal(none.name, "none", "repository name")

    let broken = await row(root, "broken", "{")
    equal(broken.kind, .error, "invalid status file")
    check(broken.detail?.hasPrefix("json: ") == true, "decoder error category in detail")

    let absentFolder = await rowState(
        workspace: root + "/nowhere", inspector: FakeInspector(result: .success(nil)))
    equal(absentFolder.kind, .missing, "workspace that does not exist")
    writeFile(root + "/plain-file", "x")
    let fileFolder = await rowState(
        workspace: root + "/plain-file", inspector: FakeInspector(result: .success(nil)))
    equal(fileFolder.kind, .missing, "workspace that is a file")

    checkCombined()
}

@MainActor private func checkCombined() {
    let order: [DisplayKind] = [
        .error, .missing, .interrupted, .fail, .running, .cancelled, .pass, .noRuns,
    ]
    func rows(_ kinds: [DisplayKind]) -> [RowState] {
        kinds.enumerated().map { RowState(workspace: "/r/\($0.offset)", kind: $0.element) }
    }
    for (index, urgent) in order.enumerated() {
        for other in order[(index + 1)...] {
            equal(combinedState(rows([other, urgent])).kind, urgent, "\(urgent) beats \(other)")
            equal(combinedState(rows([urgent, other])).kind, urgent, "\(urgent) beats \(other)")
        }
    }
    equal(Set(order), Set(DisplayKind.allCases), "the urgency list covers every state")
    let all = combinedState(rows(order))
    equal(all.kind, .error, "combined of every state")
    equal(all.attention, 4, "attention count for error, missing, interrupted, fail")
    let calm = combinedState(rows([.running, .cancelled, .pass, .noRuns]))
    equal(calm.attention, 0, "calm states need no attention")
    let empty = combinedState([])
    equal(empty.kind, .noRuns, "empty registry kind")
    equal(empty.attention, 0, "empty registry count")
}

@MainActor func checkProcessParsing() async {
    let line = "  123   123 Sat Oct  3 10:00:00 2026 /usr/bin/foo --bar baz\n"
    equal(
        parseIdentity(pid: 123, output: line),
        .success(
            ProcessIdentity(
                pid: 123, pgid: 123, started: "Sat Oct  3 10:00:00 2026",
                command: "/usr/bin/foo --bar baz")),
        "valid ps line")
    equal(
        parseIdentity(pid: 1, output: "\n  \n" + line),
        parseIdentity(pid: 123, output: line), "blank lines are skipped")
    equal(parseIdentity(pid: 1, output: ""), .success(nil), "empty output")
    equal(parseIdentity(pid: 1, output: " \n\t\n"), .success(nil), "blank output")
    equal(
        parseIdentity(pid: 9, output: "garbage"),
        .failure(.inspection("Unable to parse process identity for 9")), "malformed output")
    equal(
        parseIdentity(pid: 9, output: "1 2 short"),
        .failure(.inspection("Unable to parse process identity for 9")), "short start text")

    let inspector = NativeProcessInspector()
    let own = Int(getpid())
    if case .success(let found?) = await inspector.inspect(pid: own) {
        equal(found.pid, own, "native inspection of this process")
        equal(found.started.utf16.count, 24, "native start text length")
    } else {
        check(false, "native inspection finds this process")
    }
    let child = Process()
    child.executableURL = URL(fileURLWithPath: "/usr/bin/true")
    if (try? child.run()) != nil {
        child.waitUntilExit()
        equal(
            await inspector.inspect(pid: Int(child.processIdentifier)), .success(nil),
            "native inspection of an exited process")
    } else {
        check(false, "the helper process starts")
    }
}
