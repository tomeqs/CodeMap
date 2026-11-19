import ShopApp
import ShopDomain
import ShopInfra

@main
struct ShopCLI {
    static func main() {
        let orders = OrderService(repository: InMemoryOrderRepository())
        orders.payments = PaymentService(gateway: FakePaymentGateway(), orders: orders)
        let book = Product(sku: "B-1", name: "A book", price: Money(cents: 1_999))
        let order = orders.place([book, book], tier: .silver)
        let receipt = try! orders.checkout(order)
        print(receipt, order.total.cents, order.itemCount)
    }
}
