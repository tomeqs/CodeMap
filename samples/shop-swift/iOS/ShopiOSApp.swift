import SwiftUI
import ShopDomain

@main
struct ShopiOSApp: App {
    @StateObject private var cart = Cart()

    var body: some Scene {
        WindowGroup {
            CartView().environmentObject(cart)
        }
    }
}
