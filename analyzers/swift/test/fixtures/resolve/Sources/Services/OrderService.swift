import Domain

public final class OrderService: BaseService {
    private let gateway: PaymentGateway
    @Clamped var retries: Int = 3
    var last: Order?

    public init(gateway: PaymentGateway) {
        self.gateway = gateway
        super.init()
    }

    public override func log(_ message: String) { super.log(message.slug()) }

    public func place(_ order: Order) async throws -> Receipt {
        let checked = try order.validated()
        var sum = 0
        for line in checked.lines {
            sum += line.total()
        }

        if let first = order.line(at: 0) {
            sum += first.price
        }

        guard let stripe = gateway as? StripeGateway else { throw OrderError.declined(reason: "no") }
        _ = #selector(StripeGateway.refresh)
        last = Order.make(lines: [])
        let receipt = try gateway.charge(sum)
        log(format(receipt.amount))
        _ = stripe
        return receipt
    }

    func retry() {
        do {
            _ = try gateway.charge(1)
        } catch OrderError.invalid {
            log("invalid")
        } catch {
            log(format("failed"))
        }

        let empty: Order = .init()
        _ = last?.note?.slug()
        _ = Order.empty.lines.first?.total()
        _ = empty
    }

    func format(_ value: Int) -> String { "\(value)" }
    func format(_ value: String) -> String { value }
    func sorted<T: Priced>(_ items: [T]) -> [T] { items }
}

extension OrderService {
    func quick() throws -> Receipt {
        let order = Order.make(lines: [.init(price: 1)])
        _ = try place(order: order, via: .standard)
        return try gateway.charge(Order.empty.lines.count)
    }

    func place(order: Order, via channel: Channel) throws -> Bool { channel == .express }
}

public enum Channel { case standard, express }
