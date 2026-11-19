import Foundation
import ShopApp
import ShopDomain

public final class InMemoryOrderRepository: OrderRepository {
    private var orders: [UUID: Order] = [:]

    public init() {}

    public func save(_ order: Order) { orders[order.id] = order }
    public func find(id: UUID) -> Order? { orders[id] }
}
