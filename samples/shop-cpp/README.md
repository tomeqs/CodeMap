# shop-cpp: przykład dla CodeMap w C i C++

Ten sam sklep co [`samples/Shop`](../Shop), [`samples/shop-ts`](../shop-ts) i [`samples/shop-py`](../shop-py), tylko w C++:
projekt CMake z biblioteką domenową, warstwą aplikacji, infrastrukturą, dwoma programami i testami, obok stara biblioteka
w C (z Makefile) i moduł Unreal Engine. Służy do pokazania i testowania mapy C/C++, nie do budowania (nie ma Qt, GoogleTest
ani silnika; CodeMap ich nie potrzebuje).

```
libs/domain    shop_domain   pieniądze, katalog, zamówienia, rabaty (namespace shop::domain)
libs/app       shop_app      porty (interfejsy repozytorium i bramki płatności), OrderService, PaymentService
libs/infra     shop_infra    repozytorium w pamięci, udawana bramka płatności
apps/cli       shop_cli      main: składa wszystko i płaci za zamówienie
apps/qt        shop_qt       okno koszyka w Qt: sygnał, slot, connect, Q_PROPERTY
tests          shop_tests    GoogleTest (TEST_F z fiksturą, TEST) i Catch2 (TEST_CASE)
legacy         legacy        C: struktura z typedef i tablica callbacków
unreal         ShopKiosk     moduł Unreal Engine: aktor z UPROPERTY i UFUNCTION(BlueprintCallable)
```

```bash
codemap samples/shop-cpp            # sam C/C++: 8 projektów
codemap samples                     # razem z C#, TypeScriptem i Pythonem: jedna mapa
codemap samples/shop-cpp --checks
```

Co ma być widać na mapie (i co sprawdzają testy `SampleTests` oraz smoke testy viewera):

| Przypadek | Gdzie | Co pokazuje mapa |
|---|---|---|
| Zależności między targetami CMake | `target_link_libraries(shop_app PUBLIC shop_domain)`… | `projectReference` `shop_cli` → `shop_infra` → `shop_app` → `shop_domain`; `Qt6::Widgets`, `GTest::gtest_main`, `Catch2::Catch2` jako biblioteki |
| Klasa w nagłówku, definicje w `.cpp` | `order.h` + `order.cpp` | jeden węzeł `Order` z dodatkowym położeniem w `order.cpp`; każda metoda ma położenie definicji i deklaracji |
| Pomocnik pliku | `roundCents` w anonimowym namespace w `order.cpp` | prywatna statyczna składowa `Order`, nie osobny moduł (i nie cykl z `Order`) |
| Przeciążenie po liczbie argumentów | `addLine(product)` i `addLine(product, quantity)` | dwa węzły; `addLine(product)` woła `addLine(product, 1)` |
| Funkcje wolne | `discountFor` w `discounts.h` + `discounts.cpp` | moduł `discounts` w namespace `shop::domain` |
| Interfejs i implementacja | `PaymentGateway` (same czyste wirtualne), `FakePaymentGateway` | `implements`; widok Flow z `main` dochodzi przez `OrderService::pay` i `PaymentService::charge` do `FakePaymentGateway::charge` |
| Cykl | `OrderService` ↔ `PaymentService` (płatność przez usługę płatności, zwrot szuka zamówienia przez usługę zamówień) | cykl na poziomie typów |
| Martwy kod | `Order::legacyTotal` | jedyny kandydat „possibly unused” |
| Qt | `CartWindow : QMainWindow`, `signals: itemsChanged`, `private slots: refresh`, `connect(…)`, `emit` | `component`; `refresh` jako `handler`; konstruktor subskrybuje `itemsChanged`; `add` woła sygnał; `Q_PROPERTY items` |
| Testy | `TEST_F(OrderTest, …)`, `TEST(Order, …)`, `TEST_CASE("…")` | funkcje z tagiem `test`, `shop_tests` jako projekt testów; test z fiksturą korzysta z jej pól |
| C | `typedef struct ledger {…} ledger_t;`, `static` funkcje w tablicy `postings[]` | struktura `ledger`, alias `ledger_t`, funkcje użyte przez tablicę (nie martwe) |
| Unreal Engine | `ShopKiosk.Build.cs`, `UCLASS`, `UPROPERTY`, `UFUNCTION(BlueprintCallable)` | moduł jako projekt (pliki `.Build.cs` nie są projektem C#), `Sell` jako punkt wejścia, atrybuty na węzłach |
| Kontrola w funkcji | `case Tier::Gold:` bez `break` w `discountFor` | z `--checks`: `code.implicit-fallthrough` |
