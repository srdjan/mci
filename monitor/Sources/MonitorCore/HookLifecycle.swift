import Foundation
import Observation

/// Retain each installation until its CLI confirms commit or restoration completion.
@MainActor @Observable public final class HookLifecycle {
    private var operations: [String: Task<Void, Never>] = [:]
    private var closing = false

    public init() {}

    public func contains(repository: String) -> Bool {
        operations[repository] != nil
    }

    @discardableResult public func start(
        repository: String,
        operation: @escaping @MainActor () async -> Result<Void, HookInstallError>,
        completion: @escaping @MainActor (Result<Void, HookInstallError>) -> Void
    ) -> Bool {
        guard !closing, operations[repository] == nil else { return false }
        operations[repository] = Task {
            let result = await operation()
            operations.removeValue(forKey: repository)
            completion(result)
        }
        return true
    }

    public func cancel(repository: String) {
        operations[repository]?.cancel()
    }

    public func cancelAll() {
        for task in operations.values { task.cancel() }
    }

    public func drain() async {
        closing = true
        cancelAll()
        let tasks = Array(operations.values)
        for task in tasks { await task.value }
    }

    /// Return true when AppKit must wait for a later termination reply.
    public func requestTermination(reply: @escaping @MainActor () -> Void) -> Bool {
        closing = true
        guard !operations.isEmpty else { return false }
        Task {
            await drain()
            reply()
        }
        return true
    }
}
