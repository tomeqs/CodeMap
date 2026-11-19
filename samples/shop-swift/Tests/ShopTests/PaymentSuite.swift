import Testing
@testable import ShopApp
import ShopDomain
import ShopInfra

@Suite struct PaymentSuite {
    @Test func checkoutChargesTheGateway() throws {
        let gateway = FakePaymentGateway()
        let orders = OrderService(repository: InMemoryOrderRepository())
        orders.payments = PaymentService(gateway: gateway, orders: orders)
        let order = orders.place([Product(sku: "P", name: "Pen", price: Money(cents: 150))], tier: .gold)
        _ = try orders.checkout(order)
        #expect(gateway.charged == [order.id.uuidString])
    }
}
