import Foundation

public enum LogError: Error, Equatable, Sendable {
    case missing
    case notFile
    case read(String)
}

public struct LogTail: Equatable, Sendable {
    /// The decoded text. Invalid UTF-8 became U+FFFD.
    public let text: String
    /// True when the file was longer than the limit and the head is not in `text`.
    public let truncated: Bool
    /// The number of file bytes in `text`. It is never above the limit.
    public let size: Int

    public init(text: String, truncated: Bool, size: Int) {
        self.text = text
        self.truncated = truncated
        self.size = size
    }
}

public let logTailLimit = 262_144

private func errnoText() -> String { String(cString: strerror(errno)) }

/// Reads at most the last `maxBytes` of one log path.
/// It opens the file read-only and never follows a symlink.
/// A cut file starts at its first whole line.
public func readLogTail(path: String, maxBytes: Int = logTailLimit) -> Result<LogTail, LogError> {
    let limit = max(maxBytes, 1)
    var info = stat()
    if lstat(path, &info) != 0 {
        return errno == ENOENT || errno == ENOTDIR ? .failure(.missing) : .failure(.read(errnoText()))
    }
    guard (info.st_mode & S_IFMT) == S_IFREG else { return .failure(.notFile) }

    let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    if descriptor < 0 {
        switch errno {
        case ENOENT: return .failure(.missing)
        case ELOOP: return .failure(.notFile)
        default: return .failure(.read(errnoText()))
        }
    }
    defer { close(descriptor) }
    // The file may have changed between `lstat` and `open`.
    guard fstat(descriptor, &info) == 0 else { return .failure(.read(errnoText())) }
    guard (info.st_mode & S_IFMT) == S_IFREG else { return .failure(.notFile) }

    let fileSize = Int(info.st_size)
    let truncated = fileSize > limit
    // One extra byte before the window shows whether the window starts on a line boundary.
    let offset = truncated ? fileSize - limit - 1 : 0
    let total = truncated ? limit + 1 : fileSize
    var bytes = [UInt8](repeating: 0, count: total)
    var filled = 0
    while filled < total {
        let received = bytes.withUnsafeMutableBytes { buffer in
            pread(
                descriptor, buffer.baseAddress.map { $0 + filled }, total - filled,
                off_t(offset + filled))
        }
        if received < 0 {
            if errno == EINTR { continue }
            return .failure(.read(errnoText()))
        }
        if received == 0 { break }
        filled += received
    }
    bytes.removeSubrange(filled...)

    var start = 0
    if truncated, !bytes.isEmpty {
        if bytes[0] == 0x0A {
            start = 1
        } else if let newline = bytes.firstIndex(of: 0x0A) {
            start = newline + 1
        } else {
            start = 1  // one line longer than the window: keep what we have
        }
    }
    let shown = bytes[start...]
    return .success(
        LogTail(
            text: String(decoding: shown, as: UTF8.self), truncated: truncated, size: shown.count))
}
