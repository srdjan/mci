import Foundation
import MonitorCore

@MainActor private final class InstallationGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var started: CheckedContinuation<Void, Never>?
    private(set) var running = false

    func wait() async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            running = true
            started?.resume()
            started = nil
        }
    }

    func waitForStart() async {
        if running { return }
        await withCheckedContinuation { started = $0 }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}

@MainActor func checkHookLifecycle() async {
    let clock = ContinuousClock()
    let start = clock.now
    let lifecycle = HookLifecycle()
    let gate = InstallationGate()
    var completed = false
    var cancelled = false
    var diagnostic: String?
    check(lifecycle.start(repository: "removed", operation: {
        await gate.wait()
        cancelled = Task.isCancelled
        return .failure(.failed(exitCode: 143, stderr: "Rollback failed: retained detail"))
    }, completion: { result in
        completed = true
        if case .failure(let error) = result { diagnostic = error.message }
    }), "The lifecycle starts an installation")
    await gate.waitForStart()
    lifecycle.cancel(repository: "removed")
    check(lifecycle.contains(repository: "removed"), "Cancellation retains the owned installation")
    check(!completed, "Cancellation waits for the installation result")
    check(!lifecycle.start(repository: "removed", operation: { .success(()) }, completion: { _ in }),
        "The lifecycle refuses duplicate installation during cleanup")
    var replied = false
    var completionPrecededReply = false
    check(lifecycle.requestTermination {
        completionPrecededReply = completed
        replied = true
    }, "Normal Quit defers termination during cleanup")
    check(!replied, "Normal Quit waits for the installation handshake")
    check(!lifecycle.start(repository: "new", operation: { .success(()) }, completion: { _ in }),
        "Normal Quit refuses new installations")
    gate.release()
    await lifecycle.drain()
    // The termination task can resume after this drain's continuation.
    let replyDeadline = clock.now + .milliseconds(300)
    while !replied && clock.now < replyDeadline { await Task.yield() }
    check(cancelled, "The owned installation receives task cancellation")
    check(completed && completionPrecededReply, "Normal Quit receives the result before its reply")
    check(diagnostic?.contains("Rollback failed: retained detail") == true,
        "Cancellation retains restoration diagnostics for removed repositories")
    check(!lifecycle.contains(repository: "removed"), "The handshake releases the owned task")
    check(clock.now - start < .seconds(1), "The lifecycle cancellation scenario takes less than one second")

    let empty = HookLifecycle()
    var emptyReply = false
    check(!empty.requestTermination { emptyReply = true }, "Normal Quit proceeds immediately without installation")
    check(!emptyReply, "Immediate Quit needs no deferred reply")
    check(!empty.start(repository: "late", operation: { .success(()) }, completion: { _ in }),
        "Immediate Quit closes installation admission")

    let successful = HookLifecycle()
    let successGate = InstallationGate()
    var success = false
    check(successful.start(repository: "committed", operation: {
        await successGate.wait()
        return .success(())
    }, completion: { result in
        if case .success = result { success = true }
    }), "The lifecycle starts the committed installation fixture")
    await successGate.waitForStart()
    successful.cancelAll()
    successGate.release()
    await successful.drain()
    check(success, "The lifecycle preserves success after late cancellation")
}
