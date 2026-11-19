import SwiftUI
import ShopDomain

struct CartView: View {
    @EnvironmentObject var cart: Cart
    @State private var showsTotal = false

    var body: some View {
        VStack {
            Text("\(cart.order.itemCount) items")
            Toggle("Total", isOn: $showsTotal)
            if showsTotal { Text("\(cart.order.total.cents) cents") }
            Button("Add a pen") { cart.add(Product(sku: "P", name: "Pen", price: Money(cents: 150))) }
        }
    }
}

#Preview {
    CartView().environmentObject(Cart())
}
