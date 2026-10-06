public struct HookStatus: Equatable, Sendable {
    public private(set) var readiness: HookReadiness?
    public private(set) var installationError: HookInstallError?

    public init(
        readiness: HookReadiness? = nil,
        installationError: HookInstallError? = nil
    ) {
        self.readiness = readiness
        self.installationError = installationError
    }

    public var displayedReadiness: HookReadiness? {
        installationError.map { .required($0.message) } ?? readiness
    }

    public mutating func recordInspection(_ readiness: HookReadiness) {
        self.readiness = readiness
        if readiness == .installed {
            installationError = nil
        }
    }

    public mutating func recordInstallation(_ result: Result<Void, HookInstallError>) {
        switch result {
        case .success:
            readiness = nil
            installationError = nil
        case .failure(let error):
            installationError = error
        }
    }
}
