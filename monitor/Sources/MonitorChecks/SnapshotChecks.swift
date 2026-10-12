import Foundation
import MonitorCore

private func defaultSnapshotFixtureDirectory() -> String {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<4 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("tests/fixtures/daemon").path
}

@MainActor func checkSnapshotFixtures() {
    let directory = defaultSnapshotFixtureDirectory()
    let names = ((try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? [])
        .filter { $0.hasPrefix("snapshot-") && ($0.hasSuffix(".json") || $0.hasSuffix(".txt")) }.sorted()
    check(!names.isEmpty, "no daemon snapshot fixtures found in \(directory)")
    for name in names {
        guard let data = FileManager.default.contents(atPath: directory + "/" + name) else {
            check(false, "\(name): unreadable fixture")
            continue
        }
        let result = decodeSnapshot(data: data)
        if name.hasPrefix("snapshot-valid-") {
            if case .failure(let error) = result {
                check(false, "\(name): expected a snapshot, received \(error.message)")
            }
        } else if name.hasPrefix("snapshot-invalid-") {
            if case .success = result { check(false, "\(name): expected a decode failure") }
        } else {
            check(false, "\(name): fixture name does not state its expected result")
        }
    }

    checkDaemonResponses()
    checkDaemonRows()
}

@MainActor private func checkDaemonResponses() {
    let snapshot = """
        {"version":1,"instance":"daemon-a","pid":7,
        "updated":"2026-10-03T18:00:00.000Z","repositories":[]}
        """
    let ok = Data("{\"version\":1,\"type\":\"ok\",\"snapshot\":\(snapshot)}".utf8)
    if case .success(.ok(let decoded)) = decodeDaemonResponse(data: ok) {
        equal(decoded.instance, "daemon-a", "an ok response holds its snapshot")
    } else {
        check(false, "an ok response decodes")
    }
    let busy = Data(
        "{\"version\":1,\"type\":\"error\",\"tag\":\"busy\",\"detail\":\"active\"}".utf8)
    equal(
        decodeDaemonResponse(data: busy), .success(.error(.busy, "active")),
        "a busy response remains an expected daemon error")
    let unexpected = Data(
        "{\"version\":1,\"type\":\"accepted\",\"id\":\"run-a\",\"log\":\"/tmp/a.log\"}".utf8)
    if case .failure = decodeDaemonResponse(data: unexpected) {
        check(true, "the monitor refuses a submit-only response")
    } else {
        check(false, "the monitor refuses a submit-only response")
    }
}

@MainActor private func checkDaemonRows() {
    let root = makeScratch()
    defer { removeScratch(root) }
    let path = root + "/repository"
    try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    let text = """
        {"version":1,"instance":"daemon-a","pid":7,
        "updated":"2026-10-03T18:00:12.400Z","repositories":[{
        "id":"stable-id","path":"\(path)","queued":2,
        "active":{"id":"active-id","workflow":"ci.yml","job":"check",
        "started":"2026-10-03T18:00:10.000Z","step":"test","log":"/tmp/active.log"},
        "latest":{"id":"latest-id","repositoryId":"stable-id","workflow":"ci.yml",
        "job":"check","started":"2026-10-03T17:59:00.000Z",
        "finished":"2026-10-03T17:59:12.400Z","kind":"failure","code":1,
        "completed":2,"total":3,"detail":"test","log":"/tmp/latest.log"},
        "blocked":null}]}
        """
    guard case .success(let snapshot) = decodeSnapshot(data: Data(text.utf8)),
        let repository = snapshot.repositories.first
    else {
        check(false, "daemon row source decodes")
        return
    }

    let live = rowState(repository: repository, daemonAvailable: true)
    equal(live.repositoryID, "stable-id", "row uses the stable repository ID")
    equal(live.kind, .running, "an active job is running")
    equal(live.detail, "test", "an active job shows its step")
    equal(live.selectedLog, "/tmp/active.log", "an active job selects its active log")
    check(live.latest != nil, "an active job keeps its last completed result")
    if let latest = live.latest {
        equal(
            terminalSummary(latest, now: parseTimestamp("2026-10-03T18:00:00.400Z")!),
            "Last run failed \u{00B7} 48 s ago \u{00B7} test \u{00B7} exit 1 \u{00B7} 12.4 s",
            "the last run summary names the result, time, step, code, and duration")
    }

    let stale = rowState(repository: repository, daemonAvailable: false)
    equal(stale.kind, .fail, "a stale active job shows only its completed result")
    equal(stale.active, nil, "a stale snapshot does not show an active job")
    equal(stale.queued, 0, "a stale snapshot does not show queued jobs")
    equal(stale.selectedLog, "/tmp/latest.log", "a stale snapshot selects the completed log")

    try? FileManager.default.removeItem(atPath: path)
    let missing = rowState(repository: repository, daemonAvailable: true)
    equal(missing.kind, .missing, "a missing repository remains visible")
    equal(missing.repositoryID, "stable-id", "a missing repository remains removable by ID")
}
