// swift-tools-version:5.9
import PackageDescription

let shopDependencies: [Target.Dependency] = ["Domain", .product(name: "Logging", package: "swift-log")]

let package = Package(
    name: "Shop",
    products: [.library(name: "Shop", targets: ["Shop"])],
    dependencies: [.package(url: "https://github.com/apple/swift-log.git", from: "1.5.0")],
    targets: [
        .target(name: "Domain"),
        .target(name: "Shop", dependencies: shopDependencies, path: "Sources/ShopApp", exclude: ["Legacy"]),
        .testTarget(name: "ShopTests", dependencies: ["Shop"]),
    ]
)

package.targets += [.executableTarget(name: "shop-cli", dependencies: [.byName(name: "Shop")])]
