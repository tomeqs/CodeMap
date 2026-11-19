import Vapor
import ShopApp
import ShopDomain
import ShopInfra

func routes(_ app: Application, orders: OrderService) throws {
    app.get("health") { _ in "ok" }
    let api = app.grouped("api")
    try api.register(collection: OrdersController(orders: orders))
}

struct OrdersController: RouteCollection {
    let orders: OrderService

    func boot(routes: RoutesBuilder) throws {
        let group = routes.grouped("orders")
        group.get(":id", use: show)
        group.post(":id", "checkout", use: checkout)
    }

    func show(req: Request) async throws -> String {
        guard let id = req.parameters.get("id", as: UUID.self), let order = orders.order(id: id) else { throw Abort(.notFound) }
        return "\(order.itemCount) items, \(order.total.cents) cents"
    }

    func checkout(req: Request) async throws -> String {
        guard let id = req.parameters.get("id", as: UUID.self), let order = orders.order(id: id) else { throw Abort(.notFound) }
        return try orders.checkout(order)
    }
}

@main
struct ShopServer {
    static func main() async throws {
        let app = try await Application.make()
        let orders = OrderService(repository: InMemoryOrderRepository())
        orders.payments = PaymentService(gateway: FakePaymentGateway(), orders: orders)
        try routes(app, orders: orders)
        try await app.execute()
    }
}
