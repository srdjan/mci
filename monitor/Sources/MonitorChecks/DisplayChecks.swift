import MonitorCore

@MainActor func checkDisplay() {
    let order: [DisplayKind] = [
        .unavailable, .error, .missing, .interrupted, .fail, .running, .queued, .cancelled,
        .pass, .noRuns,
    ]
    func rows(_ kinds: [DisplayKind]) -> [RowState] {
        kinds.enumerated().map { RowState(workspace: "/r/\($0.offset)", kind: $0.element) }
    }
    for (index, urgent) in order.enumerated() {
        for other in order[(index + 1)...] {
            equal(combinedState(rows([other, urgent])).kind, urgent, "\(urgent) beats \(other)")
            equal(combinedState(rows([urgent, other])).kind, urgent, "\(urgent) beats \(other)")
        }
    }
    equal(Set(order), Set(DisplayKind.allCases), "the urgency list covers every state")
    let all = combinedState(rows(order))
    equal(all.kind, .unavailable, "combined of every state")
    equal(all.attention, 5, "attention count covers unavailable and failed states")
    let calm = combinedState(rows([.running, .queued, .cancelled, .pass, .noRuns]))
    equal(calm.attention, 0, "calm states need no attention")
    let empty = combinedState([])
    equal(empty.kind, .noRuns, "empty registry kind")
    equal(empty.attention, 0, "empty registry count")
    equal(
        combinedState(rows([.pass]), daemonAvailable: false).kind, .unavailable,
        "daemon availability overrides historical rows")

    let hookMissing = RowState(
        workspace: "/repository", kind: .pass,
        hookReadiness: .required("The pre-commit hook is missing."))
    equal(hookMissing.kind, .pass, "a missing hook does not change the completed CI result")
    equal(combinedState([hookMissing]).kind, .error, "a missing hook needs menu bar attention")
    equal(combinedState([hookMissing]).attention, 1, "a missing hook counts once")
    let hookUnknown = RowState(
        workspace: "/repository", kind: .fail,
        hookReadiness: .checkFailed("Git could not read the repository."))
    equal(combinedState([hookUnknown]).attention, 1, "hook and CI errors count one repository")
    equal(
        combinedState([hookMissing], daemonAvailable: false).kind, .unavailable,
        "daemon unavailability overrides a cached hook warning")
    let hookInstalled = RowState(workspace: "/repository", kind: .noRuns, hookReadiness: .installed)
    equal(combinedState([hookInstalled]).kind, .noRuns, "an installed hook does not invent a CI run")
    equal(combinedState([hookInstalled]).attention, 0, "an installed hook needs no attention")
}
