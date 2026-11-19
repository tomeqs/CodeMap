extension Order {
    public var total: Money {
        lines.reduce(Money.zero) { $0 + $1.product.price.times($1.quantity) }
    }

    public var itemCount: Int { lines.reduce(0) { $0 + $1.quantity } }
}
