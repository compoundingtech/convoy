// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "convoy",
    platforms: [
        .macOS(.v13) // MenuBarExtra requires macOS 13+
    ],
    products: [
        .executable(name: "convoy", targets: ["convoy"]),
        .executable(name: "ConvoyApp", targets: ["ConvoyApp"]),
        .library(name: "ConvoyKit", targets: ["ConvoyKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.3.0"),
    ],
    targets: [
        // Shared kit: shell-out helpers, bus (st) access, correct-by-construction agent config.
        .target(
            name: "ConvoyKit"
        ),
        // The convoy CLI — the single front door. Orchestrates st + pty; reimplements neither.
        .executableTarget(
            name: "convoy",
            dependencies: [
                "ConvoyKit",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ]
        ),
        // The macOS menubar app (SwiftUI MenuBarExtra). Bundled into Convoy.app via Swift Bundler.
        .executableTarget(
            name: "ConvoyApp",
            dependencies: ["ConvoyKit"]
        ),
        .testTarget(
            name: "ConvoyKitTests",
            dependencies: ["ConvoyKit"]
        ),
    ]
)
