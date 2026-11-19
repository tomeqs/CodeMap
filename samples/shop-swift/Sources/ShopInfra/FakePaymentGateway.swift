import ShopApp
import ShopDomain

/// Pretends to charge: every payment goes through.
public final class FakePaymentGateway: PaymentGateway {
    public private(set) var charged: [String] = []

    public init() {}

    public func charge(_ amount: Money, reference: String) throws -> String {
        charged.append(reference)
        return "receipt-\(reference)-\(amount.cents)"
    }
}
