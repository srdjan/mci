import Foundation

@MainActor private var total = 0
@MainActor private var failures = 0

@MainActor func check(_ condition: Bool, _ message: @autoclosure () -> String) {
    total += 1
    if !condition {
        failures += 1
        print("FAIL: \(message())")
    }
}

@MainActor func equal<T: Equatable>(_ actual: T, _ expected: T, _ message: String) {
    check(actual == expected, "\(message): expected \(expected), received \(actual)")
}

@MainActor func finish() -> Never {
    if failures > 0 {
        print("\(failures) of \(total) checks failed")
        exit(1)
    }
    print("ok \(total) checks")
    exit(0)
}

/// A new real directory that the caller removes with `removeScratch()`.
func makeScratch() -> String {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent(
        "monitor-checks-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    guard let resolved = realpath(base.path, nil) else { return base.path }
    defer { free(resolved) }
    return String(cString: resolved)
}

func removeScratch(_ path: String) {
    try? FileManager.default.removeItem(atPath: path)
}

func writeFile(_ path: String, _ text: String) {
    let parent = (path as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
    try? text.write(toFile: path, atomically: false, encoding: .utf8)
}
