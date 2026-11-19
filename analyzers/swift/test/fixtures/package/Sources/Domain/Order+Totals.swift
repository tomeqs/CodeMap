extension Order: CustomStringConvertible {
    public var description: String { "Order \(id)" }
    var count: Int { lines.reduce(0) { $0 + $1.quantity } }
}

extension String {
    func trimmed() -> String { trimmingCharacters(in: .whitespaces) }
}
