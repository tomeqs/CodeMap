// swift-tools-version:5.9
import PackageDescription

let package = Package(name: "Checks", targets: [.target(name: "Checks"), .testTarget(name: "ChecksTests", dependencies: ["Checks"])])
