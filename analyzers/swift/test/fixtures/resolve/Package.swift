// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Resolve",
    targets: [
        .target(name: "Domain"),
        .target(name: "Services", dependencies: ["Domain"]),
    ]
)
