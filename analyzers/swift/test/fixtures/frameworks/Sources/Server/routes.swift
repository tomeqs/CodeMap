import Vapor

func routes(_ app: Application) throws {
    app.get("health") { req in "ok" }
    let api = app.grouped("api")
    try api.register(collection: OrdersController())
    api.group("v1") { v1 in
        v1.get("orders", ":id", use: show)
    }
}

func show(req: Request) async throws -> String { "" }
