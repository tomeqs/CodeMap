import Domain

public protocol PaymentGateway: AnyObject {
    func charge(_ amount: Int) throws -> Receipt
}

public final class StripeGateway: PaymentGateway {
    public init() {}
    public func charge(_ amount: Int) throws -> Receipt { Receipt(amount: amount) }
    @objc func refresh() {}
}

open class BaseService {
    public init() {}
    open func log(_ message: String) {}
}
