import MonitorCore

private let esc = "\u{1B}"

private func run(_ text: String, bold: Bool = false, _ foreground: AnsiColor? = nil) -> StyledRun {
    StyledRun(text: text, bold: bold, foreground: foreground)
}

@MainActor func checkAnsi() {
    func parse(_ text: String, _ expected: [StyledRun], _ message: String) {
        equal(parseAnsi(text), expected, message)
    }
    func plain(_ text: String, _ expected: String, _ message: String) {
        equal(parseAnsi(text).map(\.text).joined(), expected, message)
    }

    parse("", [], "empty text")
    parse("plain text", [run("plain text")], "plain text")
    parse("a\tb\nc", [run("a\tb\nc")], "tab and newline stay")
    parse("caf\u{E9} \u{1F600}", [run("caf\u{E9} \u{1F600}")], "non-ASCII text stays")

    parse("\(esc)[31mred\(esc)[0mplain", [run("red", .standard(1)), run("plain")], "reset")
    parse("\(esc)[mx", [run("x")], "empty SGR is reset")
    parse("\(esc)[31m\(esc)[mx", [run("x")], "empty SGR resets color")
    parse(
        "\(esc)[1mb\(esc)[22mn",
        [run("b", bold: true), run("n")], "bold on and off")
    parse(
        "\(esc)[31ma\(esc)[39mb",
        [run("a", .standard(1)), run("b")], "default foreground")
    parse("\(esc)[91mx", [run("x", .bright(1))], "bright red")
    parse("\(esc)[97mx", [run("x", .bright(7))], "bright white")
    parse("\(esc)[30mx", [run("x", .standard(0))], "standard black")
    parse("\(esc)[1;32mok", [run("ok", bold: true, .standard(2))], "compound bold and green")
    parse(
        "\(esc)[1;31;0mx", [run("x")], "reset inside a compound sequence")
    parse("\(esc)[38;5;196mx", [run("x", .indexed(196))], "indexed color")
    parse("\(esc)[38;5;0mx", [run("x", .indexed(0))], "indexed color 0")
    parse("\(esc)[38;5;255mx", [run("x", .indexed(255))], "indexed color 255")
    parse("\(esc)[38;5;300mtext", [run("text")], "indexed color out of range is ignored")
    parse(
        "\(esc)[31;38;5;300mtext", [run("text", .standard(1))],
        "out of range indexed color keeps the earlier color")
    parse("\(esc)[38;5mtext", [run("text")], "indexed color without a number")
    parse("\(esc)[38;2;10;20;30;1mx", [run("x", bold: true)], "truecolor is one unit, bold applies")
    parse(
        "\(esc)[38;2;1;2;3mx", [run("x")], "truecolor numbers are not SGR codes")
    parse("\(esc)[38;2;31;32;33mx", [run("x")], "truecolor numbers that look like colors")
    parse("\(esc)[48;5;196mx", [run("x")], "background color is ignored")
    parse("\(esc)[48;2;5;31;32mx", [run("x")], "truecolor background is ignored")
    parse("\(esc)[4;7;9mx", [run("x")], "other SGR codes are ignored")
    parse("\(esc)[31;4mx", [run("x", .standard(1))], "unknown code beside a known code")
    parse("\(esc)[99999999999999999999;31mx", [run("x", .standard(1))], "huge number is ignored")
    parse("\(esc)[38:2::1:2:3mx", [run("x")], "colon form is ignored")

    plain("a\(esc)]0;title\u{07}b", "ab", "OSC ended by BEL")
    plain("a\(esc)]8;;https://example.com\(esc)\\link\(esc)]8;;\(esc)\\b", "alinkb", "OSC ended by ST")
    plain("a\(esc)]0;never ends", "a", "unterminated OSC")
    plain("a\(esc)[2Kb\(esc)[1Ac\(esc)[?25hd", "abcd", "other CSI sequences")
    plain("a\(esc)[1;5Hb", "ab", "cursor position")
    plain("a\(esc)(Bb", "ab", "charset designation")
    plain("a\(esc)7b\(esc)8c", "abc", "two-byte sequences")
    plain("abc\(esc)", "abc", "lone ESC at the end")
    plain("a\(esc)\nb", "a\nb", "ESC before a newline keeps the newline")
    plain("a\(esc)\(esc)[31mb", "ab", "ESC before another sequence")
    parse(
        "a\(esc)\(esc)[31mb", [run("a"), run("b", .standard(1))],
        "ESC before another sequence still applies it")
    plain("a\(esc)[1;xb", "ab", "ESC [ 1 ; x is a whole CSI sequence")
    plain("a\(esc)[1;\u{01}b", "ab", "invalid byte inside the parameters")
    parse(
        "a\(esc)[1;\(esc)[31mb", [run("a"), run("b", .standard(1))],
        "ESC inside the parameters starts a new sequence")
    plain("a\(esc)[31", "a", "unfinished CSI at the end")
    plain("a\(esc)[1 ", "a", "unfinished intermediate at the end")
    plain("a\(esc)[1 !?b", "a?b", "parameter byte after an intermediate byte")

    plain("one\r\ntwo\r\n", "one\ntwo\n", "CRLF is a newline")
    plain("abc\rxyz", "xyz", "carriage return overwrites the line")
    plain("10%\r50%\r100%\ndone", "100%\ndone", "progress redraws collapse")
    plain("keep\nabc\rx\ny", "keep\nx\ny", "carriage return affects only its own line")
    plain("abc\r", "", "carriage return at the end clears the line")
    plain("abc\r\r\nnext", "\nnext", "lone carriage return before CRLF")
    parse(
        "\(esc)[31mred\rbl\(esc)[32mgreen",
        [run("bl", .standard(1)), run("green", .standard(2))],
        "style after an overwrite stays")
    parse(
        "\(esc)[31mred\rnew", [run("new", .standard(1))],
        "style before an overwrite carries on")
    plain("a\u{00}b\u{07}c\u{08}d\u{0B}e\u{0C}f\u{7F}g", "abcdefg", "other controls are dropped")

    parse(
        "\(esc)[31ma\(esc)[31mb\(esc)[1mc\(esc)[22md",
        [run("ab", .standard(1)), run("c", bold: true, .standard(1)), run("d", .standard(1))],
        "equal adjacent styles merge")
    parse(
        "a\(esc)[0mb\(esc)[mc", [run("abc")], "a style change to the same style merges")
    parse("\(esc)[31m\(esc)[32mx", [run("x", .standard(2))], "empty runs are not kept")

    let rgb = xtermRGB(196)
    check(rgb?.red == 255 && rgb?.green == 0 && rgb?.blue == 0, "xterm 196 is red")
    let cube = xtermRGB(16 + 36 * 1 + 6 * 2 + 3)
    check(cube?.red == 95 && cube?.green == 135 && cube?.blue == 175, "xterm cube levels")
    check(xtermRGB(231)?.red == 255, "xterm 231 is white")
    let gray = xtermRGB(232)
    check(gray?.red == 8 && gray?.green == 8 && gray?.blue == 8, "xterm 232 is gray")
    check(xtermRGB(255)?.red == 238, "xterm 255 is light gray")
    check(xtermRGB(15) == nil && xtermRGB(256) == nil, "xterm range")
}
