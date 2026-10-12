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
}
