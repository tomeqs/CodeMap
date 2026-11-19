import Domain
import Logging

let defaultCurrency = "EUR"

func formatPrice(_ value: Double) -> String { String(format: "%.2f", value) }
func formatPrice(_ value: Int) -> String { "\(value)" }

@MainActor
open class Checkout {
    private let repository: any OrderRepository
    weak var delegate: CheckoutDelegate?

    public init(repository: any OrderRepository) { self.repository = repository }

    open func pay(_ order: Order) async throws -> Bool {
        guard !order.lines.isEmpty else { return false }
        switch order.status {
        case .new: return true
        case .paid, .shipped: return false
        }
    }

    private func log() {}
    deinit {}
}

protocol CheckoutDelegate: AnyObject {
    func checkoutDidFinish(_ checkout: Checkout)
}

#if os(iOS)
final class TouchCheckout: Checkout {}
#else
final class TouchCheckout: Checkout {}
#endif
