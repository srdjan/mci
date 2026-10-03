import Foundation
import MonitorCore

private func canonical(_ object: Any) -> String {
    let data = try? JSONSerialization.data(
        withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed])
    return data.map { String(decoding: $0, as: UTF8.self) } ?? "<unserializable>"
}

private func dictionary(_ status: CiStatus) -> [String: Any] {
    let logger: Any = status.logger.map { ["started": $0.started, "command": $0.command] }
        ?? NSNull()
    return [
        "version": status.version,
        "logger": logger,
        "state": status.state.rawValue,
        "pid": status.pid,
        "started": status.started,
        "finished": status.finished.map { $0 as Any } ?? NSNull(),
        "code": status.code.map { $0 as Any } ?? NSNull(),
    ]
}

/// The repository root comes from the location of this source file.
func defaultFixtureDirectory() -> String {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<4 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("tests/fixtures/monitor/decode").path
}

@MainActor func checkDecodeFixtures(directory: String) {
    let names = ((try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? [])
        .filter { $0.hasSuffix(".json") }.sorted()
    check(!names.isEmpty, "no decode fixtures found in \(directory)")
    for name in names {
        let path = directory + "/" + name
        guard let data = FileManager.default.contents(atPath: path),
            let fixture = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let text = fixture["text"] as? String,
            let expected = fixture["expected"] as? [String: Any]
        else {
            check(false, "\(name): unreadable fixture")
            continue
        }
        let outcome = decodeStatus(data: Data(text.utf8))
        if let ok = expected["ok"] {
            switch outcome {
            case .success(let status):
                equal(canonical(dictionary(status)), canonical(ok), name)
            case .failure(let error):
                check(false, "\(name): expected a status, received error \(error.category)")
            }
        } else if let category = expected["error"] as? String {
            switch outcome {
            case .success:
                check(false, "\(name): expected error \(category), received a status")
            case .failure(let error):
                equal(error.category, category, name)
            }
        } else {
            check(false, "\(name): fixture has neither ok nor error")
        }
    }
}

@MainActor func checkTimestamps() {
    let valid = [
        "2026-10-03T10:00:00.000Z", "2024-02-29T00:00:00.000Z", "2026-12-31T23:59:59.999Z",
        "0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z",
        "2000-02-29T00:00:00.000Z",
    ]
    for text in valid { check(parseTimestamp(text) != nil, "timestamp \(text) is valid") }
    let invalid = [
        "2026-02-30T10:00:00.000Z", "2026-02-29T10:00:00.000Z", "1900-02-29T00:00:00.000Z",
        "2026-04-31T10:00:00.000Z", "2026-13-01T10:00:00.000Z",
        "2026-10-03T24:00:00.000Z", "2026-10-03T23:59:60.000Z", "2026-10-03T10:00:00Z",
        "2026-10-03T10:00:00.000+00:00", "2026-10-03T10:00:00.000Z\n", "2026-10-03 10:00:00.000Z",
        "",
    ]
    for text in invalid {
        check(parseTimestamp(text) == nil, "timestamp \(text.debugDescription) is invalid")
    }
}

@MainActor func checkStatusFiles() {
    let root = makeScratch()
    defer { removeScratch(root) }
    let valid = """
        {"version":1,"state":"pass","pid":7,"started":"2026-10-03T10:00:00.000Z",\
        "finished":"2026-10-03T10:00:01.000Z","code":0}
        """

    equal(readCiStatus(workspace: root + "/absent"), .success(nil), "missing workspace is no record")
    equal(readCiStatus(workspace: root), .success(nil), "missing status is no record")

    writeFile(root + "/ok/.mci/ci/status.json", valid)
    if case .success(let status?) = readCiStatus(workspace: root + "/ok") {
        equal(status.pid, 7, "status file pid")
    } else {
        check(false, "a valid status file decodes")
    }
    if case .success(let status?) = readCiStatus(workspace: root + "/ok/") {
        equal(status.pid, 7, "trailing slash workspace")
    } else {
        check(false, "a workspace with a trailing slash decodes")
    }

    writeFile(root + "/target.json", valid)
    try? FileManager.default.createDirectory(
        atPath: root + "/link/.mci/ci", withIntermediateDirectories: true)
    try? FileManager.default.createSymbolicLink(
        atPath: root + "/link/.mci/ci/status.json", withDestinationPath: root + "/target.json")
    equal(readCiStatus(workspace: root + "/link"), .failure(.notFile), "symlink status")

    try? FileManager.default.createDirectory(
        atPath: root + "/dir/.mci/ci/status.json", withIntermediateDirectories: true)
    equal(readCiStatus(workspace: root + "/dir"), .failure(.notFile), "directory status")

    writeFile(root + "/bad/.mci/ci/status.json", "{")
    if case .failure(.json) = readCiStatus(workspace: root + "/bad") {
        check(true, "invalid JSON")
    } else {
        check(false, "invalid JSON gives the json category")
    }
}
