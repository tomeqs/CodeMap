import SwiftUI

final class Cart: ObservableObject {
    @Published var count = 0
}

struct CartView: View {
    @State private var shown = false
    @State private var never = 0
    @EnvironmentObject var cart: Cart

    var body: some View {
        Toggle("Shown", isOn: $shown)
    }
}

@main
struct ShopApp: App {
    var body: some Scene { WindowGroup { CartView() } }
}

#Preview {
    CartView()
}
