// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Frameworks",
    dependencies: [
        .package(url: "https://github.com/vapor/vapor.git", from: "4.0.0"),
        .package(url: "https://github.com/vapor/fluent.git", from: "4.0.0"),
    ],
    targets: [
        .executableTarget(name: "Server", dependencies: [.product(name: "Vapor", package: "vapor"), .product(name: "Fluent", package: "fluent")]),
        .target(name: "Shop"),
        .testTarget(name: "ShopTests", dependencies: ["Shop"]),
    ]
)
