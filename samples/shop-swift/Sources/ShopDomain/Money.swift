/// An amount of money in cents, so sums are exact.
public struct Money: Hashable, Comparable, Sendable {
    public let cents: Int

    public init(cents: Int) { self.cents = cents }

    public static let zero = Money(cents: 0)

    public static func + (lhs: Money, rhs: Money) -> Money { Money(cents: lhs.cents + rhs.cents) }
    public static func < (lhs: Money, rhs: Money) -> Bool { lhs.cents < rhs.cents }

    public func times(_ quantity: Int) -> Money { Money(cents: cents * quantity) }
}
