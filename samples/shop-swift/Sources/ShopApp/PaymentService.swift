import Foundation
import ShopDomain

/// Charges orders through the gateway; a refund looks the order up through the order service.
public final class PaymentService {
    private let gateway: PaymentGateway
    private let orders: OrderService

    public init(gateway: PaymentGateway, orders: OrderService) {
        self.gateway = gateway
        self.orders = orders
    }

    public func charge(_ order: Order) throws -> String {
        let receipt = try gateway.charge(order.total, reference: order.id.uuidString)
        try order.markPaid()
        return receipt
    }

    public func refund(orderID: UUID) -> Bool {
        orders.order(id: orderID) != nil
    }
}
