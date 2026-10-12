import Darwin
import Foundation

public enum DaemonClientError: Error, Equatable, Sendable {
    case unavailable(String)
    case invalidResponse(String)
    case daemon(DaemonErrorTag, String)

    public var message: String {
        switch self {
        case .unavailable: "Daemon unavailable."
        case .invalidResponse(let detail): "The daemon returned an invalid response: \(detail)"
        case .daemon(let tag, let detail): detail.isEmpty ? "Daemon error: \(tag.rawValue)" : detail
        }
    }
}

public struct DaemonClient: Sendable {
    public let directory: String
    public let timeoutMilliseconds: Int32

    public init(
        directory: String = DaemonClient.defaultDirectory,
        timeoutMilliseconds: Int32 = 1_000
    ) {
        self.directory = directory
        self.timeoutMilliseconds = max(timeoutMilliseconds, 1)
    }

    public static var defaultDirectory: String {
        NSHomeDirectory() + "/Library/Application Support/mci"
    }

    public var socketPath: String { directory + "/daemon.sock" }

    public func ping() async -> Result<DaemonSnapshot, DaemonClientError> {
        await request(["version": 1, "op": "ping"])
    }

    public func status() async -> Result<DaemonSnapshot, DaemonClientError> {
        await request(["version": 1, "op": "status"])
    }

    public func register(path: String) async -> Result<DaemonSnapshot, DaemonClientError> {
        await request(["version": 1, "op": "register", "path": path])
    }

    public func unregister(repository: String) async -> Result<DaemonSnapshot, DaemonClientError> {
        await request(["version": 1, "op": "unregister", "repository": repository])
    }

    private func request(_ object: [String: Any]) async -> Result<DaemonSnapshot, DaemonClientError> {
        let path = socketPath
        let timeout = timeoutMilliseconds
        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: object, options: []) + Data([0x0A])
        } catch {
            return .failure(.invalidResponse(error.localizedDescription))
        }
        return await Task.detached(priority: .utility) {
            switch exchange(path: path, request: data, timeoutMilliseconds: timeout) {
            case .failure(let failure): return .failure(.unavailable(failure.message))
            case .success(let response):
                switch decodeDaemonResponse(data: response) {
                case .failure(let error): return .failure(.invalidResponse(error.message))
                case .success(.ok(let snapshot)): return .success(snapshot)
                case .success(.error(let tag, let detail)): return .failure(.daemon(tag, detail))
                }
            }
        }.value
    }
}

private let daemonResponseLimit = 4 * 1_024 * 1_024

private struct SocketFailure: Error {
    let message: String
}

private func socketError() -> String { String(cString: strerror(errno)) }

private func waitForSocket(
    _ descriptor: Int32, events: Int16, deadline: UInt64
) -> Result<Void, SocketFailure> {
    var item = pollfd(fd: descriptor, events: events, revents: 0)
    while true {
        let now = DispatchTime.now().uptimeNanoseconds
        guard now < deadline else {
            return .failure(SocketFailure(message: "The daemon request timed out."))
        }
        let remaining = (deadline - now + 999_999) / 1_000_000
        let timeout = Int32(min(remaining, UInt64(Int32.max)))
        let result = poll(&item, 1, timeout)
        if result > 0 {
            if item.revents & events != 0 { return .success(()) }
            guard item.revents & (Int16(POLLERR) | Int16(POLLHUP) | Int16(POLLNVAL)) == 0 else {
                return .failure(SocketFailure(message: "The daemon socket closed."))
            }
            return .success(())
        }
        if result == 0 {
            return .failure(SocketFailure(message: "The daemon request timed out."))
        }
        if errno != EINTR { return .failure(SocketFailure(message: socketError())) }
    }
}

private func exchange(
    path: String, request: Data, timeoutMilliseconds: Int32
) -> Result<Data, SocketFailure> {
    let deadline = DispatchTime.now().uptimeNanoseconds
        + UInt64(timeoutMilliseconds) * 1_000_000
    guard path.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
        return .failure(SocketFailure(message: "The daemon socket path is too long."))
    }
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { return .failure(SocketFailure(message: socketError())) }
    defer { close(descriptor) }

    var noSignal: Int32 = 1
    _ = setsockopt(
        descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal,
        socklen_t(MemoryLayout<Int32>.size))
    let flags = fcntl(descriptor, F_GETFL)
    guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
        return .failure(SocketFailure(message: socketError()))
    }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let pathBytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { bytes in
        bytes.initializeMemory(as: UInt8.self, repeating: 0)
        bytes.copyBytes(from: pathBytes)
    }
    let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if connected != 0 {
        guard errno == EINPROGRESS else {
            return .failure(SocketFailure(message: socketError()))
        }
        if case .failure(let failure) = waitForSocket(
            descriptor, events: Int16(POLLOUT), deadline: deadline)
        {
            return .failure(failure)
        }
        var connectError: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(descriptor, SOL_SOCKET, SO_ERROR, &connectError, &length) == 0,
            connectError == 0
        else {
            let detail = connectError == 0 ? socketError() : String(cString: strerror(connectError))
            return .failure(SocketFailure(message: detail))
        }
    }

    var sent = 0
    while sent < request.count {
        if case .failure(let failure) = waitForSocket(
            descriptor, events: Int16(POLLOUT), deadline: deadline)
        {
            return .failure(failure)
        }
        let count = request.withUnsafeBytes { bytes in
            Darwin.write(descriptor, bytes.baseAddress.map { $0 + sent }, request.count - sent)
        }
        if count < 0 {
            if errno == EINTR || errno == EAGAIN { continue }
            return .failure(SocketFailure(message: socketError()))
        }
        sent += count
    }

    var response = Data()
    var buffer = [UInt8](repeating: 0, count: 16_384)
    while response.count <= daemonResponseLimit {
        if case .failure(let failure) = waitForSocket(
            descriptor, events: Int16(POLLIN), deadline: deadline)
        {
            return .failure(failure)
        }
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count < 0 {
            if errno == EINTR || errno == EAGAIN { continue }
            return .failure(SocketFailure(message: socketError()))
        }
        if count == 0 {
            return .failure(SocketFailure(message: "The daemon closed without a response."))
        }
        response.append(contentsOf: buffer.prefix(count))
        if let newline = response.firstIndex(of: 0x0A) {
            return .success(Data(response[..<newline]))
        }
    }
    return .failure(SocketFailure(message: "The daemon response is too large."))
}
