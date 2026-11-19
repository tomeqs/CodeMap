import Foundation

/// An order of a customer.
public struct Order: Identifiable, Hashable {
    public struct Line: Hashable {
        public let product: String
        public let quantity: Int
    }

    public enum Status: String { case new, paid, shipped }

    public let id: UUID
    public private(set) var lines: [Line] = []
    var status: Status = .new
    static var created = 0

    public init(id: UUID = UUID()) {
        self.id = id
        Order.created += 1
    }

    /// Adds a line; a quantity of zero is ignored.
    public mutating func add(_ product: String, quantity: Int) {
        if quantity > 0 && !product.isEmpty {
            lines.append(Line(product: product, quantity: quantity))
        }
    }

    public mutating func add(_ line: Line) { lines.append(line) }
    public mutating func add(_ lines: [Line]) { self.lines += lines }
    public mutating func add(line: Line, at index: Int) { lines.insert(line, at: index) }

    fileprivate func audit() -> Bool { lines.count < 100 }
}
