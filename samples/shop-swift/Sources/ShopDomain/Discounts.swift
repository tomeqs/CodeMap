public enum Tier: Sendable { case standard, silver, gold }

/// What a customer of a tier pays less, in cents.
public func discount(for tier: Tier, on total: Money) -> Money {
    switch tier {
    case .standard: return .zero
    case .silver: return Money(cents: total.cents / 20)
    case .gold: return Money(cents: total.cents / 10)
    }
}
