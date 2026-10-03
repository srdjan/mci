import Foundation
import MonitorCore

@MainActor func checkText() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func ago(_ seconds: TimeInterval) -> String {
        relativeTime(from: now.addingTimeInterval(-seconds), now: now)
    }
    let relative: [(TimeInterval, String)] = [
        (0, "just now"), (9, "just now"), (10, "10 s ago"), (59, "59 s ago"),
        (60, "1 min ago"), (3599, "59 min ago"), (3600, "1 h ago"), (86399, "23 h ago"),
        (86400, "1 d ago"), (259_200, "3 d ago"),
    ]
    for (seconds, expected) in relative { equal(ago(seconds), expected, "relative \(seconds) s") }
    equal(ago(-5), "just now", "a time in the future")

    func running(_ seconds: TimeInterval) -> String {
        runningTime(since: now.addingTimeInterval(-seconds), now: now)
    }
    equal(running(0), "0:00", "running 0 s")
    equal(running(65), "1:05", "running 65 s")
    equal(running(3599), "59:59", "running 59:59")
    equal(running(3725), "1:02:05", "running over one hour")

    let durations: [(TimeInterval, String)] = [
        (0, "0.0 s"), (12.4, "12.4 s"), (59.9, "59.9 s"), (59.96, "1 min 00 s"),
        (60, "1 min 00 s"), (185, "3 min 05 s"), (3725, "62 min 05 s"),
    ]
    for (seconds, expected) in durations { equal(durationText(seconds), expected, "duration \(seconds)") }
}
