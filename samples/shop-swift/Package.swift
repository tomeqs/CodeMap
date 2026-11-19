// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ShopSwift",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "ShopKit", targets: ["ShopDomain", "ShopApp", "ShopInfra"])],
    dependencies: [.package(url: "https://github.com/vapor/vapor.git", from: "4.99.0")],
    targets: [
        .target(name: "ShopDomain"),
        .target(name: "ShopApp", dependencies: ["ShopDomain"]),
        .target(name: "ShopInfra", dependencies: ["ShopApp"]),
        .executableTarget(name: "shop-cli", dependencies: ["ShopInfra"]),
        .executableTarget(name: "ShopServer", dependencies: ["ShopInfra", .product(name: "Vapor", package: "vapor")]),
        .testTarget(name: "ShopTests", dependencies: ["ShopInfra"]),
    ]
)
