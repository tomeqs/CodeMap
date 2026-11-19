public enum OrderError: Error { case invalid, declined(reason: String) }

public struct Order {
    public struct Line {
        public let price: Int
        public func total() -> Int { price }
    }

    public var lines: [Line] = []
    public var note: String?
    public static let empty = Order()

    public static func make(lines: [Line]) -> Order { Order(lines: lines) }
    public func line(at index: Int) -> Line? { lines.indices.contains(index) ? lines[index] : nil }
    public func validated() throws -> Order {
        guard !lines.isEmpty else { throw OrderError.invalid }
        return self
    }
}

public protocol Priced { var amount: Int { get } }

extension String {
    public func slug() -> String { lowercased() }
}

@propertyWrapper
public struct Clamped {
    public var wrappedValue: Int
    public init(wrappedValue: Int) { self.wrappedValue = wrappedValue }
}
