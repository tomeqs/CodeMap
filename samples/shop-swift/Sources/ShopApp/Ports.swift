import Foundation
import ShopDomain

public protocol OrderRepository: AnyObject {
    func save(_ order: Order)
    func find(id: UUID) -> Order?
}

public protocol PaymentGateway: AnyObject {
    func charge(_ amount: Money, reference: String) throws -> String
}
