// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Monitor",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "MonitorCore"),
        .executableTarget(name: "MonitorApp", dependencies: ["MonitorCore"]),
        .executableTarget(name: "MonitorChecks", dependencies: ["MonitorCore"]),
    ]
)
