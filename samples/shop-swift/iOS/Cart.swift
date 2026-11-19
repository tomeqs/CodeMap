import SwiftUI
import ShopDomain

final class Cart: ObservableObject {
    @Published private(set) var order = Order()

    func add(_ product: Product) {
        order.add(product)
        objectWillChange.send()
    }
}
