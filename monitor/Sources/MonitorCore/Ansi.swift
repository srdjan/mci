import Foundation

/// A terminal foreground color named by an SGR code.
public enum AnsiColor: Equatable, Sendable {
    case standard(Int)  // 0-7 from SGR 30-37
    case bright(Int)  // 0-7 from SGR 90-97
    case indexed(Int)  // 0-255 from SGR 38;5;n
}

/// Text with one style. Adjacent runs never share a style.
public struct StyledRun: Equatable, Sendable {
    public let text: String
    public let bold: Bool
    public let foreground: AnsiColor?

    public init(text: String, bold: Bool = false, foreground: AnsiColor? = nil) {
        self.text = text
        self.bold = bold
        self.foreground = foreground
    }
}

private struct AnsiStyle: Equatable {
    var bold = false
    var foreground: AnsiColor?
}

private struct Cell {
    let scalar: Unicode.Scalar
    let style: AnsiStyle
}

private let escape: UInt32 = 0x1B
private let bell: UInt32 = 0x07

/// Applies the codes of one SGR sequence to `style`. Unknown codes change nothing.
private func applySgr(_ parameters: [Int], to style: inout AnsiStyle) {
    var index = 0
    while index < parameters.count {
        let code = parameters[index]
        index += 1
        switch code {
        case 0: style = AnsiStyle()
        case 1: style.bold = true
        case 22: style.bold = false
        case 30...37: style.foreground = .standard(code - 30)
        case 39: style.foreground = nil
        case 90...97: style.foreground = .bright(code - 90)
        case 38, 48, 58:
            // Only 38 (foreground) applies. 48 and 58 are consumed so that their numbers
            // are not read as separate codes.
            guard index < parameters.count else { break }
            if parameters[index] == 5 {
                // `38;5;n`: a missing or out-of-range n is consumed without effect.
                if code == 38, index + 1 < parameters.count,
                    (0...255).contains(parameters[index + 1])
                {
                    style.foreground = .indexed(parameters[index + 1])
                }
                index = min(index + 2, parameters.count)
            } else if parameters[index] == 2 {
                // `38;2;r;g;b` is one unit and has no effect.
                index = min(index + 4, parameters.count)
            }
        default: break
        }
    }
}

/// The numbers of an SGR parameter text. An empty parameter is 0.
/// Text with any byte but digits and `;` is not SGR, so the result is nil.
private func sgrParameters(_ scalars: ArraySlice<Unicode.Scalar>) -> [Int]? {
    var values: [Int] = []
    var current: Int?
    var digits = 0
    func finish() {
        values.append(current ?? 0)
        current = nil
        digits = 0
    }
    for scalar in scalars {
        if scalar == ";" {
            finish()
        } else if scalar.value >= 0x30 && scalar.value <= 0x39 {
            digits += 1
            // Too many digits are out of range for every code.
            current = digits > 9 ? Int.max : (current ?? 0) * 10 + Int(scalar.value - 0x30)
        } else {
            return nil
        }
    }
    finish()
    return values
}

/// Where an escape sequence at `start` (the ESC) ends, and the SGR codes if it is SGR.
private enum EscapeResult {
    case consumed(end: Int, sgr: [Int]?)
    /// The sequence is malformed. Drop the bytes up to `resume` and go on from there.
    case dropped(resume: Int)
}

private func parseEscape(_ scalars: [Unicode.Scalar], at start: Int) -> EscapeResult {
    let count = scalars.count
    guard start + 1 < count else { return .dropped(resume: count) }
    let next = scalars[start + 1].value
    switch next {
    case 0x5B:  // CSI: ESC [ parameters intermediates final
        var index = start + 2
        while index < count, (0x30...0x3F).contains(scalars[index].value) { index += 1 }
        let parameterEnd = index
        while index < count, (0x20...0x2F).contains(scalars[index].value) { index += 1 }
        guard index < count, (0x40...0x7E).contains(scalars[index].value) else {
            return .dropped(resume: index)
        }
        let isSgr = scalars[index] == "m" && parameterEnd == index
        let parameters = isSgr ? sgrParameters(scalars[(start + 2)..<parameterEnd]) : nil
        return .consumed(end: index + 1, sgr: parameters)
    case 0x5D:  // OSC: ESC ] text, ended by BEL or ESC \
        var index = start + 2
        while index < count {
            if scalars[index].value == bell { return .consumed(end: index + 1, sgr: nil) }
            if scalars[index].value == escape, index + 1 < count, scalars[index + 1] == "\\" {
                return .consumed(end: index + 2, sgr: nil)
            }
            index += 1
        }
        return .consumed(end: count, sgr: nil)
    default:
        // ESC, intermediates (0x20-0x2F), one final byte (0x30-0x7E), such as `ESC ( B`.
        var index = start + 1
        while index < count, (0x20...0x2F).contains(scalars[index].value) { index += 1 }
        if index < count, (0x30...0x7E).contains(scalars[index].value) {
            return .consumed(end: index + 1, sgr: nil)
        }
        return .dropped(resume: start + 1)
    }
}

/// Splits terminal text into styled runs and removes the control sequences.
///
/// A lone carriage return overwrites the line, so only the text after the last one stays.
/// `\r\n` is a newline. Other C0 controls (and DEL) except `\n` and `\t` are dropped.
public func parseAnsi(_ text: String) -> [StyledRun] {
    let scalars = Array(text.unicodeScalars)
    var cells: [Cell] = []
    var lineStart = 0
    var style = AnsiStyle()
    var index = 0
    while index < scalars.count {
        let scalar = scalars[index]
        switch scalar.value {
        case escape:
            switch parseEscape(scalars, at: index) {
            case .consumed(let end, let sgr):
                if let sgr { applySgr(sgr, to: &style) }
                index = end
            case .dropped(let resume):
                index = resume
            }
            continue
        case 0x0D:
            if index + 1 < scalars.count, scalars[index + 1].value == 0x0A {
                index += 1  // `\r\n`: the `\n` below ends the line.
                continue
            }
            cells.removeSubrange(lineStart...)
        case 0x0A:
            cells.append(Cell(scalar: scalar, style: style))
            lineStart = cells.count
        case 0x09:
            cells.append(Cell(scalar: scalar, style: style))
        case 0x00..<0x20, 0x7F:
            break
        default:
            cells.append(Cell(scalar: scalar, style: style))
        }
        index += 1
    }
    return mergeRuns(cells)
}

private func mergeRuns(_ cells: [Cell]) -> [StyledRun] {
    var runs: [StyledRun] = []
    var buffer = String.UnicodeScalarView()
    var current: AnsiStyle?
    func flush() {
        guard let current, !buffer.isEmpty else { return }
        runs.append(
            StyledRun(
                text: String(buffer), bold: current.bold, foreground: current.foreground))
        buffer = String.UnicodeScalarView()
    }
    for cell in cells {
        if cell.style != current {
            flush()
            current = cell.style
        }
        buffer.append(cell.scalar)
    }
    flush()
    return runs
}

/// Red, green and blue (0-255) of an xterm palette entry 16-255, or nil below 16.
public func xtermRGB(_ index: Int) -> (red: Int, green: Int, blue: Int)? {
    guard (16...255).contains(index) else { return nil }
    if index >= 232 {
        let level = 8 + 10 * (index - 232)
        return (level, level, level)
    }
    let levels = [0, 95, 135, 175, 215, 255]
    let offset = index - 16
    return (levels[offset / 36], levels[(offset / 6) % 6], levels[offset % 6])
}
