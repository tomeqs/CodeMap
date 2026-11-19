public protocol OrderRepository: AnyObject {
    associatedtype Failure: Error
    var name: String { get }
    func save(_ order: Order) async throws
    func find(id: Order.ID) -> Order?
}

private final class Cache {
    var orders: [Order.ID: Order] = [:]
}
