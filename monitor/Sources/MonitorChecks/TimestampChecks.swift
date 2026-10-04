import MonitorCore

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
