import Foundation

public func relativeTime(from date: Date, now: Date) -> String {
    let seconds = Int(now.timeIntervalSince(date))
    if seconds < 10 { return "just now" }
    if seconds < 60 { return "\(seconds) s ago" }
    if seconds < 3600 { return "\(seconds / 60) min ago" }
    if seconds < 86400 { return "\(seconds / 3600) h ago" }
    return "\(seconds / 86400) d ago"
}

/// `m:ss`, or `h:mm:ss` from one hour.
public func runningTime(since start: Date, now: Date) -> String {
    let total = max(0, Int(now.timeIntervalSince(start)))
    let seconds = total % 60
    let minutes = (total / 60) % 60
    let hours = total / 3600
    if hours > 0 {
        return String(format: "%d:%02d:%02d", hours, minutes, seconds)
    }
    return String(format: "%d:%02d", minutes, seconds)
}

/// `12.4 s` below one minute, otherwise `3 min 05 s`.
public func durationText(_ seconds: TimeInterval) -> String {
    let value = max(0, seconds)
    if (value * 10).rounded() < 600 { return String(format: "%.1f s", value) }
    let total = Int(value.rounded())
    return String(format: "%d min %02d s", total / 60, total % 60)
}
