import Vapor
import Fluent

struct OrdersController: RouteCollection {
    func boot(routes: RoutesBuilder) throws {
        let orders = routes.grouped("orders")
        orders.get(use: index)
        orders.post(use: create)
        orders.on(.DELETE, ":id", use: delete)
    }

    func index(req: Request) async throws -> [Order] { [] }
    func create(req: Request) async throws -> Order { Order() }
    func delete(req: Request) async throws -> HTTPStatus { .ok }
}

struct AuthMiddleware: AsyncMiddleware {
    func respond(to request: Request, chainingTo next: AsyncResponder) async throws -> Response { try await next.respond(to: request) }
}

final class Order: Model, Content {
    static let schema = "orders"
    @ID(key: .id) var id: UUID?
    init() {}
}
