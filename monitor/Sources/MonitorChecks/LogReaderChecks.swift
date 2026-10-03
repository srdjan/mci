import Foundation
import MonitorCore

private func logDirectory(_ root: String) -> String { root + "/.mci/ci" }

private func makeDirectory(_ path: String) {
    try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
}

private func writeBytes(_ path: String, _ bytes: [UInt8]) {
    makeDirectory((path as NSString).deletingLastPathComponent)
    FileManager.default.createFile(atPath: path, contents: Data(bytes))
}

private func tail(_ result: Result<LogTail, LogError>) -> LogTail? {
    if case .success(let value) = result { return value }
    return nil
}

@MainActor func checkLogReader() {
    let root = makeScratch()
    defer { removeScratch(root) }
    func workspace(_ name: String) -> String { root + "/" + name }

    equal(readLogTail(workspace: workspace("none")), .failure(.missing), "missing workspace")
    makeDirectory(logDirectory(workspace("empty")))
    equal(readLogTail(workspace: workspace("empty")), .failure(.missing), "missing log")

    let linked = workspace("linked")
    writeFile(root + "/target.log", "secret\n")
    makeDirectory(logDirectory(linked))
    try? FileManager.default.createSymbolicLink(
        atPath: logDirectory(linked) + "/latest.log", withDestinationPath: root + "/target.log")
    equal(readLogTail(workspace: linked), .failure(.notFile), "symlink is not read")

    let directory = workspace("dir")
    makeDirectory(logDirectory(directory) + "/latest.log")
    equal(readLogTail(workspace: directory), .failure(.notFile), "directory is not read")

    let small = workspace("small")
    writeFile(logDirectory(small) + "/latest.log", "line one\nline two\n")
    equal(
        readLogTail(workspace: small + "/"),
        .success(LogTail(text: "line one\nline two\n", truncated: false, size: 18)),
        "small file is read whole")
    equal(
        readLogTail(workspace: small, maxBytes: 18),
        .success(LogTail(text: "line one\nline two\n", truncated: false, size: 18)),
        "file of exactly the limit is not truncated")

    let zero = workspace("zero")
    writeFile(logDirectory(zero) + "/latest.log", "")
    equal(
        readLogTail(workspace: zero), .success(LogTail(text: "", truncated: false, size: 0)),
        "empty file")

    // 300 KiB of numbered lines of different lengths.
    let big = workspace("big")
    var text = ""
    var number = 0
    while text.utf8.count < 300 * 1024 {
        text += "line \(number) " + String(repeating: "x", count: number % 37) + "\n"
        number += 1
    }
    let lastLine = "line \(number - 1) " + String(repeating: "x", count: (number - 1) % 37)
    writeFile(logDirectory(big) + "/latest.log", text)
    let cut = tail(readLogTail(workspace: big))
    check(cut != nil, "big file is read")
    if let cut {
        check(cut.truncated, "big file is truncated")
        check(cut.size <= 262_144 && cut.size > 262_144 - 100, "big size \(cut.size) is near the limit")
        check(cut.text.hasSuffix(lastLine + "\n"), "tail ends with the last line")
        check(cut.text.hasPrefix("line "), "tail starts at a line start")
        check(text.hasSuffix(cut.text), "tail is a suffix of the file")
        check(cut.text.utf8.count == cut.size, "size is the byte count of the text")
        let lines = cut.text.split(separator: "\n", omittingEmptySubsequences: false)
        check(
            lines.dropLast().allSatisfy { $0.hasPrefix("line ") }, "every line in the tail is whole")
    }

    // A window that starts exactly on a line boundary keeps its first line.
    let boundary = workspace("boundary")
    writeFile(logDirectory(boundary) + "/latest.log", "aaaa\nbbbb\ncccc\n")
    equal(
        readLogTail(workspace: boundary, maxBytes: 10),
        .success(LogTail(text: "bbbb\ncccc\n", truncated: true, size: 10)),
        "window on a line boundary keeps its first line")
    equal(
        readLogTail(workspace: boundary, maxBytes: 11),
        .success(LogTail(text: "bbbb\ncccc\n", truncated: true, size: 10)),
        "window inside a line drops the partial line")
    equal(
        readLogTail(workspace: boundary, maxBytes: 3),
        .success(LogTail(text: "", truncated: true, size: 0)),
        "a window that holds only a line end shows nothing")
    let oneLine = workspace("oneline")
    writeFile(logDirectory(oneLine) + "/latest.log", "aaaaaaaaaa")
    equal(
        readLogTail(workspace: oneLine, maxBytes: 3),
        .success(LogTail(text: "aaa", truncated: true, size: 3)),
        "a window with no line end keeps its bytes")

    let invalid = workspace("invalid")
    writeBytes(logDirectory(invalid) + "/latest.log", [0x61, 0xFF, 0x62, 0xC3, 0x0A])
    equal(
        tail(readLogTail(workspace: invalid))?.text, "a\u{FFFD}b\u{FFFD}\n",
        "invalid UTF-8 becomes replacement characters")

    // The reader never changes the file.
    let path = logDirectory(big) + "/latest.log"
    let before = try? FileManager.default.attributesOfItem(atPath: path)
    let bytesBefore = FileManager.default.contents(atPath: path)
    _ = readLogTail(workspace: big)
    let after = try? FileManager.default.attributesOfItem(atPath: path)
    check(
        (before?[.modificationDate] as? Date) == (after?[.modificationDate] as? Date),
        "modification time is unchanged")
    check(bytesBefore == FileManager.default.contents(atPath: path), "content is unchanged")
}
