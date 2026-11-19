# shop-swift: przykład dla CodeMap w Swifcie

Ten sam sklep co [`samples/Shop`](../Shop), [`samples/shop-ts`](../shop-ts), [`samples/shop-py`](../shop-py) i
[`samples/shop-cpp`](../shop-cpp), tylko w Swifcie: pakiet Swift Package Manager z domeną, warstwą aplikacji,
infrastrukturą, programem wiersza poleceń, serwerem Vapor i testami, a obok aplikacja iOS w projekcie Xcode (SwiftUI i
jeden kontroler UIKit), która korzysta z produktu pakietu. Służy do pokazania i testowania mapy Swifta, nie do budowania
(CodeMap nie potrzebuje Xcode, Swifta ani Vapora).

```
Sources/ShopDomain   ShopDomain   pieniądze, produkty, zamówienia (z rozszerzeniem w drugim pliku), rabaty
Sources/ShopApp      ShopApp      porty (protokoły repozytorium i bramki płatności), OrderService, PaymentService
Sources/ShopInfra    ShopInfra    repozytorium w pamięci, udawana bramka płatności
Sources/shop-cli     shop-cli     @main: składa wszystko i płaci za zamówienie
Sources/ShopServer   ShopServer   Vapor: trasy, RouteCollection pod grupą "api"
Tests/ShopTests      ShopTests    XCTest i Swift Testing (@Suite, @Test)
iOS                  ShopiOS      aplikacja z ShopiOS.xcodeproj: App SwiftUI, widok z @EnvironmentObject, #Preview, kontroler UIKit
```

```bash
codemap samples/shop-swift                       # sam Swift: 7 targetów
codemap samples/shop-swift/ShopiOS.xcodeproj     # sam projekt Xcode: target ShopiOS
codemap samples                                  # razem z C#, TypeScriptem, Pythonem i C++: jedna mapa
codemap samples/shop-swift --checks
```

Co ma być widać na mapie (i co sprawdzają testy `SampleTests` oraz smoke testy viewera):

| Przypadek | Gdzie | Co pokazuje mapa |
|---|---|---|
| Zależności między targetami | `dependencies:` w `Package.swift`, produkt `ShopKit` w projekcie Xcode | `projectReference` `shop-cli` → `ShopInfra` → `ShopApp` → `ShopDomain`; `ShopiOS` → trzy targety produktu `ShopKit`; `vapor` jako paczka |
| Pakiet i projekt Xcode w jednym folderze | `Package.swift` i `ShopiOS.xcodeproj` | pliki pakietu w jego targetach, `iOS/` w targecie `ShopiOS` |
| Rozszerzenie typu w drugim pliku | `Order+Totals.swift` | jeden węzeł `Order` z dodatkowym położeniem; `total` i `itemCount` jako jego właściwości |
| Przeciążenie po etykietach | `add(_:)` i `add(_:quantity:)` | dwa węzły; `add(_:)` woła `add(_:quantity:)` |
| Funkcje wolne | `discount(for:on:)` w `Discounts.swift` | moduł pliku `Discounts` z funkcją, którą woła `OrderService.place(_:tier:)` |
| Protokół i implementacja | `PaymentGateway`, `FakePaymentGateway` | `implements`; widok Flow z `ShopCLI.main()` dochodzi przez `OrderService.checkout(_:)` i `PaymentService.charge(_:)` do `FakePaymentGateway.charge(_:reference:)` |
| Cykl | `OrderService` ↔ `PaymentService` (płatność przez usługę płatności, zwrot szuka zamówienia przez usługę zamówień) | cykl na poziomie typów |
| Martwy kod | `Order.legacyTotal()` | jedyny kandydat „possibly unused” |
| Vapor | `app.get("health") { … }`, `routes.grouped("orders")` w kolekcji zarejestrowanej pod `api` | trasy `GET /health`, `GET /api/orders/:id`, `POST /api/orders/:id/checkout` jako punkty wejścia |
| SwiftUI i UIKit | `ShopiOSApp: App`, `CartView` z `@EnvironmentObject var cart: Cart`, `#Preview`, `@IBAction` | `ShopiOSApp` jako punkt wejścia, `CartView` jako `component` z `injects` → `Cart`, `#Preview` używa widoku, `payTapped(_:)` jako `handler` |
| Testy | `OrderTests: XCTestCase`, `@Suite struct PaymentSuite` | metody z tagiem `test`, `ShopTests` jako projekt testów |
| Kontrola w funkcji | `try!` w `ShopCLI.main()` | z `--checks`: `code.force-try` |
