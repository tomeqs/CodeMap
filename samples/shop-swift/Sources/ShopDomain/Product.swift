public struct Product: Hashable, Sendable {
    public let sku: String
    public let name: String
    public let price: Money

    public init(sku: String, name: String, price: Money) {
        self.sku = sku
        self.name = name
        self.price = price
    }
}
