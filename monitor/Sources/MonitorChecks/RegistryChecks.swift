import Foundation
import MonitorCore

private final class Outcomes: @unchecked Sendable {
    private let lock = NSLock()
    private var results: [Result<[String], MonitorError>] = []

    func append(_ result: Result<[String], MonitorError>) {
        lock.lock()
        results.append(result)
        lock.unlock()
    }

    var all: [Result<[String], MonitorError>] {
        lock.lock()
        defer { lock.unlock() }
        return results
    }
}

private func makeDirectory(_ path: String) {
    try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
}

private func isFailure<T>(_ result: Result<T, MonitorError>) -> Bool {
    if case .failure = result { return true }
    return false
}

@MainActor func checkRegistry() {
    let root = makeScratch()
    defer { removeScratch(root) }
    let registry = Registry(directory: root + "/registry")

    equal(registry.load(), .success([]), "missing registry file is empty")
    check(!FileManager.default.fileExists(atPath: registry.file), "load does not create the file")

    makeDirectory(root + "/real")
    try? FileManager.default.createSymbolicLink(
        atPath: root + "/alias", withDestinationPath: root + "/real")
    equal(registry.add(root + "/alias"), .success([root + "/real"]), "add canonicalizes a symlink")
    equal(registry.add(root + "/real"), .success([root + "/real"]), "add removes duplicates")
    equal(registry.add(root + "/real/"), .success([root + "/real"]), "trailing slash duplicate")
    equal(registry.load(), .success([root + "/real"]), "load after add")
    check(isFailure(registry.add("relative/path")), "add rejects a relative path")
    writeFile(root + "/file", "x")
    check(isFailure(registry.add(root + "/file")), "add rejects a file")
    check(isFailure(registry.add(root + "/nowhere")), "add rejects a missing path")
    equal(registry.load(), .success([root + "/real"]), "rejected adds change nothing")

    makeDirectory(root + "/second")
    equal(
        registry.add(root + "/second"), .success([root + "/real", root + "/second"]),
        "second add keeps order")
    equal(registry.remove(root + "/real"), .success([root + "/second"]), "remove")
    equal(registry.remove(root + "/real"), .success([root + "/second"]), "remove of absent path")
    equal(registry.remove(root + "/second"), .success([]), "remove last")

    let bad: [(String, String)] = [
        ("malformed JSON", "{"),
        ("version 2", "{\"version\":2,\"workspaces\":[]}"),
        ("version true", "{\"version\":true,\"workspaces\":[]}"),
        ("workspaces type", "{\"version\":1,\"workspaces\":{}}"),
        ("entry type", "{\"version\":1,\"workspaces\":[1]}"),
        ("relative entry", "{\"version\":1,\"workspaces\":[\"a\"]}"),
        ("extra key", "{\"version\":1,\"workspaces\":[],\"x\":1}"),
        ("array", "[]"),
    ]
    for (name, text) in bad {
        let folder = root + "/bad " + name
        makeDirectory(folder + "/registry")
        let broken = Registry(directory: folder + "/registry")
        writeFile(broken.file, text)
        check(isFailure(broken.load()), "\(name): load fails")
        check(isFailure(broken.add(root + "/real")), "\(name): add fails")
        check(isFailure(broken.remove(root + "/real")), "\(name): remove fails")
        equal(
            try? String(contentsOfFile: broken.file, encoding: .utf8), text,
            "\(name): file is untouched")
    }

    let shared = Registry(directory: root + "/shared")
    let count = 16
    for index in 0..<count { makeDirectory(root + "/repo\(index)") }
    let outcomes = Outcomes()
    DispatchQueue.concurrentPerform(iterations: count) { index in
        outcomes.append(shared.add(root + "/repo\(index)"))
    }
    check(outcomes.all.count == count && !outcomes.all.contains(where: isFailure), "concurrent adds succeed")
    if case .success(let saved) = shared.load() {
        equal(
            Set(saved), Set((0..<count).map { root + "/repo\($0)" }),
            "concurrent adds all persist")
        equal(saved.count, count, "concurrent adds hold no duplicates")
    } else {
        check(false, "the registry loads after concurrent adds")
    }
    let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: root + "/shared")) ?? []
    equal(
        leftovers.filter { $0.hasSuffix(".tmp") }.count, 0, "no temporary files remain")
}
