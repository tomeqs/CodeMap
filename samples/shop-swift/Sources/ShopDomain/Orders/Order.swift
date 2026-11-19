import Foundation

public enum OrderError: Error {
    case empty
    case alreadyPaid
}

/// An order of a customer: lines of products, paid once.
public final class Order: Identifiable {
    public struct Line: Hashable {
        public let product: Product
        public let quantity: Int
    }

    public enum Status: String { case open, paid }

    public let id: UUID
    public private(set) var lines: [Line] = []
    public private(set) var status: Status = .open

    public init(id: UUID = UUID()) { self.id = id }

    /// One of a product.
    public func add(_ product: Product) {
        add(product, quantity: 1)
    }

    /// A quantity of a product; the same product again adds to its line.
    public func add(_ product: Product, quantity: Int) {
        if let index = lines.firstIndex(where: { $0.product == product }) {
            lines[index] = Line(product: product, quantity: lines[index].quantity + quantity)
        } else {
            lines.append(Line(product: product, quantity: quantity))
        }
    }

    public func markPaid() throws {
        guard status == .open else { throw OrderError.alreadyPaid }
        guard !lines.isEmpty else { throw OrderError.empty }
        status = .paid
    }

    /// The total before discounts were a thing; nothing uses it any more.
    private func legacyTotal() -> Money {
        lines.reduce(Money.zero) { $0 + $1.product.price }
    }
}
