import Foundation
import ShopDomain

/// Places orders and has them paid; refunds go back through it.
public final class OrderService {
    private let repository: OrderRepository
    public var payments: PaymentService?

    public init(repository: OrderRepository) {
        self.repository = repository
    }

    public func place(_ products: [Product], tier: Tier) -> Order {
        let order = Order()
        for product in products { order.add(product) }
        repository.save(order)
        _ = discount(for: tier, on: order.total)
        return order
    }

    public func checkout(_ order: Order) throws -> String {
        guard let payments else { throw OrderError.empty }
        return try payments.charge(order)
    }

    public func order(id: UUID) -> Order? { repository.find(id: id) }
}
