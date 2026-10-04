import Foundation

private func daysInMonth(year: Int, month: Int) -> Int {
    switch month {
    case 2: (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28
    case 4, 6, 9, 11: 30
    default: 31
    }
}

/// Days from 1970-01-01 to a proleptic Gregorian date.
private func daysSinceEpoch(year: Int, month: Int, day: Int) -> Int {
    let shifted = month <= 2 ? year - 1 : year
    let era = (shifted >= 0 ? shifted : shifted - 399) / 400
    let yearOfEra = shifted - era * 400
    let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
    let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
    return era * 146_097 + dayOfEra - 719_468
}

/// The date of a canonical `toISOString()` text, or nil for any other text.
/// The calendar check equals the round trip of `new Date(Date.parse(text)).toISOString()`.
public func parseTimestamp(_ text: String) -> Date? {
    let shape = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"
    guard text.utf8.count == 24, text.range(of: shape, options: .regularExpression) != nil
    else { return nil }
    let digits = Array(text.utf8)
    func field(_ start: Int, _ length: Int) -> Int {
        digits[start..<start + length].reduce(0) { $0 * 10 + Int($1) - 48 }
    }
    let year = field(0, 4), month = field(5, 2), day = field(8, 2)
    let hour = field(11, 2), minute = field(14, 2), second = field(17, 2)
    let millis = field(20, 3)
    guard (1...12).contains(month), day >= 1, day <= daysInMonth(year: year, month: month),
        hour < 24, minute < 60, second < 60
    else { return nil }
    let seconds = daysSinceEpoch(year: year, month: month, day: day) * 86400
        + hour * 3600 + minute * 60 + second
    return Date(timeIntervalSince1970: Double(seconds) + Double(millis) / 1000)
}
